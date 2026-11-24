import type { FoxTableSchema } from './foxSchema';
import {
	assertIdent,
	normalizeColumnKey,
	resolveDotBracketPath,
	stripTableSchema,
} from './sqlHelpers';
import type { SupportedDialect } from './supportedDialects';
import type {
	ColumnTransform,
	ManualColumnMapping,
	MappedRowResult,
	MappingMode,
	MatchRule,
	ParsedSourceRow,
	RowFailureRecord,
	TargetColumnMeta,
	TargetTableMeta,
	UnmatchedSourceBehavior,
	WriteOperation,
} from './types';

function categorizeColumnType(rawType: string): TargetColumnMeta['category'] {
	const t = String(rawType ?? '').toUpperCase();
	if (/BOOL|BIT/.test(t)) return 'boolean';
	if (/INT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|NUMBER|MONEY|SERIAL|DEC|FIXED/.test(t)) {
		return 'numeric';
	}
	if (/DATE|TIME|TIMESTAMP|DATETIME/.test(t)) return 'date';
	if (/JSON|JSONB/.test(t)) return 'json';
	if (/BLOB|BYTEA|BINARY|VARBINARY|RAW/.test(t)) return 'binary';
	return 'string';
}

export function buildTargetTableMeta(
	tableSchema: FoxTableSchema,
	schemaName: string,
): TargetTableMeta {
	const columns: TargetColumnMeta[] = [];
	const byName = new Map<string, TargetColumnMeta>();
	const byLower = new Map<string, TargetColumnMeta>();
	const byNormalized = new Map<string, TargetColumnMeta>();

	for (const col of tableSchema.columns ?? []) {
		const meta: TargetColumnMeta = {
			name: col.name,
			type: String(col.type ?? 'TEXT'),
			nullable: col.nullable !== false,
			defaultValue: col.defaultValue,
			primaryKey: Boolean(col.primaryKey),
			identity: Boolean(col.identity),
			category: categorizeColumnType(col.type ?? ''),
		};
		columns.push(meta);
		byName.set(meta.name, meta);
		byLower.set(meta.name.toLowerCase(), meta);
		byNormalized.set(normalizeColumnKey(meta.name), meta);
	}

	const pkFromHeader = tableSchema.primaryKey?.columns ?? [];
	const pkFromCols = columns.filter((c) => c.primaryKey).map((c) => c.name);
	const primaryKeys = pkFromHeader.length > 0 ? pkFromHeader : pkFromCols;

	const uniqueKeys: string[][] = (tableSchema.indices ?? [])
		.filter((idx) => idx.unique && idx.columns.length > 0)
		.map((idx) => idx.columns);

	return {
		name: tableSchema.name,
		schema: schemaName,
		columns,
		byName,
		byLower,
		byNormalized,
		primaryKeys,
		uniqueKeys,
	};
}

export function findTableSchemaInCatalog(
	objects: FoxTableSchema[],
	rawTableName: string,
): FoxTableSchema | undefined {
	const { table } = stripTableSchema(rawTableName);
	const upper = table.toUpperCase();
	return objects.find(
		(o) =>
			(o.objectType === 'TABLE' || o.objectType === 'VIEW' || o.objectType === 'MQT') &&
			o.name.toUpperCase() === upper,
	);
}

export function resolveColumnInMeta(
	meta: TargetTableMeta | undefined,
	candidate: string,
	rule: MatchRule,
): TargetColumnMeta | undefined {
	if (!meta) return undefined;
	const exact = meta.byName.get(candidate);
	if (exact) return exact;
	if (rule === 'exact') return undefined;

	const lower = meta.byLower.get(candidate.toLowerCase());
	if (lower || rule === 'caseInsensitive') return lower;

	return meta.byNormalized.get(normalizeColumnKey(candidate));
}

export function applyColumnTransform(
	value: unknown,
	transform: ColumnTransform | undefined,
): unknown {
	if (!transform || transform === 'none') return value;
	if (value === undefined || value === null) {
		return transform === 'nullIfEmpty' ? null : value;
	}

	switch (transform) {
		case 'trim':
			return typeof value === 'string' ? value.trim() : String(value).trim();
		case 'lowercase':
			return typeof value === 'string' ? value.toLowerCase() : String(value).toLowerCase();
		case 'uppercase':
			return typeof value === 'string' ? value.toUpperCase() : String(value).toUpperCase();
		case 'nullIfEmpty':
			return typeof value === 'string' && value.trim() === '' ? null : value;
		case 'toNumber': {
			if (typeof value === 'number') return value;
			const s = String(value).trim().replace(/,/g, '');
			if (s === '') return null;
			const n = Number(s);
			if (!Number.isFinite(n)) {
				throw new Error(`Cannot transform "${value}" to number`);
			}
			return n;
		}
		case 'toBoolean': {
			if (typeof value === 'boolean') return value;
			const s = String(value).trim().toLowerCase();
			if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
			if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
			throw new Error(`Cannot transform "${value}" to boolean`);
		}
		case 'toIsoDate': {
			if (value instanceof Date) return value.toISOString();
			const d = new Date(String(value).trim());
			if (Number.isNaN(d.getTime())) {
				throw new Error(`Cannot transform "${value}" to ISO date`);
			}
			return d.toISOString();
		}
		case 'jsonStringify':
			return typeof value === 'string' ? value : JSON.stringify(value);
		default:
			return value;
	}
}

