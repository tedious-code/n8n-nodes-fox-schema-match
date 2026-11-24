import { NodeOperationError, sleep, type INode } from 'n8n-workflow';
import type { ManagedDbHandle } from './dbConnection';
import { maxInsertRows } from './foxSchema';
import { qualifyTable, quoteIdent } from './sqlHelpers';
import {
	isMysqlFamily,
	isPostgresFamily,
	isSqlServerFamily,
	supportsInsertReturning,
	type SupportedDialect,
} from './supportedDialects';
import type {
	CompiledStatement,
	ErrorHandlerMode,
	MappedRowResult,
	RowFailureRecord,
	WriteOperation,
	WriteRowOutcome,
} from './types';

export interface WriteExecutionOptions {
	operation: WriteOperation;
	dialect: SupportedDialect;
	schema: string;
	table: string;
	matchKeys: string[];
	batchSize: number;
	dryRun: boolean;
	useTransaction: boolean;
	ignoreDuplicates: boolean;
	requireMatchedRow: boolean;
	isolateFailedBatchRows: boolean;
	errorHandlerMode: ErrorHandlerMode;
	retryAttempts: number;
	retryDelayMs: number;
	timeoutMs: number;
}

export interface WriteEngineResult {
	outcomes: WriteRowOutcome[];
	failures: RowFailureRecord[];
	insertedCount: number;
	updatedCount: number;
	upsertedCount: number;
	skippedCount: number;
}

function collectOrderedColumns(rows: MappedRowResult[]): string[] {
	const cols: string[] = [];
	const seen = new Set<string>();
	for (const r of rows) {
		for (const c of r.matchedColumns) {
			if (!seen.has(c)) {
				seen.add(c);
				cols.push(c);
			}
		}
	}
	return cols;
}

function buildValuesPlaceholders(rowCount: number, colCount: number): string {
	const rowTuple = `(${Array.from({ length: colCount }, () => '?').join(', ')})`;
	return Array.from({ length: rowCount }, () => rowTuple).join(', ');
}

export function compileInsertStatement(opts: {
	dialect: SupportedDialect;
	qualifiedTable: string;
	columns: string[];
	rows: MappedRowResult[];
	ignoreDuplicates: boolean;
	dryRun: boolean;
}): CompiledStatement {
	const { dialect, qualifiedTable, columns, rows, ignoreDuplicates, dryRun } = opts;
	const colSql = columns.map((c) => quoteIdent(c, 'column', dialect)).join(', ');
	const valuesSql = buildValuesPlaceholders(rows.length, columns.length);
	const params: unknown[] = [];

	for (const row of rows) {
		for (const col of columns) {
			params.push(row.mappedRow[col] ?? null);
		}
	}

	let sql: string;
	if (ignoreDuplicates) {
		if (isMysqlFamily(dialect)) {
			sql = `INSERT IGNORE INTO ${qualifiedTable} (${colSql}) VALUES ${valuesSql}`;
		} else if (
			isPostgresFamily(dialect) ||
			dialect === 'sqlite' ||
			dialect === 'duckdb'
		) {
			sql = `INSERT INTO ${qualifiedTable} (${colSql}) VALUES ${valuesSql} ON CONFLICT DO NOTHING`;
		} else {
			sql = `INSERT INTO ${qualifiedTable} (${colSql}) VALUES ${valuesSql}`;
		}
	} else {
		sql = `INSERT INTO ${qualifiedTable} (${colSql}) VALUES ${valuesSql}`;
	}

	if (!dryRun && supportsInsertReturning(dialect)) {
		sql += ' RETURNING *';
	}

	return {
		sql,
		params,
		rowIndices: rows.map((r) => r.rowIndex),
		operation: 'insert',
	};
}

