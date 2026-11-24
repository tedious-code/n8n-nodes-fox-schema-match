import {
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
} from 'n8n-workflow';
import {
	loadTableSchemas,
	openManagedHandle,
	toResolvedConnection,
} from './dbConnection';
import {
	executeRawQuerySource,
	parseCsvString,
	parseJsonPayload,
	parseTextPayload,
} from './dataSources';
import {
	buildTargetTableMeta,
	findTableSchemaInCatalog,
	matchSourceRow,
	resolveEffectiveMatchKeys,
} from './schemaMatcher';
import { assertIdent, stripTableSchema } from './sqlHelpers';
import { executeWritePlan } from './writeEngine';
import type {
	BindingParam,
	DataSourceType,
	ErrorHandlerMode,
	ExecutionSummary,
	InlineConnectionConfig,
	JsonInputMode,
	ManualColumnMapping,
	MappedRowResult,
	MappingMode,
	MatchRule,
	OutputMode,
	ParsedSourceRow,
	RawQueryConnectionMode,
	RowFailureRecord,
	TargetTableMeta,
	TextInputMode,
	TextParseFormat,
	UnmatchedSourceBehavior,
	WriteOperation,
} from './types';

function readLocatorTable(raw: unknown): string {
	const value =
		typeof raw === 'object' && raw && 'value' in (raw as any)
			? String((raw as any).value ?? '').trim()
			: String(raw ?? '').trim();
	if (!value) {
		throw new Error('Target table is required');
	}
	const parts = value.split('.').map((p) => p.trim()).filter(Boolean);
	if (parts.length === 1) return assertIdent(parts[0], 'table');
	if (parts.length === 2) {
		return `${assertIdent(parts[0], 'schema')}.${assertIdent(parts[1], 'table')}`;
	}
	throw new Error(`Invalid table name "${value}". Expected "table" or "schema.table".`);
}

function parseCommaList(raw: unknown): string[] {
	if (Array.isArray(raw)) {
		return raw.map((v) => String(v ?? '').trim()).filter(Boolean);
	}
	const s = String(raw ?? '').trim();
	if (!s) return [];
	return s
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
}

async function readBinaryUtf8(
	ctx: IExecuteFunctions,
	itemIndex: number,
	binaryPropertyName: string,
): Promise<string> {
	const prop = binaryPropertyName.trim() || 'data';
	const buf = await ctx.helpers.getBinaryDataBuffer(itemIndex, prop);
	return buf.toString('utf8');
}

