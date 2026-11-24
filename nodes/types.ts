import type { SupportedDialect } from './supportedDialects';

export type DataSourceType = 'rawQuery' | 'json' | 'csv' | 'text';

export type WriteOperation = 'insert' | 'update' | 'upsert';

export type MappingMode = 'auto' | 'manual' | 'positional';

export type MatchRule = 'exact' | 'caseInsensitive' | 'normalized';

export type UnmatchedSourceBehavior = 'ignore' | 'error' | 'include';

export type JsonInputMode = 'incomingItems' | 'jsonString' | 'binary';

export type TextInputMode = 'textContent' | 'binary';

export type TextParseFormat =
	| 'pipe'
	| 'tsv'
	| 'customDelimiter'
	| 'keyValue'
	| 'regex'
	| 'fixedWidth'
	| 'lines';

export type ColumnTransform =
	| 'none'
	| 'trim'
	| 'lowercase'
	| 'uppercase'
	| 'toNumber'
	| 'toBoolean'
	| 'toIsoDate'
	| 'jsonStringify'
	| 'nullIfEmpty';

export type ErrorHandlerMode =
	| 'routeToErrorOutput'
	| 'skipAndLog'
	| 'rollbackAndRouteToError'
	| 'throwError';

export type OutputMode = 'summaryWithRows' | 'rowByRow' | 'summaryOnly';

export type RawQueryConnectionMode = 'sameAsTarget' | 'separateCredential' | 'inline';

export interface BindingParam {
	type: 'string' | 'number' | 'boolean' | 'date' | 'json' | 'null' | 'sql';
	value: string;
}

export interface InlineConnectionConfig {
	dialect: string;
	connectionString?: string;
	host?: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string;
	schema?: string;
	useSsl?: boolean;
	rejectUnauthorized?: boolean;
}

export interface ResolvedConnection {
	dialect: SupportedDialect;
	label: string;
	options: Record<string, unknown>;
}

export interface ManualColumnMapping {
	sourceField: string;
	targetColumn: string;
	defaultValue?: string;
	transform?: ColumnTransform;
	skipIfEmpty?: boolean;
}

export interface ParsedSourceRow {
	rowIndex: number;
	itemIndex: number;
	data: Record<string, unknown>;
	positionalValues?: unknown[];
	rawText?: string;
}

export interface ParseErrorRecord {
	rowIndex: number;
	itemIndex: number;
	stage: 'source_parse';
	errorCode: 'PARSE_ERROR';
	message: string;
	rawInput?: unknown;
}

export interface TargetColumnMeta {
	name: string;
	type: string;
	nullable: boolean;
	defaultValue?: string;
	primaryKey: boolean;
	identity: boolean;
	category: 'numeric' | 'boolean' | 'date' | 'json' | 'string' | 'binary';
}

export interface TargetTableMeta {
	name: string;
	schema: string;
	columns: TargetColumnMeta[];
	byName: Map<string, TargetColumnMeta>;
	byLower: Map<string, TargetColumnMeta>;
	byNormalized: Map<string, TargetColumnMeta>;
	primaryKeys: string[];
	uniqueKeys: string[][];
}

export interface MappedRowResult {
	ok: true;
	rowIndex: number;
	itemIndex: number;
	sourceRow: Record<string, unknown>;
	mappedRow: Record<string, unknown>;
	matchedColumns: string[];
	unmatchedFields: string[];
}

export type MatchErrorCode =
	| 'PARSE_ERROR'
	| 'SCHEMA_MISMATCH'
	| 'TYPE_COERCION'
	| 'MISSING_REQUIRED_COLUMN'
	| 'MISSING_MATCH_KEY'
	| 'EMPTY_MAPPED_ROW'
	| 'DB_ERROR'
	| 'ROW_NOT_FOUND'
	| 'TRANSACTION_ABORTED';

export interface RowFailureRecord {
	rowIndex: number;
	itemIndex: number;
	stage: 'source_parse' | 'schema_match' | 'db_write';
	errorCode: MatchErrorCode;
	error: string;
	operation?: WriteOperation;
	table?: string;
	dialect?: string;
	sourceRow?: unknown;
	mappedRow?: Record<string, unknown>;
	sql?: string;
}

export interface CompiledStatement {
	sql: string;
	params: unknown[];
	rowIndices: number[];
	operation: WriteOperation;
}

export interface WriteRowOutcome {
	rowIndex: number;
	itemIndex: number;
	status: 'inserted' | 'updated' | 'upserted' | 'skipped' | 'dryRun';
	mappedRow: Record<string, unknown>;
	returnedRow?: Record<string, unknown>;
	sql?: string;
}

export interface ExecutionSummary {
	operation: WriteOperation;
	dataSource: DataSourceType;
	table: string;
	dialect: SupportedDialect;
	dryRun: boolean;
	totalInputRows: number;
	succeededCount: number;
	failedCount: number;
	skippedCount: number;
	insertedCount: number;
	updatedCount: number;
	upsertedCount: number;
	matchedColumns: string[];
	matchKeys: string[];
	results: WriteRowOutcome[];
	errors: RowFailureRecord[];
}