export function compileUpdateStatement(opts: {
	dialect: SupportedDialect;
	qualifiedTable: string;
	row: MappedRowResult;
	matchKeys: string[];
	dryRun: boolean;
	returning: boolean;
}): CompiledStatement {
	const { dialect, qualifiedTable, row, matchKeys, dryRun, returning } = opts;
	const keySet = new Set(matchKeys);
	const setCols = row.matchedColumns.filter((c) => !keySet.has(c));

	if (setCols.length === 0) {
		throw new Error('Update statement has no non-key columns to SET');
	}

	const setSql = setCols
		.map((c) => `${quoteIdent(c, 'column', dialect)} = ?`)
		.join(', ');
	const whereSql = matchKeys
		.map((k) => `${quoteIdent(k, 'column', dialect)} = ?`)
		.join(' AND ');

	const params: unknown[] = [
		...setCols.map((c) => row.mappedRow[c] ?? null),
		...matchKeys.map((k) => row.mappedRow[k]),
	];

	let sql = `UPDATE ${qualifiedTable} SET ${setSql} WHERE ${whereSql}`;
	if (!dryRun && returning && supportsInsertReturning(dialect)) {
		sql += ' RETURNING *';
	}

	return {
		sql,
		params,
		rowIndices: [row.rowIndex],
		operation: 'update',
	};
}

export function supportsNativeSingleStatementUpsert(dialect: SupportedDialect): boolean {
	return dialect !== 'redshift' && dialect !== 'clickhouse';
}

export function compileUpsertStatement(opts: {
	dialect: SupportedDialect;
	qualifiedTable: string;
	columns: string[];
	matchKeys: string[];
	rows: MappedRowResult[];
	dryRun: boolean;
}): CompiledStatement {
	const { dialect, qualifiedTable, columns, matchKeys, rows, dryRun } = opts;
	const keySet = new Set(matchKeys);
	const updateCols = columns.filter((c) => !keySet.has(c));
	const params: unknown[] = [];

	for (const row of rows) {
		for (const col of columns) {
			params.push(row.mappedRow[col] ?? null);
		}
	}

	const colsSql = columns.map((c) => quoteIdent(c, 'column', dialect)).join(', ');
	const keysSql = matchKeys.map((k) => quoteIdent(k, 'column', dialect)).join(', ');

	if (
		dialect === 'postgres' ||
		dialect === 'cockroachdb' ||
		dialect === 'yugabytedb' ||
		dialect === 'sqlite' ||
		dialect === 'duckdb'
	) {
		const valuesSql = buildValuesPlaceholders(rows.length, columns.length);
		const conflictAction =
			updateCols.length > 0
				? `DO UPDATE SET ${updateCols
						.map((c) => {
							const q = quoteIdent(c, 'column', dialect);
							return `${q} = EXCLUDED.${q}`;
						})
						.join(', ')}`
				: 'DO NOTHING';

		let sql = `INSERT INTO ${qualifiedTable} (${colsSql}) VALUES ${valuesSql} ON CONFLICT (${keysSql}) ${conflictAction}`;
		if (!dryRun && supportsInsertReturning(dialect)) {
			sql += ' RETURNING *';
		}
		return {
			sql,
			params,
			rowIndices: rows.map((r) => r.rowIndex),
			operation: 'upsert',
		};
	}

	if (isMysqlFamily(dialect)) {
		const valuesSql = buildValuesPlaceholders(rows.length, columns.length);
		if (updateCols.length === 0) {
			return {
				sql: `INSERT IGNORE INTO ${qualifiedTable} (${colsSql}) VALUES ${valuesSql}`,
				params,
				rowIndices: rows.map((r) => r.rowIndex),
				operation: 'upsert',
			};
		}
		const updateSql = updateCols
			.map((c) => {
				const q = quoteIdent(c, 'column', dialect);
				return `${q} = VALUES(${q})`;
			})
			.join(', ');
		return {
			sql: `INSERT INTO ${qualifiedTable} (${colsSql}) VALUES ${valuesSql} ON DUPLICATE KEY UPDATE ${updateSql}`,
			params,
			rowIndices: rows.map((r) => r.rowIndex),
			operation: 'upsert',
		};
	}

	if (isSqlServerFamily(dialect)) {
		const valuesSql = buildValuesPlaceholders(rows.length, columns.length);
		const onClause = matchKeys
			.map((k) => {
				const q = quoteIdent(k, 'column', dialect);
				return `T.${q} = S.${q}`;
			})
			.join(' AND ');
		const insertCols = columns.map((c) => `S.${quoteIdent(c, 'column', dialect)}`).join(', ');
		const matchedClause =
			updateCols.length > 0
				? `WHEN MATCHED THEN UPDATE SET ${updateCols
						.map((c) => {
							const q = quoteIdent(c, 'column', dialect);
							return `T.${q} = S.${q}`;
						})
						.join(', ')} `
				: '';

		const sql =
			`MERGE INTO ${qualifiedTable} AS T ` +
			`USING (VALUES ${valuesSql}) AS S (${colsSql}) ` +
			`ON (${onClause}) ` +
			matchedClause +
			`WHEN NOT MATCHED THEN INSERT (${colsSql}) VALUES (${insertCols});`;

		return {
			sql,
			params,
			rowIndices: rows.map((r) => r.rowIndex),
			operation: 'upsert',
		};
	}

	if (dialect === 'oracle') {
		const row = rows[0];
		const oracleParams = columns.map((c) => row.mappedRow[c] ?? null);
		const selectSource = columns
			.map((c) => `? AS ${quoteIdent(c, 'column', dialect)}`)
			.join(', ');
		const onClause = matchKeys
			.map((k) => {
				const q = quoteIdent(k, 'column', dialect);
				return `T.${q} = S.${q}`;
			})
			.join(' AND ');
		const insertVals = columns.map((c) => `S.${quoteIdent(c, 'column', dialect)}`).join(', ');
		const matchedClause =
			updateCols.length > 0
				? `WHEN MATCHED THEN UPDATE SET ${updateCols
						.map((c) => {
							const q = quoteIdent(c, 'column', dialect);
							return `T.${q} = S.${q}`;
						})
						.join(', ')} `
				: '';

		const sql =
			`MERGE INTO ${qualifiedTable} T ` +
			`USING (SELECT ${selectSource} FROM DUAL) S ` +
			`ON (${onClause}) ` +
			matchedClause +
			`WHEN NOT MATCHED THEN INSERT (${colsSql}) VALUES (${insertVals})`;

		return {
			sql,
			params: oracleParams,
			rowIndices: [row.rowIndex],
			operation: 'upsert',
		};
	}

	// Fallback preview for Redshift / ClickHouse (executed via two-step SELECT + UPDATE/INSERT)
	const valuesSql = buildValuesPlaceholders(rows.length, columns.length);
	return {
		sql: `/* two-step upsert for ${dialect} */ INSERT INTO ${qualifiedTable} (${colsSql}) VALUES ${valuesSql}`,
		params,
		rowIndices: rows.map((r) => r.rowIndex),
		operation: 'upsert',
	};
}