export async function runFoxSchemaMatch(
	ctx: IExecuteFunctions,
): Promise<INodeExecutionData[][]> {
	const items = ctx.getInputData();
	const node = ctx.getNode();

	const errorHandlerMode = ctx.getNodeParameter(
		'errorHandlerMode',
		0,
		'routeToErrorOutput',
	) as ErrorHandlerMode;
	const hasErrorBranch =
		errorHandlerMode === 'routeToErrorOutput' ||
		errorHandlerMode === 'rollbackAndRouteToError';

	const targetCredentials = await ctx.getCredentials('foxSchemaMatchDbApi');
	const operation = ctx.getNodeParameter('operation', 0, 'upsert') as WriteOperation;
	const dataSource = ctx.getNodeParameter('dataSource', 0, 'json') as DataSourceType;
	const outputMode = ctx.getNodeParameter(
		'outputMode',
		0,
		'summaryWithRows',
	) as OutputMode;
	const dryRun = ctx.getNodeParameter('dryRun', 0, false) as boolean;

	const options = (ctx.getNodeParameter('options', 0, {}) ?? {}) as Record<string, any>;
	const errorOpts = (ctx.getNodeParameter('errorHandlerOptions', 0, {}) ?? {}) as Record<
		string,
		any
	>;

	const timeoutMs = Number(options.timeoutMs ?? 15000);
	const batchSize = Math.max(1, Number(options.batchSize ?? 100));
	const allowUnsafeSql = options.allowUnsafeSql === true;
	const skipSchemaLookup = options.skipSchemaLookup === true;

	let table: string;
	try {
		table = readLocatorTable(ctx.getNodeParameter('tableId', 0));
	} catch (err: any) {
		throw new NodeOperationError(node, err?.message || String(err));
	}

	const resolvedTarget = toResolvedConnection(
		targetCredentials as Record<string, any>,
		timeoutMs,
		'target',
		node,
	);

	// Load FoxSchema table metadata unless skipped
	let tableMeta: TargetTableMeta | undefined;
	if (!skipSchemaLookup) {
		try {
			const catalog = await loadTableSchemas(targetCredentials);
			const found = findTableSchemaInCatalog(catalog, table);
			if (!found) {
				throw new Error(
					`Table "${table}" was not found in schema "${resolvedTarget.options.schema || 'default'}"`,
				);
			}
			tableMeta = buildTargetTableMeta(found, String(resolvedTarget.options.schema ?? ''));
		} catch (err: any) {
			throw new NodeOperationError(
				node,
				`FoxSchema target table inspection failed: ${err?.message || String(err)}`,
			);
		}
	}

	// Collect source rows + parse-stage errors across all input items
	const parsedRows: ParsedSourceRow[] = [];
	const allFailures: RowFailureRecord[] = [];
	let rowCursor = 0;

	const jsonInputMode =
		dataSource === 'json'
			? (ctx.getNodeParameter('jsonInputMode', 0, 'incomingItems') as JsonInputMode)
			: undefined;

	for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
		try {
			if (dataSource === 'json') {
				const jsonRootPath = ctx.getNodeParameter(
					'jsonRootPath',
					itemIndex,
					'',
				) as string;

				if (jsonInputMode === 'incomingItems') {
					const res = parseJsonPayload(items[itemIndex].json, {
						jsonRootPath,
						itemIndex,
						startingRowIndex: rowCursor,
					});
					rowCursor += res.rows.length + res.errors.length;
					parsedRows.push(...res.rows);
					for (const err of res.errors) {
						allFailures.push({
							...err,
							error: err.message,
							operation,
							table,
							dialect: resolvedTarget.dialect,
							sourceRow: err.rawInput,
						});
					}
				} else if (jsonInputMode === 'jsonString') {
					const jsonPayload = ctx.getNodeParameter(
						'jsonPayload',
						itemIndex,
						'',
					) as unknown;
					const res = parseJsonPayload(jsonPayload, {
						jsonRootPath,
						itemIndex,
						startingRowIndex: rowCursor,
					});
					rowCursor += res.rows.length + res.errors.length;
					parsedRows.push(...res.rows);
					for (const err of res.errors) {
						allFailures.push({
							...err,
							error: err.message,
							operation,
							table,
							dialect: resolvedTarget.dialect,
							sourceRow: err.rawInput,
						});
					}
				} else {
					const binProp = ctx.getNodeParameter(
						'binaryPropertyName',
						itemIndex,
						'data',
					) as string;
					const content = await readBinaryUtf8(ctx, itemIndex, binProp);
					const res = parseJsonPayload(content, {
						jsonRootPath,
						itemIndex,
						startingRowIndex: rowCursor,
					});
					rowCursor += res.rows.length + res.errors.length;
					parsedRows.push(...res.rows);
					for (const err of res.errors) {
						allFailures.push({
							...err,
							error: err.message,
							operation,
							table,
							dialect: resolvedTarget.dialect,
							sourceRow: err.rawInput,
						});
					}
				}
			} else if (dataSource === 'csv') {
				const csvInputMode = ctx.getNodeParameter(
					'csvInputMode',
					itemIndex,
					'textContent',
				) as TextInputMode;
				const csvText =
					csvInputMode === 'binary'
						? await readBinaryUtf8(
								ctx,
								itemIndex,
								ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string,
							)
						: (ctx.getNodeParameter('csvText', itemIndex, '') as string);

				const csvDelimOpt = ctx.getNodeParameter('csvDelimiter', itemIndex, ',') as string;
				const delimiter =
					csvDelimOpt === 'custom'
						? (ctx.getNodeParameter('csvCustomDelimiter', itemIndex, ',') as string)
						: csvDelimOpt;
				const hasHeader = ctx.getNodeParameter('hasHeader', itemIndex, true) as boolean;
				const customHeaders = hasHeader
					? ''
					: (ctx.getNodeParameter('customHeaders', itemIndex, '') as string);

				const res = parseCsvString(csvText, {
					delimiter,
					hasHeader,
					customHeaders,
					trimValues: options.trimValues !== false,
					skipEmptyLines: options.skipEmptyLines !== false,
					commentPrefix: options.commentPrefix ? String(options.commentPrefix) : undefined,
					itemIndex,
					startingRowIndex: rowCursor,
				});
				rowCursor += res.rows.length + res.errors.length;
				parsedRows.push(...res.rows);
				for (const err of res.errors) {
					allFailures.push({
						...err,
						error: err.message,
						operation,
						table,
						dialect: resolvedTarget.dialect,
						sourceRow: err.rawInput,
					});
				}
			} else if (dataSource === 'text') {
				const textInputMode = ctx.getNodeParameter(
					'textInputMode',
					itemIndex,
					'textContent',
				) as TextInputMode;
				const textFormat = ctx.getNodeParameter(
					'textFormat',
					itemIndex,
					'pipe',
				) as TextParseFormat;
				const textContent =
					textInputMode === 'binary'
						? await readBinaryUtf8(
								ctx,
								itemIndex,
								ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data') as string,
							)
						: (ctx.getNodeParameter('textContent', itemIndex, '') as string);

				const hasHeader = ctx.getNodeParameter('hasHeader', itemIndex, true) as boolean;
				const customHeaders = ctx.getNodeParameter(
					'customHeaders',
					itemIndex,
					'',
				) as string;
				const customDelimiter = ctx.getNodeParameter(
					'textCustomDelimiter',
					itemIndex,
					'|',
				) as string;
				const kvPairDelimiter = ctx.getNodeParameter(
					'kvPairDelimiter',
					itemIndex,
					'\\s+',
				) as string;
				const kvSeparator = ctx.getNodeParameter('kvSeparator', itemIndex, '=') as string;
				const regexPattern = ctx.getNodeParameter(
					'regexPattern',
					itemIndex,
					'',
				) as string;
				const fixedWidthSpec = ctx.getNodeParameter(
					'fixedWidthSpec',
					itemIndex,
					'',
				) as string;

				const res = parseTextPayload(textContent, {
					textFormat,
					customDelimiter,
					hasHeader,
					customHeaders,
					trimValues: options.trimValues !== false,
					skipEmptyLines: options.skipEmptyLines !== false,
					commentPrefix: options.commentPrefix ? String(options.commentPrefix) : undefined,
					kvPairDelimiter,
					kvSeparator,
					regexPattern,
					fixedWidthSpec,
					failOnUnmatchedLine: errorOpts.failOnUnmatchedLine !== false,
					itemIndex,
					startingRowIndex: rowCursor,
				});
				rowCursor += res.rows.length + res.errors.length;
				parsedRows.push(...res.rows);
				for (const err of res.errors) {
					allFailures.push({
						...err,
						error: err.message,
						operation,
						table,
						dialect: resolvedTarget.dialect,
						sourceRow: err.rawInput,
					});
				}
			} else if (dataSource === 'rawQuery') {
				const connMode = ctx.getNodeParameter(
					'rawQueryConnectionMode',
					itemIndex,
					'sameAsTarget',
				) as RawQueryConnectionMode;
				const rawSql = ctx.getNodeParameter('rawSql', itemIndex, '') as string;
				const bindings = ctx.getNodeParameter(
					'rawQueryBindings.parameterValues',
					itemIndex,
					[],
				) as BindingParam[];
				const dataPath = ctx.getNodeParameter(
					'rawQueryDataPath',
					itemIndex,
					'',
				) as string;
				const rawQueryTimeout = Number(
					ctx.getNodeParameter('rawQueryTimeoutMs', itemIndex, timeoutMs),
				);

				let sourceCred: Record<string, any> | undefined;
				let inlineConn: InlineConnectionConfig | undefined;

				if (connMode === 'inline') {
					inlineConn = {
						dialect: ctx.getNodeParameter('sourceInlineDialect', itemIndex, 'postgres') as string,
						connectionString: ctx.getNodeParameter(
							'sourceInlineConnectionString',
							itemIndex,
							'',
						) as string,
						host: ctx.getNodeParameter('sourceInlineHost', itemIndex, 'localhost') as string,
						port: ctx.getNodeParameter('sourceInlinePort', itemIndex, 5432) as number,
						database: ctx.getNodeParameter('sourceInlineDatabase', itemIndex, '') as string,
						username: ctx.getNodeParameter('sourceInlineUsername', itemIndex, '') as string,
						password: ctx.getNodeParameter('sourceInlinePassword', itemIndex, '') as string,
						schema: ctx.getNodeParameter('sourceInlineSchema', itemIndex, '') as string,
						useSsl: ctx.getNodeParameter('sourceInlineUseSsl', itemIndex, false) as boolean,
						rejectUnauthorized: ctx.getNodeParameter(
							'sourceInlineRejectUnauthorized',
							itemIndex,
							true,
						) as boolean,
					};
				}

				const res = await executeRawQuerySource({
					ctx,
					node,
					targetCredentials: targetCredentials as Record<string, any>,
					sourceCredential: sourceCred,
					connectionMode: connMode,
					inlineConnection: inlineConn,
					sql: rawSql,
					bindings,
					allowUnsafeSql,
					dataPath,
					timeoutMs: rawQueryTimeout,
					itemIndex,
					startingRowIndex: rowCursor,
				});
				rowCursor += res.rows.length + res.errors.length;
				parsedRows.push(...res.rows);
				for (const err of res.errors) {
					allFailures.push({
						...err,
						error: err.message,
						operation,
						table,
						dialect: resolvedTarget.dialect,
						sourceRow: err.rawInput,
					});
				}
			}
		} catch (itemErr: any) {
			const msg = itemErr?.message || String(itemErr);
			if (errorHandlerMode === 'throwError' && !ctx.continueOnFail()) {
				throw itemErr instanceof NodeOperationError
					? itemErr
					: new NodeOperationError(node, msg, { itemIndex });
			}
			allFailures.push({
				rowIndex: rowCursor++,
				itemIndex,
				stage: 'source_parse',
				errorCode: 'PARSE_ERROR',
				error: msg,
				operation,
				table,
				dialect: resolvedTarget.dialect,
				sourceRow: items[itemIndex].json,
			});
		}
	}

	if (errorHandlerMode === 'throwError' && allFailures.length > 0 && !ctx.continueOnFail()) {
		throw new NodeOperationError(node, allFailures[0].error, {
			itemIndex: allFailures[0].itemIndex,
		});
	}

	// Schema matching configuration
	const mappingMode = ctx.getNodeParameter('mappingMode', 0, 'auto') as MappingMode;
	const matchRule = ctx.getNodeParameter(
		'matchRule',
		0,
		'caseInsensitive',
	) as MatchRule;
	const unmatchedSourceBehavior = ctx.getNodeParameter(
		'unmatchedSourceBehavior',
		0,
		'ignore',
	) as UnmatchedSourceBehavior;
	const manualMappings = ctx.getNodeParameter(
		'manualMappings.mappingValues',
		0,
		[],
	) as ManualColumnMapping[];
	const positionalColumns = parseCommaList(
		ctx.getNodeParameter('positionalColumns', 0, ''),
	);

	const selectedMatchKeys = parseCommaList(
		ctx.getNodeParameter('matchKeySelect', 0, []),
	);
	const customMatchKeys = parseCommaList(
		ctx.getNodeParameter('matchKeyColumns', 0, ''),
	);
	const effectiveMatchKeys = resolveEffectiveMatchKeys({
		configuredKeys: customMatchKeys.length > 0 ? customMatchKeys : selectedMatchKeys,
		tableMeta,
		matchRule,
	});

	// Match & coerce every parsed row
	const mappedRows: MappedRowResult[] = [];
	const matchedColumnSet = new Set<string>();

	for (const row of parsedRows) {
		const res = matchSourceRow(row, {
			operation,
			table,
			dialect: resolvedTarget.dialect,
			tableMeta,
			mappingMode,
			matchRule,
			unmatchedSourceBehavior,
			manualMappings,
			positionalColumns,
			matchKeyColumns: effectiveMatchKeys,
			emptyStringAsNull: options.emptyStringAsNull !== false,
			strictTypeValidation: errorOpts.strictTypeValidation !== false,
			validateRequiredColumns: errorOpts.validateRequiredColumns !== false,
			includeIdentityOnInsert: options.includeIdentityOnInsert === true,
			skipNullValuesOnUpdate: options.skipNullValuesOnUpdate === true,
		});

		if ('ok' in res) {
			mappedRows.push(res);
			for (const col of res.matchedColumns) matchedColumnSet.add(col);
		} else {
			if (errorHandlerMode === 'throwError' && !ctx.continueOnFail()) {
				throw new NodeOperationError(node, res.error, { itemIndex: res.itemIndex });
			}
			allFailures.push(res);
		}
	}

	// If rollbackAndRouteToError had parse or match errors before DB write, abort before mutating DB!
	let writeResult = {
		outcomes: [] as ExecutionSummary['results'],
		failures: [] as RowFailureRecord[],
		insertedCount: 0,
		updatedCount: 0,
		upsertedCount: 0,
		skippedCount: 0,
	};

	const abortPreWrite =
		errorHandlerMode === 'rollbackAndRouteToError' && allFailures.length > 0;

	if (!abortPreWrite && mappedRows.length > 0) {
		const { schema: tableSchemaOverride, table: bareTableName } = stripTableSchema(table);
		const targetSchema = tableSchemaOverride ?? String(resolvedTarget.options.schema ?? '');

		const handle = await openManagedHandle(resolvedTarget, node);
		try {
			writeResult = await executeWritePlan(
				handle,
				mappedRows,
				{
					operation,
					dialect: resolvedTarget.dialect,
					schema: targetSchema,
					table: bareTableName,
					matchKeys: effectiveMatchKeys,
					batchSize,
					dryRun,
					useTransaction: options.useTransaction === true,
					ignoreDuplicates: options.ignoreDuplicates === true,
					requireMatchedRow: errorOpts.requireMatchedRow === true,
					isolateFailedBatchRows: errorOpts.isolateFailedBatchRows !== false,
					errorHandlerMode,
					retryAttempts: Number(errorOpts.retryAttempts ?? 0),
					retryDelayMs: Number(errorOpts.retryDelayMs ?? 300),
					timeoutMs,
				},
				node,
			);
		} catch (writeErr: any) {
			const msg = writeErr?.message || String(writeErr);
			if (errorHandlerMode === 'throwError' && !ctx.continueOnFail()) {
				throw writeErr instanceof NodeOperationError
					? writeErr
					: new NodeOperationError(node, msg);
			}
			for (const r of mappedRows) {
				allFailures.push({
					rowIndex: r.rowIndex,
					itemIndex: r.itemIndex,
					stage: 'db_write',
					errorCode: 'DB_ERROR',
					error: msg,
					operation,
					table,
					dialect: resolvedTarget.dialect,
					sourceRow: r.sourceRow,
					mappedRow: r.mappedRow,
				});
			}
		} finally {
			await handle.close();
		}
	}

	allFailures.push(...writeResult.failures);

	const summary: ExecutionSummary = {
		operation,
		dataSource,
		table,
		dialect: resolvedTarget.dialect,
		dryRun,
		totalInputRows: parsedRows.length + allFailures.filter((f) => f.stage === 'source_parse').length,
		succeededCount: writeResult.outcomes.length,
		failedCount: allFailures.length,
		skippedCount: writeResult.skippedCount,
		insertedCount: writeResult.insertedCount,
		updatedCount: writeResult.updatedCount,
		upsertedCount: writeResult.upsertedCount,
		matchedColumns: Array.from(matchedColumnSet),
		matchKeys: effectiveMatchKeys,
		results: writeResult.outcomes,
		errors: allFailures,
	};

	const mainOutput: INodeExecutionData[] = [];
	const errorOutput: INodeExecutionData[] = [];

	if (outputMode === 'rowByRow') {
		for (const out of writeResult.outcomes) {
			mainOutput.push({
				json: {
					success: true,
					operation,
					table,
					dialect: resolvedTarget.dialect,
					dryRun,
					rowIndex: out.rowIndex,
					status: out.status,
					data: out.returnedRow ?? out.mappedRow,
					...(out.sql ? { sql: out.sql } : {}),
				} as unknown as IDataObject,
				pairedItem: { item: out.itemIndex },
			});
		}
	} else if (outputMode === 'summaryOnly') {
		const { results: _r, errors: _e, ...countsOnly } = summary;
		mainOutput.push({
			json: {
				...countsOnly,
				errorCount: allFailures.length,
			} as unknown as IDataObject,
		});
	} else {
		// summaryWithRows
		mainOutput.push({
			json: (hasErrorBranch
				? {
						operation: summary.operation,
						dataSource: summary.dataSource,
						table: summary.table,
						dialect: summary.dialect,
						dryRun: summary.dryRun,
						totalInputRows: summary.totalInputRows,
						succeededCount: summary.succeededCount,
						failedCount: summary.failedCount,
						insertedCount: summary.insertedCount,
						updatedCount: summary.updatedCount,
						upsertedCount: summary.upsertedCount,
						matchedColumns: summary.matchedColumns,
						matchKeys: summary.matchKeys,
						results: summary.results,
					}
				: summary) as unknown as IDataObject,
		});
	}

	if (hasErrorBranch) {
		for (const fail of allFailures) {
			errorOutput.push({
				json: fail as unknown as IDataObject,
				pairedItem: { item: fail.itemIndex },
			});
		}
		return [mainOutput, errorOutput];
	}

	// Single-output mode when skipAndLog or continueOnFail is active
	if (outputMode === 'rowByRow' && allFailures.length > 0) {
		for (const fail of allFailures) {
			mainOutput.push({
				json: {
					success: false,
					...fail,
				} as unknown as IDataObject,
				pairedItem: { item: fail.itemIndex },
			});
		}
	}

	return [mainOutput];
}