export function coerceValueForColumn(
	value: unknown,
	colMeta: TargetColumnMeta | undefined,
	opts: {
		dialect: SupportedDialect;
		emptyStringAsNull: boolean;
		strictTypeValidation: boolean;
	},
): unknown {
	if (value === undefined || value === null) return null;
	if (typeof value === 'string' && opts.emptyStringAsNull && value.trim() === '') {
		return null;
	}

	const category = colMeta?.category ?? 'string';

	if (category === 'numeric') {
		if (typeof value === 'number') {
			if (!Number.isFinite(value)) {
				throw new Error(`Column "${colMeta?.name}" received non-finite number`);
			}
			return value;
		}
		if (typeof value === 'boolean') return value ? 1 : 0;
		const cleaned = String(value).trim().replace(/,/g, '');
		if (cleaned === '') return null;
		const num = Number(cleaned);
		if (!Number.isFinite(num)) {
			if (opts.strictTypeValidation) {
				throw new Error(
					`Column "${colMeta?.name}" (${colMeta?.type}) expected number, got "${value}"`,
				);
			}
			return value;
		}
		return num;
	}

	if (category === 'boolean') {
		let boolVal: boolean;
		if (typeof value === 'boolean') {
			boolVal = value;
		} else if (typeof value === 'number') {
			boolVal = value !== 0;
		} else {
			const s = String(value).trim().toLowerCase();
			if (['true', '1', 'yes', 'y', 't'].includes(s)) boolVal = true;
			else if (['false', '0', 'no', 'n', 'f'].includes(s)) boolVal = false;
			else if (opts.strictTypeValidation) {
				throw new Error(
					`Column "${colMeta?.name}" (${colMeta?.type}) expected boolean, got "${value}"`,
				);
			} else {
				return value;
			}
		}
		// SQLite (better-sqlite3) and Oracle/SQL Server bit columns bind 1/0 cleanly.
		if (
			opts.dialect === 'sqlite' ||
			opts.dialect === 'oracle' ||
			opts.dialect === 'sqlserver' ||
			opts.dialect === 'azuresql'
		) {
			return boolVal ? 1 : 0;
		}
		return boolVal;
	}

	if (category === 'date') {
		if (value instanceof Date) {
			if (Number.isNaN(value.getTime())) {
				throw new Error(`Column "${colMeta?.name}" received Invalid Date`);
			}
			return value.toISOString();
		}
		const s = String(value).trim();
		const parsed = new Date(s);
		if (Number.isNaN(parsed.getTime())) {
			if (opts.strictTypeValidation) {
				throw new Error(
					`Column "${colMeta?.name}" (${colMeta?.type}) expected valid date, got "${value}"`,
				);
			}
			return value;
		}
		return s;
	}

	if (category === 'json') {
		if (typeof value === 'object') {
			return JSON.stringify(value);
		}
		if (typeof value === 'string' && opts.strictTypeValidation) {
			let validJson = false;
			try {
				JSON.parse(value);
				validJson = true;
			} catch {
				validJson = false;
			}
			if (!validJson) {
				throw new Error(
					`Column "${colMeta?.name}" (${colMeta?.type}) expected valid JSON`,
				);
			}
		}
		return String(value);
	}

	if (category === 'binary') {
		if (Buffer.isBuffer(value)) return value;
		return String(value);
	}

	// String / fallback: serialize objects cleanly so drivers don't reject plain objects
	if (typeof value === 'object') {
		if (value instanceof Date) return value.toISOString();
		if (Buffer.isBuffer(value)) return value;
		return JSON.stringify(value);
	}
	if (typeof value === 'boolean' && opts.dialect === 'sqlite') {
		return value ? 1 : 0;
	}
	return value;
}