async function queryWithRetry(
	handle: ManagedDbHandle,
	sql: string,
	params: unknown[],
	retryAttempts: number,
	retryDelayMs: number,
): Promise<Record<string, unknown>[]> {
	let lastErr: unknown;
	const maxTries = Math.max(1, 1 + Math.max(0, retryAttempts));
	for (let attempt = 1; attempt <= maxTries; attempt++) {
		try {
			return await handle.query(sql, params);
		} catch (err) {
			lastErr = err;
			if (attempt < maxTries && retryDelayMs > 0) {
				await sleep(retryDelayMs);
			}
		}
	}
	throw lastErr;
}

function makeDbFailure(
	row: MappedRowResult,
	opts: WriteExecutionOptions,
	error: unknown,
	sql?: string,
	errorCode: RowFailureRecord['errorCode'] = 'DB_ERROR',
): RowFailureRecord {
	return {
		rowIndex: row.rowIndex,
		itemIndex: row.itemIndex,
		stage: 'db_write',
		errorCode,
		error: error instanceof Error ? error.message : String(error),
		operation: opts.operation,
		table: opts.table,
		dialect: opts.dialect,
		sourceRow: row.sourceRow,
		mappedRow: row.mappedRow,
		sql,
	};
}

async function executeSingleTwoStepUpsert(
	handle: ManagedDbHandle,
	qualifiedTable: string,
	row: MappedRowResult,
	matchKeys: string[],
	opts: WriteExecutionOptions,
): Promise<{ status: 'inserted' | 'updated'; sql: string; returnedRow?: Record<string, unknown> }> {
	const whereSql = matchKeys
		.map((k) => `${quoteIdent(k, 'column', opts.dialect)} = ?`)
		.join(' AND ');
	const keyParams = matchKeys.map((k) => row.mappedRow[k]);

	const existsSql = `SELECT 1 AS found FROM ${qualifiedTable} WHERE ${whereSql} LIMIT 1`;
	const found = await queryWithRetry(
		handle,
		existsSql,
		keyParams,
		opts.retryAttempts,
		opts.retryDelayMs,
	);

	if (found.length > 0) {
		const keySet = new Set(matchKeys);
		const setCols = row.matchedColumns.filter((c) => !keySet.has(c));
		if (setCols.length === 0) {
			return { status: 'updated', sql: existsSql };
		}
		const setSql = setCols
			.map((c) => `${quoteIdent(c, 'column', opts.dialect)} = ?`)
			.join(', ');
		const updateParams = [
			...setCols.map((c) => row.mappedRow[c] ?? null),
			...keyParams,
		];
		const updateSql =
			opts.dialect === 'clickhouse'
				? `ALTER TABLE ${qualifiedTable} UPDATE ${setSql} WHERE ${whereSql} SETTINGS mutations_sync = 1`
				: `UPDATE ${qualifiedTable} SET ${setSql} WHERE ${whereSql}`;

		await queryWithRetry(
			handle,
			updateSql,
			updateParams,
			opts.retryAttempts,
			opts.retryDelayMs,
		);
		return { status: 'updated', sql: updateSql };
	}

	const insertStmt = compileInsertStatement({
		dialect: opts.dialect,
		qualifiedTable,
		columns: row.matchedColumns,
		rows: [row],
		ignoreDuplicates: false,
		dryRun: false,
	});
	const inserted = await queryWithRetry(
		handle,
		insertStmt.sql,
		insertStmt.params,
		opts.retryAttempts,
		opts.retryDelayMs,
	);
	return {
		status: 'inserted',
		sql: insertStmt.sql,
		returnedRow: inserted[0],
	};
}

