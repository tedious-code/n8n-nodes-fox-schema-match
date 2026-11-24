/**
 * Slim CJS entry for the n8n bundle.
 * Exports only the @foxschema/db runtime handles and pure @foxschema/sql
 * dialect/tokenizer helpers needed by n8n-nodes-fox-schema-match.
 */
export {
	ConnectionFactory,
	getAdapter,
	getRegisteredProvider,
	openDatabase,
	queryOnce,
	assertSafeIdentifier,
	dialectSupportsTransactionalRollback,
} from '@foxschema/db';

export {
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
} from '@foxschema/sql';

export { sqlTokens } from '#foxschema-sql-tokens';
export { sqlReadingsFor } from '#foxschema-sql-readings';