export interface MatchEngineOptions {
	operation: WriteOperation;
	table: string;
	dialect: SupportedDialect;
	tableMeta?: TargetTableMeta;
	mappingMode: MappingMode;
	matchRule: MatchRule;
	unmatchedSourceBehavior: UnmatchedSourceBehavior;
	manualMappings: ManualColumnMapping[];
	positionalColumns: string[];
	matchKeyColumns: string[];
	emptyStringAsNull: boolean;
	strictTypeValidation: boolean;
	validateRequiredColumns: boolean;
	includeIdentityOnInsert: boolean;
	skipNullValuesOnUpdate: boolean;
}

export function resolveEffectiveMatchKeys(opts: {
	configuredKeys: string[];
	tableMeta?: TargetTableMeta;
	matchRule: MatchRule;
}): string[] {
	if (opts.configuredKeys.length > 0) {
		return opts.configuredKeys.map((raw) => {
			const resolved = resolveColumnInMeta(opts.tableMeta, raw.trim(), opts.matchRule);
			return resolved ? resolved.name : assertIdent(raw.trim(), 'match key column');
		});
	}
	if (opts.tableMeta?.primaryKeys.length) {
		return [...opts.tableMeta.primaryKeys];
	}
	if (opts.tableMeta?.uniqueKeys.length) {
		return [...opts.tableMeta.uniqueKeys[0]];
	}
	return [];
}

