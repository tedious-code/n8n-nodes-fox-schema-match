import type { ICredentialDataDecryptedObject } from 'n8n-workflow';
import {
	assertSafeIdentifier,
	DEFAULT_PORTS,
	placeholderStyleFor,
	quoteSqlIdentifier,
	renderPlaceholder,
	sqlReadingsFor,
	sqlTokens,
} from './foxSchema';
import {
	assertSupportedDialect,
	DEFAULT_SCHEMA,
	isFileDialect,
	isMysqlFamily,
	type SupportedDialect,
} from './supportedDialects';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$#]*$/;

export function assertIdent(name: string, label = 'identifier'): string {
	const trimmed = String(name ?? '').trim();
	if (!trimmed) {
		throw new Error(`${label} is required`);
	}
	if (!IDENT_RE.test(trimmed)) {
		throw new Error(
			`Invalid ${label} "${name}". Use letters, digits, underscore, $, or # only.`,
		);
	}
	return assertSafeIdentifier(trimmed, label);
}

export function quoteIdent(
	name: string,
	label = 'identifier',
	dialect: SupportedDialect = 'postgres',
): string {
	const id = assertIdent(name, label);
	const normalized = dialect === 'oracle' ? id.toUpperCase() : id;
	return quoteSqlIdentifier(normalized, dialect);
}

export function qualifyTable(
	schema: string | undefined,
	table: string,
	dialect: SupportedDialect,
): string {
	const parts = String(table ?? '')
		.split('.')
		.map((p) => p.trim())
		.filter(Boolean);

	if (parts.length === 2) {
		return `${quoteIdent(parts[0], 'schema', dialect)}.${quoteIdent(parts[1], 'table', dialect)}`;
	}
	if (parts.length > 2) {
		throw new Error(`Invalid table name "${table}". Expected "table" or "schema.table".`);
	}

	const quotedTable = quoteIdent(parts[0] ?? table, 'table', dialect);
	const s = schema?.trim();
	if (!s) return quotedTable;
	return `${quoteIdent(s, 'schema', dialect)}.${quotedTable}`;
}

export function stripTableSchema(tableName: string): { schema?: string; table: string } {
	const parts = String(tableName ?? '')
		.split('.')
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length === 2) {
		return { schema: parts[0], table: parts[1] };
	}
	return { table: parts[0] ?? tableName };
}

export function defaultPort(dialect: SupportedDialect): number {
	return DEFAULT_PORTS[dialect] ?? 5432;
}

export function resolveDialect(rawDialect: unknown): SupportedDialect {
	return assertSupportedDialect(String(rawDialect ?? 'postgres'));
}

export function resolveSchemaFromConfig(
	config: Record<string, any>,
	dialect: SupportedDialect,
): string {
	const schema = String(config.schema ?? '').trim();
	if (schema) return schema;
	if (isMysqlFamily(dialect) || dialect === 'clickhouse') {
		return String(config.database ?? '').trim();
	}
	if (dialect === 'oracle') {
		return String(config.username ?? '').trim().toUpperCase();
	}
	return DEFAULT_SCHEMA[dialect];
}

export function resolveSchema(credentials: ICredentialDataDecryptedObject): string {
	const dialect = resolveDialect(credentials.dialect);
	return resolveSchemaFromConfig(credentials as Record<string, any>, dialect);
}

/**
 * Rewrite `?` bind placeholders to the target dialect style (`$1`, `@p1`, `:1`, or `?`)
 * using @foxschema/sql's lexer so strings, comments, and quoted identifiers are untouched.
 */
export function rewritePlaceholders(dialect: SupportedDialect, sql: string): string {
	const style = placeholderStyleFor(dialect);
	if (style === 'question') {
		return sql;
	}

	const reading = sqlReadingsFor(sql, dialect)[0] ?? {};
	let index = 0;
	let out = '';

	for (const token of sqlTokens(sql, reading)) {
		const raw = sql.slice(token.start, token.end);
		if (token.kind === 'punct' && raw === '?') {
			index += 1;
			out += renderPlaceholder(style, index);
		} else {
			out += raw;
		}
	}

	return out;
}

export function countSqlPlaceholders(sql: string, dialect?: SupportedDialect): number {
	const reading = sqlReadingsFor(sql, dialect)[0] ?? {};
	let count = 0;
	for (const token of sqlTokens(sql, reading)) {
		if (token.kind === 'punct' && sql.slice(token.start, token.end) === '?') {
			count += 1;
		}
	}
	return count;
}

export function resolveDotBracketPath(root: unknown, pathStr: string): unknown {
	const clean = pathStr.trim();
	if (!clean) return root;

	const tokens: string[] = [];
	const re = /[^.[\]]+|\[(\d+|"[^"]*"|'[^']*')\]/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(clean)) !== null) {
		const raw = match[1] ?? match[0];
		tokens.push(raw.replace(/^['"]|['"]$/g, ''));
	}

	let cur: any = root;
	for (const tok of tokens) {
		if (cur === undefined || cur === null) return undefined;
		cur = cur[tok];
	}
	return cur;
}

export function normalizeColumnKey(name: string): string {
	return String(name ?? '')
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '');
}

export function isSqlFileDialect(dialect: string): boolean {
	return isFileDialect(dialect);
}
