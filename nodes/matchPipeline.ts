import {
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type ResourceMapperValue,
} from 'n8n-workflow';
import {
	loadTableSchemas,
	openManagedHandle,
	toResolvedConnection,
} from './dbConnection';
import {
	buildTargetTableMeta,
	findTableSchemaInCatalog,
	matchSourceRow,
	resolveEffectiveMatchKeys,
} from './schemaMatcher';
import { assertIdent, stripTableSchema } from './sqlHelpers';
import { executeWritePlan } from './writeEngine';
import type {
	ColumnValidationRule,
	ErrorHandlerMode,
	ExecutionSummary,
	ManualColumnMapping,
	MappedRowResult,
	MappingMode,
	MatchRule,
	OutputMode,
	ParsedSourceRow,
	RowFailureRecord,
	TargetTableMeta,
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

	const mappingMode = ctx.getNodeParameter(
		'mappingMode',
		0,
		'resourceMapper',
	) as MappingMode;
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
	const columnRules = ctx.getNodeParameter(
		'columnRules.ruleValues',
		0,
		[],
	) as ColumnValidationRule[];

	const resourceMapperParam =
		mappingMode === 'resourceMapper'
			? (ctx.getNodeParameter('columns', 0, {}) as Partial<ResourceMapperValue>)
			: undefined;

	const selectedMatchKeys = parseCommaList(
		ctx.getNodeParameter('matchKeySelect', 0, []),
	);
	const customMatchKeys = parseCommaList(
		ctx.getNodeParameter('matchKeyColumns', 0, ''),
	);
	const resourceMatchKeys = Array.isArray(resourceMapperParam?.matchingColumns)
		? resourceMapperParam.matchingColumns.map((k) => String(k).trim()).filter(Boolean)
		: [];

	const effectiveMatchKeys = resolveEffectiveMatchKeys({
		configuredKeys:
			mappingMode === 'resourceMapper'
				? resourceMatchKeys
				: customMatchKeys.length > 0
					? customMatchKeys
					: selectedMatchKeys,
		tableMeta,
		matchRule,
	});

	// Build source rows from incoming workflow items
	const rowsForMatching: ParsedSourceRow[] = [];
	let effectiveEngineMappingMode: 'auto' | 'manual' =
		mappingMode === 'manual' ? 'manual' : 'auto';
	let effectiveIncludeIdentityOnInsert = options.includeIdentityOnInsert === true;

	if (mappingMode === 'resourceMapper') {
		const rmMode = resourceMapperParam?.mappingMode || 'defineBelow';
		if (rmMode === 'defineBelow') {
			effectiveEngineMappingMode = 'auto';
			effectiveIncludeIdentityOnInsert = true;
			for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
				const itemMapper = ctx.getNodeParameter(
					'columns',
					itemIndex,
					{},
				) as Partial<ResourceMapperValue>;
				const definedObj = (itemMapper?.value ?? {}) as Record<string, unknown>;
				rowsForMatching.push({
					rowIndex: itemIndex,
					itemIndex,
					data: definedObj,
				});
			}
		} else {
			for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
				rowsForMatching.push({
					rowIndex: itemIndex,
					itemIndex,
					data: (items[itemIndex].json ?? {}) as Record<string, unknown>,
				});
			}
		}
	} else {
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			rowsForMatching.push({
				rowIndex: itemIndex,
				itemIndex,
				data: (items[itemIndex].json ?? {}) as Record<string, unknown>,
			});
		}
	}

	const allFailures: RowFailureRecord[] = [];
	const mappedRows: MappedRowResult[] = [];
	const matchedColumnSet = new Set<string>();

	for (const row of rowsForMatching) {
		const res = matchSourceRow(row, {
			operation,
			table,
			dialect: resolvedTarget.dialect,
			tableMeta,
			mappingMode: effectiveEngineMappingMode,
			matchRule,
			unmatchedSourceBehavior,
			manualMappings,
			columnRules,
			matchKeyColumns: effectiveMatchKeys,
			emptyStringAsNull: options.emptyStringAsNull !== false,
			strictTypeValidation: errorOpts.strictTypeValidation !== false,
			validateRequiredColumns: errorOpts.validateRequiredColumns !== false,
			includeIdentityOnInsert: effectiveIncludeIdentityOnInsert,
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
				throw new NodeOperationError(node, msg);
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
		table,
		dialect: resolvedTarget.dialect,
		dryRun,
		totalInputRows: rowsForMatching.length,
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
		mainOutput.push({
			json: (hasErrorBranch
				? {
						operation: summary.operation,
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
