/**
 * Loads the bundled FoxSchema (@foxschema/db + @foxschema/sql) CJS build
 * produced by scripts/bundle-foxschema.mjs.
 * Relative import only — n8n community verification forbids fs/process/__dirname in node JS.
 */
export {
	ConnectionFactory,
	getAdapter,
	getRegisteredProvider,
	openDatabase,
	queryOnce,
	assertSafeIdentifier,
	dialectSupportsTransactionalRollback,
	DEFAULT_PORTS,
	PROVIDER_SETTINGS,
	getProviderSettings,
	dialectFamily,
	isFileDialect,
	placeholderStyleFor,
	renderPlaceholder,
	quoteSqlIdentifier,
	quoteQualifiedName,
	sqlLiteral,
	maxInsertRows,
	splitSqlStatements,
	sqlReadingsFor,
	sqlTokens,
} from './vendor/foxschema-core.cjs';

export type {
	OpenDatabase,
	SqlPlaceholderStyle,
	SqlToken,
	SqlTokenOptions,
} from './vendor/foxschema-core.cjs';

export interface FoxColumnInfo {
	name: string;
	type: string;
	nullable: boolean;
	defaultValue?: string;
	primaryKey: boolean;
	identity?: boolean;
	identityGeneration?: string;
}

export interface FoxIndexInfo {
	name: string;
	columns: string[];
	unique: boolean;
	constraint?: boolean;
}

export interface FoxTableSchema {
	name: string;
	objectType: string;
	columns?: FoxColumnInfo[];
	indices?: FoxIndexInfo[];
	primaryKey?: { name?: string; columns: string[] };
	engine?: string;
}