export function matchSourceRow(
	row: ParsedSourceRow,
	opts: MatchEngineOptions,
): MappedRowResult | RowFailureRecord {
	const mappedRow: Record<string, unknown> = {};
	const matchedColumns: string[] = [];
	const unmatchedFields: string[] = [];

	const fail = (
		errorCode: RowFailureRecord['errorCode'],
		error: string,
	): RowFailureRecord => ({
		rowIndex: row.rowIndex,
		itemIndex: row.itemIndex,
		stage: 'schema_match',
		errorCode,
		error,
		operation: opts.operation,
		table: opts.table,
		dialect: opts.dialect,
		sourceRow: row.data,
		mappedRow: Object.keys(mappedRow).length > 0 ? { ...mappedRow } : undefined,
	});

	const setTargetValue = (targetColName: string, rawVal: unknown, transform?: ColumnTransform) => {
		const colMeta = resolveColumnInMeta(opts.tableMeta, targetColName, opts.matchRule);
		if (opts.tableMeta && !colMeta) {
			throw new Error(`Target column "${targetColName}" does not exist in table "${opts.table}"`);
		}
		const finalName = colMeta ? colMeta.name : assertIdent(targetColName, 'target column');
		const transformed = applyColumnTransform(rawVal, transform);
		const coerced = coerceValueForColumn(transformed, colMeta, {
			dialect: opts.dialect,
			emptyStringAsNull: opts.emptyStringAsNull,
			strictTypeValidation: opts.strictTypeValidation,
		});

		if (
			opts.operation === 'update' &&
			opts.skipNullValuesOnUpdate &&
			(coerced === null || coerced === undefined)
		) {
			return;
		}

		mappedRow[finalName] = coerced;
		if (!matchedColumns.includes(finalName)) {
			matchedColumns.push(finalName);
		}
	};

	try {
		if (opts.mappingMode === 'manual') {
			if (opts.manualMappings.length === 0) {
				return fail(
					'SCHEMA_MISMATCH',
					'Manual mapping mode requires at least one column mapping entry.',
				);
			}

			for (const mapping of opts.manualMappings) {
				const targetCol = String(mapping.targetColumn ?? '').trim();
				if (!targetCol) continue;

				const srcPath = String(mapping.sourceField ?? '').trim();
				let val = srcPath ? resolveDotBracketPath(row.data, srcPath) : undefined;
				const isEmpty =
					val === undefined ||
					val === null ||
					(typeof val === 'string' && val.trim() === '');

				if (isEmpty) {
					if (mapping.skipIfEmpty) continue;
					if (mapping.defaultValue !== undefined && mapping.defaultValue !== '') {
						val = mapping.defaultValue;
					}
				}

				setTargetValue(targetCol, val, mapping.transform);
			}
		} else if (opts.mappingMode === 'positional') {
			const values = row.positionalValues ?? Object.values(row.data);
			const targetCols =
				opts.positionalColumns.length > 0
					? opts.positionalColumns
					: (opts.tableMeta?.columns ?? [])
							.filter((c) => opts.includeIdentityOnInsert || !c.identity)
							.map((c) => c.name);

			if (targetCols.length === 0) {
				return fail(
					'SCHEMA_MISMATCH',
					'Positional mapping requires Positional Target Columns or an introspected table schema.',
				);
			}

			for (let idx = 0; idx < targetCols.length; idx++) {
				if (idx >= values.length) break;
				setTargetValue(targetCols[idx], values[idx]);
			}
		} else {
			// Auto-match mode + optional manual overrides
			const overriddenSources = new Set<string>();
			for (const mapping of opts.manualMappings) {
				const targetCol = String(mapping.targetColumn ?? '').trim();
				const srcPath = String(mapping.sourceField ?? '').trim();
				if (!targetCol) continue;

				if (srcPath) overriddenSources.add(srcPath);
				let val = srcPath ? resolveDotBracketPath(row.data, srcPath) : undefined;
				const isEmpty =
					val === undefined ||
					val === null ||
					(typeof val === 'string' && val.trim() === '');

				if (isEmpty) {
					if (mapping.skipIfEmpty) continue;
					if (mapping.defaultValue !== undefined && mapping.defaultValue !== '') {
						val = mapping.defaultValue;
					}
				}
				setTargetValue(targetCol, val, mapping.transform);
			}

			for (const [srcKey, srcVal] of Object.entries(row.data)) {
				if (overriddenSources.has(srcKey)) continue;

				if (opts.tableMeta) {
					const matchedCol = resolveColumnInMeta(opts.tableMeta, srcKey, opts.matchRule);
					if (!matchedCol) {
						unmatchedFields.push(srcKey);
						if (opts.unmatchedSourceBehavior === 'error') {
							return fail(
								'SCHEMA_MISMATCH',
								`Source field "${srcKey}" does not match any column in "${opts.table}"`,
							);
						}
						if (opts.unmatchedSourceBehavior === 'ignore') {
							continue;
						}
						// 'include'
						setTargetValue(srcKey, srcVal);
						continue;
					}

					if (
						opts.operation === 'insert' &&
						matchedCol.identity &&
						!opts.includeIdentityOnInsert
					) {
						continue;
					}

					// Don't overwrite an explicit manual override for the same target column
					if (!(matchedCol.name in mappedRow)) {
						setTargetValue(matchedCol.name, srcVal);
					}
				} else {
					// Schemaless fallback
					setTargetValue(srcKey, srcVal);
				}
			}
		}
	} catch (err: any) {
		const msg = err?.message || String(err);
		const isTypeErr =
			msg.includes('expected number') ||
			msg.includes('expected boolean') ||
			msg.includes('expected valid date') ||
			msg.includes('expected valid JSON') ||
			msg.includes('Cannot transform');
		return fail(isTypeErr ? 'TYPE_COERCION' : 'SCHEMA_MISMATCH', msg);
	}

	if (matchedColumns.length === 0) {
		return fail(
			'EMPTY_MAPPED_ROW',
			`No fields matched any target columns in "${opts.table}"`,
		);
	}

	// Validate required NOT NULL columns on INSERT
	if (opts.operation === 'insert' && opts.validateRequiredColumns && opts.tableMeta) {
		for (const col of opts.tableMeta.columns) {
			if (
				!col.nullable &&
				!col.identity &&
				col.defaultValue === undefined &&
				!(col.primaryKey && col.category === 'numeric' && !opts.includeIdentityOnInsert)
			) {
				const v = mappedRow[col.name];
				if (v === undefined || v === null) {
					return fail(
						'MISSING_REQUIRED_COLUMN',
						`Required NOT NULL column "${col.name}" is missing or null for insert`,
					);
				}
			}
		}
	}

	// Validate match keys on UPDATE / UPSERT
	if (opts.operation === 'update' || opts.operation === 'upsert') {
		if (opts.matchKeyColumns.length === 0) {
			return fail(
				'MISSING_MATCH_KEY',
				`Operation "${opts.operation}" requires at least one Match Key column (or a table primary key).`,
			);
		}
		for (const keyCol of opts.matchKeyColumns) {
			const val = mappedRow[keyCol];
			if (val === undefined || val === null) {
				return fail(
					'MISSING_MATCH_KEY',
					`Match key column "${keyCol}" is missing or null in mapped row`,
				);
			}
		}
		if (opts.operation === 'update') {
			const nonKeyCols = matchedColumns.filter((c) => !opts.matchKeyColumns.includes(c));
			if (nonKeyCols.length === 0) {
				return fail(
					'EMPTY_MAPPED_ROW',
					'Update operation has no non-key columns to update',
				);
			}
		}
	}

	return {
		ok: true,
		rowIndex: row.rowIndex,
		itemIndex: row.itemIndex,
		sourceRow: row.data,
		mappedRow,
		matchedColumns,
		unmatchedFields,
	};
}