export async function executeWritePlan(
	handle: ManagedDbHandle,
	rows: MappedRowResult[],
	opts: WriteExecutionOptions,
	node: INode,
): Promise<WriteEngineResult> {
	const outcomes: WriteRowOutcome[] = [];
	const failures: RowFailureRecord[] = [];
	let insertedCount = 0;
	let updatedCount = 0;
	let upsertedCount = 0;
	let skippedCount = 0;

	if (rows.length === 0) {
		return {
			outcomes,
			failures,
			insertedCount,
			updatedCount,
			upsertedCount,
			skippedCount,
		};
	}

	const qualifiedTable = qualifyTable(opts.schema, opts.table, opts.dialect);
	const useTx =
		!opts.dryRun &&
		handle.supportsTransaction &&
		(opts.useTransaction || opts.errorHandlerMode === 'rollbackAndRouteToError');

	if (useTx) {
		await handle.beginTransaction();
	}

	let txAbortedAndRolledBack = false;

	const abortOrRecordFailure = async (failure: RowFailureRecord): Promise<'abort' | 'continue'> => {
		if (opts.errorHandlerMode === 'throwError') {
			if (useTx) await handle.rollbackTransaction();
			throw new NodeOperationError(node, failure.error);
		}
		if (opts.errorHandlerMode === 'rollbackAndRouteToError') {
			if (useTx) {
				await handle.rollbackTransaction();
				txAbortedAndRolledBack = true;
			}
			failures.push({
				...failure,
				errorCode: useTx ? 'TRANSACTION_ABORTED' : failure.errorCode,
				error: useTx
					? `Transaction rolled back: ${failure.error}`
					: `${failure.error} (dialect "${opts.dialect}" does not support transactional rollback)`,
			});
			return 'abort';
		}
		failures.push(failure);
		return 'continue';
	};

	let aborted = false;

	try {
		if (opts.operation === 'update') {
			for (const row of rows) {
				const stmt = compileUpdateStatement({
					dialect: opts.dialect,
					qualifiedTable,
					row,
					matchKeys: opts.matchKeys,
					dryRun: opts.dryRun,
					returning: opts.requireMatchedRow || supportsInsertReturning(opts.dialect),
				});

				if (opts.dryRun) {
					outcomes.push({
						rowIndex: row.rowIndex,
						itemIndex: row.itemIndex,
						status: 'dryRun',
						mappedRow: row.mappedRow,
						sql: stmt.sql,
					});
					continue;
				}

				let rowErr: unknown = null;
				let rowNotFound = false;
				let returned: Record<string, unknown>[] = [];
				try {
					if (opts.requireMatchedRow && !supportsInsertReturning(opts.dialect)) {
						const whereSql = opts.matchKeys
							.map((k) => `${quoteIdent(k, 'column', opts.dialect)} = ?`)
							.join(' AND ');
						const keyParams = opts.matchKeys.map((k) => row.mappedRow[k]);
						const existing = await queryWithRetry(
							handle,
							`SELECT 1 AS found FROM ${qualifiedTable} WHERE ${whereSql}`,
							keyParams,
							opts.retryAttempts,
							opts.retryDelayMs,
						);
						if (existing.length === 0) {
							rowNotFound = true;
						}
					}

					if (!rowNotFound) {
						returned = await queryWithRetry(
							handle,
							stmt.sql,
							stmt.params,
							opts.retryAttempts,
							opts.retryDelayMs,
						);
						if (
							opts.requireMatchedRow &&
							supportsInsertReturning(opts.dialect) &&
							returned.length === 0
						) {
							rowNotFound = true;
						}
					}
				} catch (err) {
					rowErr = err;
				}

				if (rowNotFound) {
					const action = await abortOrRecordFailure(
						makeDbFailure(
							row,
							opts,
							`No matching row found in "${opts.table}" for key(s): ${opts.matchKeys.join(', ')}`,
							stmt.sql,
							'ROW_NOT_FOUND',
						),
					);
					if (action === 'abort') {
						aborted = true;
						break;
					}
					continue;
				}

				if (rowErr) {
					const action = await abortOrRecordFailure(
						makeDbFailure(row, opts, rowErr, stmt.sql),
					);
					if (action === 'abort') {
						aborted = true;
						break;
					}
					continue;
				}

				updatedCount++;
				outcomes.push({
					rowIndex: row.rowIndex,
					itemIndex: row.itemIndex,
					status: 'updated',
					mappedRow: row.mappedRow,
					returnedRow: returned[0],
				});
			}
		} else if (
			opts.operation === 'upsert' &&
			!supportsNativeSingleStatementUpsert(opts.dialect)
		) {
			for (const row of rows) {
				if (opts.dryRun) {
					const preview = compileUpsertStatement({
						dialect: opts.dialect,
						qualifiedTable,
						columns: row.matchedColumns,
						matchKeys: opts.matchKeys,
						rows: [row],
						dryRun: true,
					});
					outcomes.push({
						rowIndex: row.rowIndex,
						itemIndex: row.itemIndex,
						status: 'dryRun',
						mappedRow: row.mappedRow,
						sql: preview.sql,
					});
					continue;
				}
				let rowErr: unknown = null;
				let res:
					| { status: 'inserted' | 'updated'; sql: string; returnedRow?: Record<string, unknown> }
					| undefined;
				try {
					res = await executeSingleTwoStepUpsert(
						handle,
						qualifiedTable,
						row,
						opts.matchKeys,
						opts,
					);
				} catch (err) {
					rowErr = err;
				}
				if (rowErr || !res) {
					const action = await abortOrRecordFailure(makeDbFailure(row, opts, rowErr));
					if (action === 'abort') {
						aborted = true;
						break;
					}
					continue;
				}
				upsertedCount++;
				if (res.status === 'inserted') insertedCount++;
				else updatedCount++;
				outcomes.push({
					rowIndex: row.rowIndex,
					itemIndex: row.itemIndex,
					status: 'upserted',
					mappedRow: row.mappedRow,
					returnedRow: res.returnedRow,
				});
			}
		} else {
			// Batchable INSERT or native UPSERT
			const allColumns = collectOrderedColumns(rows);
			const dialectCap = maxInsertRows(opts.dialect, allColumns.length);
			const chunkCap =
				opts.dialect === 'oracle' && opts.operation === 'upsert'
					? 1
					: Math.max(1, Math.min(opts.batchSize || 100, dialectCap));

			for (let offset = 0; offset < rows.length; offset += chunkCap) {
				if (aborted) break;
				const chunk = rows.slice(offset, offset + chunkCap);
				const stmt =
					opts.operation === 'insert'
						? compileInsertStatement({
								dialect: opts.dialect,
								qualifiedTable,
								columns: allColumns,
								rows: chunk,
								ignoreDuplicates: opts.ignoreDuplicates,
								dryRun: opts.dryRun,
							})
						: compileUpsertStatement({
								dialect: opts.dialect,
								qualifiedTable,
								columns: allColumns,
								matchKeys: opts.matchKeys,
								rows: chunk,
								dryRun: opts.dryRun,
							});

				if (opts.dryRun) {
					for (const row of chunk) {
						outcomes.push({
							rowIndex: row.rowIndex,
							itemIndex: row.itemIndex,
							status: 'dryRun',
							mappedRow: row.mappedRow,
							sql: stmt.sql,
						});
					}
					continue;
				}

				let batchErr: unknown = null;
				let returned: Record<string, unknown>[] = [];
				try {
					returned = await queryWithRetry(
						handle,
						stmt.sql,
						stmt.params,
						opts.retryAttempts,
						opts.retryDelayMs,
					);
				} catch (err) {
					batchErr = err;
				}

				if (!batchErr) {
					for (let i = 0; i < chunk.length; i++) {
						const row = chunk[i];
						if (opts.operation === 'insert') insertedCount++;
						else upsertedCount++;
						outcomes.push({
							rowIndex: row.rowIndex,
							itemIndex: row.itemIndex,
							status: opts.operation === 'insert' ? 'inserted' : 'upserted',
							mappedRow: row.mappedRow,
							returnedRow: returned[i],
						});
					}
					continue;
				}

				const canIsolate =
					chunk.length > 1 &&
					opts.isolateFailedBatchRows &&
					!useTx &&
					(opts.errorHandlerMode === 'routeToErrorOutput' ||
						opts.errorHandlerMode === 'skipAndLog');

				if (!canIsolate) {
					if (useTx) {
						const action = await abortOrRecordFailure(
							makeDbFailure(chunk[0], opts, batchErr, stmt.sql),
						);
						if (action === 'abort') {
							aborted = true;
							break;
						}
					} else {
						for (const row of chunk) {
							const action = await abortOrRecordFailure(
								makeDbFailure(row, opts, batchErr, stmt.sql),
							);
							if (action === 'abort') {
								aborted = true;
								break;
							}
						}
					}
					continue;
				}

				for (const singleRow of chunk) {
					const rowCols = singleRow.matchedColumns;
					const rowStmt =
						opts.operation === 'insert'
							? compileInsertStatement({
									dialect: opts.dialect,
									qualifiedTable,
									columns: rowCols,
									rows: [singleRow],
									ignoreDuplicates: opts.ignoreDuplicates,
									dryRun: false,
								})
							: compileUpsertStatement({
									dialect: opts.dialect,
									qualifiedTable,
									columns: rowCols,
									matchKeys: opts.matchKeys,
									rows: [singleRow],
									dryRun: false,
								});
					let singleErr: unknown = null;
					let singleReturned: Record<string, unknown>[] = [];
					try {
						singleReturned = await queryWithRetry(
							handle,
							rowStmt.sql,
							rowStmt.params,
							opts.retryAttempts,
							opts.retryDelayMs,
						);
					} catch (err) {
						singleErr = err;
					}
					if (singleErr) {
						const action = await abortOrRecordFailure(
							makeDbFailure(singleRow, opts, singleErr, rowStmt.sql),
						);
						if (action === 'abort') {
							aborted = true;
							break;
						}
						continue;
					}
					if (opts.operation === 'insert') insertedCount++;
					else upsertedCount++;
					outcomes.push({
						rowIndex: singleRow.rowIndex,
						itemIndex: singleRow.itemIndex,
						status: opts.operation === 'insert' ? 'inserted' : 'upserted',
						mappedRow: singleRow.mappedRow,
						returnedRow: singleReturned[0],
					});
				}
			}
		}

		if (txAbortedAndRolledBack) {
			outcomes.length = 0;
			insertedCount = 0;
			updatedCount = 0;
			upsertedCount = 0;
		} else if (useTx) {
			await handle.commitTransaction();
		}
	} catch (err) {
		if (useTx) {
			try {
				await handle.rollbackTransaction();
			} catch {
				// Ignore rollback errors on already failed connection
			}
		}
		throw new NodeOperationError(
			node,
			err instanceof Error ? err.message : String(err),
		);
	}

	return {
		outcomes,
		failures,
		insertedCount,
		updatedCount,
		upsertedCount,
		skippedCount,
	};
}
