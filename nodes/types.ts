import type { SupportedDialect } from './supportedDialects';

export type WriteOperation = 'insert' | 'update' | 'upsert';

export type MappingMode = 'resourceMapper' | 'auto' | 'manual';

export type MatchRule = 'exact' | 'caseInsensitive' | 'normalized';

export type UnmatchedSourceBehavior = 'ignore' | 'error' | 'include';

export type ColumnDataTypeOverride =
	| 'auto'
	| 'string'
	| 'integer'
	| 'decimal'
	| 'boolean'
	| 'date'
	| 'datetime'
	| 'json';

export type RegexAction = 'validate' | 'extract' | 'replace';

export type InputDateFormat =
	| 'auto'
	| 'YYYY-MM-DD'
	| 'MM/DD/YYYY'
	| 'DD/MM/YYYY'
	| 'unixSeconds'
	| 'unixMs';

export type DateTimeOutputFormat =
	| 'none'
	| 'iso'
	| 'sqlDateTime'
	| 'sqlDate'
	| 'sqlTime'
	| 'unixSeconds'
	| 'unixMs';

export type CaseTransform = 'none' | 'lowercase' | 'uppercase';

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

export interface ColumnValidationRule {
	targetColumn: string;
	dataType?: ColumnDataTypeOverride;
	required?: boolean;
	defaultValue?: string;
	trim?: boolean;
	caseTransform?: CaseTransform;
	regexAction?: RegexAction;
	regexPattern?: string;
	regexFlags?: string;
	regexReplacement?: string;
	failOnRegexMismatch?: boolean;
	inputDateFormat?: InputDateFormat;
	dateTimeOutput?: DateTimeOutputFormat;
	targetTimezone?: string;
	minValue?: string;
	maxValue?: string;
	allowedValues?: string;
	validationMessage?: string;
}

export interface ParsedSourceRow {
	rowIndex: number;
	itemIndex: number;
	data: Record<string, unknown>;
	positionalValues?: unknown[];
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
	| 'SCHEMA_MISMATCH'
	| 'TYPE_COERCION'
	| 'REGEX_VALIDATION'
	| 'DATE_PARSE_ERROR'
	| 'VALIDATION_ERROR'
	| 'MISSING_REQUIRED_COLUMN'
	| 'MISSING_MATCH_KEY'
	| 'EMPTY_MAPPED_ROW'
	| 'DB_ERROR'
	| 'ROW_NOT_FOUND'
	| 'TRANSACTION_ABORTED';

export interface RowFailureRecord {
	rowIndex: number;
	itemIndex: number;
	stage: 'schema_match' | 'validation' | 'db_write';
	errorCode: MatchErrorCode;
	error: string;
	operation?: WriteOperation;
	table?: string;
	dialect?: string;
	column?: string;
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
