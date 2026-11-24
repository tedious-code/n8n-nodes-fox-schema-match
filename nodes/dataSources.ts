import type { IExecuteFunctions, INode } from 'n8n-workflow';
import { openManagedHandle, toResolvedConnection, withTimeout } from './dbConnection';
import { sqlReadingsFor, sqlTokens } from './foxSchema';
import { countSqlPlaceholders, resolveDotBracketPath } from './sqlHelpers';
import type {
	BindingParam,
	InlineConnectionConfig,
	ParseErrorRecord,
	ParsedSourceRow,
	RawQueryConnectionMode,
	TextParseFormat,
} from './types';

export interface SourceParseResult {
	rows: ParsedSourceRow[];
	errors: ParseErrorRecord[];
}

export interface DelimitedParseOptions {
	delimiter: string;
	hasHeader: boolean;
	customHeaders?: string;
	quoteChar?: string;
	trimValues?: boolean;
	skipEmptyLines?: boolean;
	commentPrefix?: string;
}

/**
 * RFC-4180 style delimited parser supporting quoted fields, escaped quotes,
 * embedded newlines inside quotes, BOM stripping, custom delimiters, and comments.
 */
export function parseDelimitedRecords(
	rawInput: string,
	opts: DelimitedParseOptions,
): string[][] {
	const text = rawInput.replace(/^\uFEFF/, '');
	if (!text.trim()) return [];

	const delimiter = opts.delimiter || ',';
	const quote = opts.quoteChar === undefined ? '"' : opts.quoteChar;
	const rows: string[][] = [];
	let currentRow: string[] = [];
	let currentField = '';
	let inQuotes = false;
	let fieldStartedWithQuote = false;

	const pushField = () => {
		const val =
			opts.trimValues && !fieldStartedWithQuote ? currentField.trim() : currentField;
		currentRow.push(opts.trimValues ? val.trim() : val);
		currentField = '';
		fieldStartedWithQuote = false;
	};

	const pushRow = () => {
		const isEmpty = currentRow.every((cell) => cell.trim() === '');
		if (opts.skipEmptyLines !== false && isEmpty) {
			currentRow = [];
			return;
		}
		if (
			opts.commentPrefix &&
			currentRow.length > 0 &&
			currentRow[0].trimStart().startsWith(opts.commentPrefix)
		) {
			currentRow = [];
			return;
		}
		rows.push(currentRow);
		currentRow = [];
	};

	let i = 0;
	while (i < text.length) {
		const ch = text[i];

		if (inQuotes) {
			if (quote && ch === quote) {
				if (text[i + 1] === quote) {
					currentField += quote;
					i += 2;
					continue;
				}
				inQuotes = false;
				i += 1;
				continue;
			}
			currentField += ch;
			i += 1;
			continue;
		}

		// Start quote at beginning of field (ignoring leading spaces if trimValues)
		if (
			quote &&
			ch === quote &&
			(currentField === '' || (opts.trimValues && currentField.trim() === ''))
		) {
			currentField = '';
			inQuotes = true;
			fieldStartedWithQuote = true;
			i += 1;
			continue;
		}

		// Multi-char or single-char delimiter match
		if (delimiter.length > 0 && text.startsWith(delimiter, i)) {
			pushField();
			i += delimiter.length;
			continue;
		}

		if (ch === '\r') {
			if (text[i + 1] === '\n') i += 1;
			pushField();
			pushRow();
			i += 1;
			continue;
		}

		if (ch === '\n') {
			pushField();
			pushRow();
			i += 1;
			continue;
		}

		currentField += ch;
		i += 1;
	}

	if (inQuotes) {
		throw new Error('Unterminated quoted field in delimited input');
	}

	if (currentField.length > 0 || currentRow.length > 0) {
		pushField();
		pushRow();
	}

	return rows;
}

function buildUniqueHeaders(rawHeaders: string[]): string[] {
	const seen = new Map<string, number>();
	return rawHeaders.map((h, idx) => {
		const base = String(h ?? '').trim() || `col_${idx}`;
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		return count === 1 ? base : `${base}_${count}`;
	});
}

function parseCustomHeaderList(customHeaders?: string): string[] {
	if (!customHeaders || !customHeaders.trim()) return [];
	return customHeaders
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

export function recordsToParsedRows(
	records: string[][],
	opts: {
		hasHeader: boolean;
		customHeaders?: string;
		itemIndex: number;
		startingRowIndex?: number;
	},
): SourceParseResult {
	const rows: ParsedSourceRow[] = [];
	const errors: ParseErrorRecord[] = [];
	const baseIdx = opts.startingRowIndex ?? 0;

	if (records.length === 0) {
		return { rows, errors };
	}

	const customList = parseCustomHeaderList(opts.customHeaders);
	let headers: string[] = [];
	let dataStart = 0;

	if (opts.hasHeader) {
		headers = buildUniqueHeaders(records[0]);
		dataStart = 1;
	} else if (customList.length > 0) {
		headers = buildUniqueHeaders(customList);
		dataStart = 0;
	}

	for (let r = dataStart; r < records.length; r++) {
		const cells = records[r];
		const rowIndex = baseIdx + (opts.hasHeader ? r - 1 : r);
		const obj: Record<string, unknown> = {};

		if (headers.length > 0) {
			for (let c = 0; c < headers.length; c++) {
				obj[headers[c]] = c < cells.length ? cells[c] : undefined;
			}
			// Preserve extra trailing columns if present
			for (let c = headers.length; c < cells.length; c++) {
				obj[`col_${c}`] = cells[c];
			}
		} else {
			for (let c = 0; c < cells.length; c++) {
				obj[`col_${c}`] = cells[c];
			}
		}

		rows.push({
			rowIndex,
			itemIndex: opts.itemIndex,
			data: obj,
			positionalValues: cells,
		});
	}

	return { rows, errors };
}

export function parseCsvString(
	csvText: string,
	opts: {
		delimiter?: string;
		hasHeader?: boolean;
		customHeaders?: string;
		quoteChar?: string;
		trimValues?: boolean;
		skipEmptyLines?: boolean;
		commentPrefix?: string;
		itemIndex: number;
		startingRowIndex?: number;
	},
): SourceParseResult {
	try {
		const delimiter = resolveDelimiterChar(opts.delimiter || ',');
		const records = parseDelimitedRecords(csvText, {
			delimiter,
			hasHeader: opts.hasHeader !== false,
			customHeaders: opts.customHeaders,
			quoteChar: opts.quoteChar === undefined ? '"' : opts.quoteChar,
			trimValues: opts.trimValues !== false,
			skipEmptyLines: opts.skipEmptyLines !== false,
			commentPrefix: opts.commentPrefix,
		});
		return recordsToParsedRows(records, {
			hasHeader: opts.hasHeader !== false,
			customHeaders: opts.customHeaders,
			itemIndex: opts.itemIndex,
			startingRowIndex: opts.startingRowIndex,
		});
	} catch (err: any) {
		return {
			rows: [],
			errors: [
				{
					rowIndex: opts.startingRowIndex ?? 0,
					itemIndex: opts.itemIndex,
					stage: 'source_parse',
					errorCode: 'PARSE_ERROR',
					message: `CSV parse failed: ${err?.message || String(err)}`,
					rawInput: csvText.slice(0, 500),
				},
			],
		};
	}
}

export function resolveDelimiterChar(raw: string): string {
	switch (raw) {
		case '\\t':
		case 'tab':
			return '\t';
		case 'pipe':
			return '|';
		case 'comma':
			return ',';
		case 'semicolon':
			return ';';
		default:
			return raw;
	}
}

export function parseJsonPayload(
	input: unknown,
	opts: {
		jsonRootPath?: string;
		itemIndex: number;
		startingRowIndex?: number;
	},
): SourceParseResult {
	const baseIdx = opts.startingRowIndex ?? 0;
	let parsed: unknown = input;

	if (typeof input === 'string') {
		const trimmed = input.replace(/^\uFEFF/, '').trim();
		if (!trimmed) {
			return { rows: [], errors: [] };
		}
		try {
			parsed = JSON.parse(trimmed);
		} catch (firstErr: any) {
			// Support NDJSON (newline-delimited JSON objects)
			const lines = trimmed
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter(Boolean);
			if (lines.length > 1) {
				const rows: ParsedSourceRow[] = [];
				const errors: ParseErrorRecord[] = [];
				for (let i = 0; i < lines.length; i++) {
					try {
						const obj = JSON.parse(lines[i]);
						if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
							rows.push({
								rowIndex: baseIdx + i,
								itemIndex: opts.itemIndex,
								data: obj as Record<string, unknown>,
								positionalValues: Object.values(obj as Record<string, unknown>),
							});
						} else {
							errors.push({
								rowIndex: baseIdx + i,
								itemIndex: opts.itemIndex,
								stage: 'source_parse',
								errorCode: 'PARSE_ERROR',
								message: `NDJSON line ${i + 1} must be a JSON object`,
								rawInput: lines[i],
							});
						}
					} catch (lineErr: any) {
						errors.push({
							rowIndex: baseIdx + i,
							itemIndex: opts.itemIndex,
							stage: 'source_parse',
							errorCode: 'PARSE_ERROR',
							message: `Invalid JSON at line ${i + 1}: ${lineErr?.message || lineErr}`,
							rawInput: lines[i],
						});
					}
				}
				return { rows, errors };
			}

			return {
				rows: [],
				errors: [
					{
						rowIndex: baseIdx,
						itemIndex: opts.itemIndex,
						stage: 'source_parse',
						errorCode: 'PARSE_ERROR',
						message: `Invalid JSON: ${firstErr?.message || String(firstErr)}`,
						rawInput: trimmed.slice(0, 500),
					},
				],
			};
		}
	}

	if (opts.jsonRootPath && opts.jsonRootPath.trim()) {
		parsed = resolveDotBracketPath(parsed, opts.jsonRootPath);
		if (parsed === undefined) {
			return {
				rows: [],
				errors: [
					{
						rowIndex: baseIdx,
						itemIndex: opts.itemIndex,
						stage: 'source_parse',
						errorCode: 'PARSE_ERROR',
						message: `JSON root path "${opts.jsonRootPath}" resolved to undefined`,
						rawInput: input,
					},
				],
			};
		}
	}

	const list = Array.isArray(parsed) ? parsed : [parsed];
	const rows: ParsedSourceRow[] = [];
	const errors: ParseErrorRecord[] = [];

	for (let i = 0; i < list.length; i++) {
		const entry = list[i];
		if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
			const record = entry as Record<string, unknown>;
			rows.push({
				rowIndex: baseIdx + i,
				itemIndex: opts.itemIndex,
				data: record,
				positionalValues: Object.values(record),
			});
		} else {
			errors.push({
				rowIndex: baseIdx + i,
				itemIndex: opts.itemIndex,
				stage: 'source_parse',
				errorCode: 'PARSE_ERROR',
				message: `Expected JSON object at row ${i}, received ${Array.isArray(entry) ? 'array' : typeof entry}`,
				rawInput: entry,
			});
		}
	}

	return { rows, errors };
}

interface FixedWidthSlice {
	name: string;
	start: number;
	end: number;
}

function parseFixedWidthSpec(spec: string): FixedWidthSlice[] {
	const parts = spec
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (parts.length === 0) {
		throw new Error('Fixed-width specification is empty. Example: id:0-5,name:5-25');
	}

	const slices: FixedWidthSlice[] = [];
	let cursor = 0;

	for (const part of parts) {
		const colonIdx = part.indexOf(':');
		if (colonIdx <= 0) {
			throw new Error(`Invalid fixed-width field "${part}". Use name:start-end or name:width.`);
		}
		const name = part.slice(0, colonIdx).trim();
		const range = part.slice(colonIdx + 1).trim();
		if (range.includes('-')) {
			const [sRaw, eRaw] = range.split('-');
			const start = Number(sRaw);
			const end = Number(eRaw);
			if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
				throw new Error(`Invalid fixed-width range "${range}" for column "${name}".`);
			}
			slices.push({ name, start, end });
			cursor = end;
		} else {
			const width = Number(range);
			if (!Number.isInteger(width) || width <= 0) {
				throw new Error(`Invalid fixed-width length "${range}" for column "${name}".`);
			}
			slices.push({ name, start: cursor, end: cursor + width });
			cursor += width;
		}
	}

	return slices;
}

function parseKeyValueLine(
	line: string,
	pairDelimiterRegex: RegExp,
	kvSeparator: string,
	trimValues: boolean,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const tokens: string[] = [];
	let current = '';
	let inQuote: string | null = null;

	// If pair separator is whitespace, split safely respecting quotes
	const isWhitespaceSep = pairDelimiterRegex.source === '\\s+';
	if (isWhitespaceSep) {
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (inQuote) {
				if (ch === inQuote && line[i - 1] !== '\\') {
					inQuote = null;
				} else {
					current += ch;
				}
			} else if (ch === '"' || ch === "'") {
				inQuote = ch;
			} else if (/\s/.test(ch)) {
				if (current) {
					tokens.push(current);
					current = '';
				}
			} else {
				current += ch;
			}
		}
		if (current) tokens.push(current);
	} else {
		tokens.push(...line.split(pairDelimiterRegex));
	}

	let foundPairs = 0;
	for (const token of tokens) {
		const trimmed = token.trim();
		if (!trimmed) continue;
		const sepIdx = trimmed.indexOf(kvSeparator);
		if (sepIdx <= 0) {
			throw new Error(`Invalid key-value token "${trimmed}" (missing "${kvSeparator}")`);
		}
		const key = trimmed.slice(0, sepIdx).trim();
		let val = trimmed.slice(sepIdx + kvSeparator.length);
		if (trimValues) val = val.trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		out[key] = val;
		foundPairs++;
	}

	if (foundPairs === 0) {
		throw new Error('No key-value pairs found on line');
	}
	return out;
}

export function parseTextPayload(
	text: string,
	opts: {
		textFormat: TextParseFormat;
		customDelimiter?: string;
		hasHeader?: boolean;
		customHeaders?: string;
		quoteChar?: string;
		trimValues?: boolean;
		skipEmptyLines?: boolean;
		commentPrefix?: string;
		kvPairDelimiter?: string;
		kvSeparator?: string;
		regexPattern?: string;
		fixedWidthSpec?: string;
		failOnUnmatchedLine?: boolean;
		itemIndex: number;
		startingRowIndex?: number;
	},
): SourceParseResult {
	const baseIdx = opts.startingRowIndex ?? 0;
	const cleanText = text.replace(/^\uFEFF/, '');
	const trimValues = opts.trimValues !== false;
	const skipEmptyLines = opts.skipEmptyLines !== false;

	if (
		opts.textFormat === 'pipe' ||
		opts.textFormat === 'tsv' ||
		opts.textFormat === 'customDelimiter'
	) {
		const delimiter =
			opts.textFormat === 'pipe'
				? '|'
				: opts.textFormat === 'tsv'
					? '\t'
					: resolveDelimiterChar(opts.customDelimiter || '|');

		return parseCsvString(cleanText, {
			delimiter,
			hasHeader: opts.hasHeader !== false,
			customHeaders: opts.customHeaders,
			quoteChar: opts.quoteChar === undefined ? '' : opts.quoteChar,
			trimValues,
			skipEmptyLines,
			commentPrefix: opts.commentPrefix,
			itemIndex: opts.itemIndex,
			startingRowIndex: baseIdx,
		});
	}

	const rawLines = cleanText.split(/\r?\n/);
	const lines = rawLines.filter((line) => {
		if (skipEmptyLines && !line.trim()) return false;
		if (opts.commentPrefix && line.trimStart().startsWith(opts.commentPrefix)) return false;
		return true;
	});

	const rows: ParsedSourceRow[] = [];
	const errors: ParseErrorRecord[] = [];

	if (opts.textFormat === 'lines') {
		for (let i = 0; i < lines.length; i++) {
			const val = trimValues ? lines[i].trim() : lines[i];
			rows.push({
				rowIndex: baseIdx + i,
				itemIndex: opts.itemIndex,
				data: { line: val, lineNumber: i + 1 },
				positionalValues: [val, i + 1],
				rawText: lines[i],
			});
		}
		return { rows, errors };
	}

	if (opts.textFormat === 'fixedWidth') {
		let slices: FixedWidthSlice[];
		try {
			slices = parseFixedWidthSpec(opts.fixedWidthSpec || '');
		} catch (err: any) {
			return {
				rows: [],
				errors: [
					{
						rowIndex: baseIdx,
						itemIndex: opts.itemIndex,
						stage: 'source_parse',
						errorCode: 'PARSE_ERROR',
						message: err?.message || String(err),
					},
				],
			};
		}

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const data: Record<string, unknown> = {};
			const positional: unknown[] = [];
			for (const s of slices) {
				const sliceVal = line.slice(s.start, s.end);
				const finalVal = trimValues ? sliceVal.trim() : sliceVal;
				data[s.name] = finalVal;
				positional.push(finalVal);
			}
			rows.push({
				rowIndex: baseIdx + i,
				itemIndex: opts.itemIndex,
				data,
				positionalValues: positional,
				rawText: line,
			});
		}
		return { rows, errors };
	}

	if (opts.textFormat === 'keyValue') {
		const sepRaw = opts.kvPairDelimiter?.trim() || '\\s+';
		const pairRegex =
			sepRaw === '\\s+' || sepRaw === 'space'
				? /\s+/
				: new RegExp(sepRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
		const kvSep = opts.kvSeparator || '=';

		for (let i = 0; i < lines.length; i++) {
			try {
				const data = parseKeyValueLine(lines[i], pairRegex, kvSep, trimValues);
				rows.push({
					rowIndex: baseIdx + i,
					itemIndex: opts.itemIndex,
					data,
					positionalValues: Object.values(data),
					rawText: lines[i],
				});
			} catch (err: any) {
				errors.push({
					rowIndex: baseIdx + i,
					itemIndex: opts.itemIndex,
					stage: 'source_parse',
					errorCode: 'PARSE_ERROR',
					message: `Line ${i + 1}: ${err?.message || String(err)}`,
					rawInput: lines[i],
				});
			}
		}
		return { rows, errors };
	}

	if (opts.textFormat === 'regex') {
		let re: RegExp;
		try {
			if (!opts.regexPattern || !opts.regexPattern.trim()) {
				throw new Error('Regex pattern is required for Regex text format');
			}
			re = new RegExp(opts.regexPattern);
		} catch (err: any) {
			return {
				rows: [],
				errors: [
					{
						rowIndex: baseIdx,
						itemIndex: opts.itemIndex,
						stage: 'source_parse',
						errorCode: 'PARSE_ERROR',
						message: `Invalid regex pattern: ${err?.message || String(err)}`,
					},
				],
			};
		}

		const customHeaders = parseCustomHeaderList(opts.customHeaders);
		for (let i = 0; i < lines.length; i++) {
			const match = re.exec(lines[i]);
			if (!match) {
				if (opts.failOnUnmatchedLine !== false) {
					errors.push({
						rowIndex: baseIdx + i,
						itemIndex: opts.itemIndex,
						stage: 'source_parse',
						errorCode: 'PARSE_ERROR',
						message: `Line ${i + 1} did not match regex pattern`,
						rawInput: lines[i],
					});
				}
				continue;
			}

			const data: Record<string, unknown> = {};
			const positional: unknown[] = [];

			if (match.groups && Object.keys(match.groups).length > 0) {
				for (const [k, v] of Object.entries(match.groups)) {
					const val = trimValues && typeof v === 'string' ? v.trim() : v;
					data[k] = val;
					positional.push(val);
				}
			} else {
				for (let g = 1; g < match.length; g++) {
					const rawVal = match[g];
					const val = trimValues && typeof rawVal === 'string' ? rawVal.trim() : rawVal;
					const colName = customHeaders[g - 1] ?? `group_${g}`;
					data[colName] = val;
					positional.push(val);
				}
			}

			rows.push({
				rowIndex: baseIdx + i,
				itemIndex: opts.itemIndex,
				data,
				positionalValues: positional,
				rawText: lines[i],
			});
		}
		return { rows, errors };
	}

	return { rows, errors };
}

export function coerceBindParameter(
	param: BindingParam,
	allowUnsafeSql: boolean,
): { kind: 'param'; value: unknown } | { kind: 'sql'; expr: string } {
	const raw = param.value;
	switch (param.type) {
		case 'null':
			return { kind: 'param', value: null };
		case 'number': {
			const n = Number(raw);
			if (raw === '' || Number.isNaN(n)) {
				throw new Error(`Invalid number bind parameter: "${raw}"`);
			}
			return { kind: 'param', value: n };
		}
		case 'boolean': {
			const s = String(raw).trim().toLowerCase();
			if (s === 'true' || s === '1' || s === 'yes') return { kind: 'param', value: true };
			if (s === 'false' || s === '0' || s === 'no') return { kind: 'param', value: false };
			throw new Error(`Invalid boolean bind parameter: "${raw}"`);
		}
		case 'date': {
			const d = new Date(raw);
			if (Number.isNaN(d.getTime())) {
				throw new Error(`Invalid date bind parameter: "${raw}"`);
			}
			return { kind: 'param', value: d.toISOString() };
		}
		case 'json': {
			const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
			return {
				kind: 'param',
				value: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
			};
		}
		case 'sql': {
			if (!allowUnsafeSql) {
				throw new Error(
					'SQL Expression bind parameters require "Allow Unsafe SQL" to be enabled.',
				);
			}
			return { kind: 'sql', expr: String(raw) };
		}
		case 'string':
		default:
			return { kind: 'param', value: String(raw ?? '') };
	}
}

export function compileSqlWithBindings(
	sql: string,
	bindings: BindingParam[],
	allowUnsafeSql: boolean,
): { sql: string; params: unknown[] } {
	if (!bindings.length) {
		return { sql, params: [] };
	}
	const placeholderCount = countSqlPlaceholders(sql);
	if (placeholderCount !== bindings.length) {
		throw new Error(
			`Raw SQL query has ${placeholderCount} "?" placeholder(s), but ${bindings.length} bind parameter(s) were supplied.`,
		);
	}

	const coerced = bindings.map((b) => coerceBindParameter(b, allowUnsafeSql));
	const params: unknown[] = [];
	const reading = sqlReadingsFor(sql)[0] ?? {};
	let idx = 0;
	let out = '';

	for (const token of sqlTokens(sql, reading)) {
		const raw = sql.slice(token.start, token.end);
		if (token.kind === 'punct' && raw === '?') {
			const item = coerced[idx++];
			if (item.kind === 'sql') {
				out += item.expr;
			} else {
				out += '?';
				params.push(item.value);
			}
		} else {
			out += raw;
		}
	}

	return { sql: out, params };
}

export async function executeRawQuerySource(opts: {
	ctx?: IExecuteFunctions;
	node: INode;
	targetCredentials: Record<string, any>;
	sourceCredential?: Record<string, any>;
	connectionMode: RawQueryConnectionMode;
	inlineConnection?: InlineConnectionConfig;
	sql: string;
	bindings?: BindingParam[];
	allowUnsafeSql?: boolean;
	dataPath?: string;
	timeoutMs?: number;
	itemIndex: number;
	startingRowIndex?: number;
}): Promise<SourceParseResult> {
	const rawSql = String(opts.sql ?? '').trim();
	if (!rawSql) {
		return {
			rows: [],
			errors: [
				{
					rowIndex: opts.startingRowIndex ?? 0,
					itemIndex: opts.itemIndex,
					stage: 'source_parse',
					errorCode: 'PARSE_ERROR',
					message: 'Raw SQL query is empty',
				},
			],
		};
	}

	let credConfig: Record<string, any>;
	if (opts.connectionMode === 'sameAsTarget') {
		credConfig = opts.targetCredentials;
	} else if (opts.connectionMode === 'separateCredential') {
		if (!opts.sourceCredential) {
			throw new Error('Source Database credential is required for Separate Source Credential mode');
		}
		credConfig = opts.sourceCredential;
	} else {
		credConfig = (opts.inlineConnection ?? {}) as Record<string, any>;
	}

	const resolved = toResolvedConnection(credConfig, opts.timeoutMs, 'source', opts.node);
	const handle = await openManagedHandle(resolved, opts.node);

	try {
		const compiled = compileSqlWithBindings(
			rawSql,
			opts.bindings ?? [],
			Boolean(opts.allowUnsafeSql),
		);
		const rawResult = await withTimeout(
			handle.query(compiled.sql, compiled.params),
			opts.timeoutMs ?? 15000,
			'Source Raw SQL Query',
			opts.node,
		);

		let extracted: unknown = rawResult;
		if (opts.dataPath && opts.dataPath.trim()) {
			extracted = resolveDotBracketPath(rawResult, opts.dataPath);
		}

		const list = Array.isArray(extracted) ? extracted : extracted === undefined ? [] : [extracted];
		const baseIdx = opts.startingRowIndex ?? 0;
		const rows: ParsedSourceRow[] = [];
		const errors: ParseErrorRecord[] = [];

		for (let i = 0; i < list.length; i++) {
			const entry = list[i];
			if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
				const obj = entry as Record<string, unknown>;
				rows.push({
					rowIndex: baseIdx + i,
					itemIndex: opts.itemIndex,
					data: obj,
					positionalValues: Object.values(obj),
				});
			} else {
				errors.push({
					rowIndex: baseIdx + i,
					itemIndex: opts.itemIndex,
					stage: 'source_parse',
					errorCode: 'PARSE_ERROR',
					message: `Source query row ${i} is not an object`,
					rawInput: entry,
				});
			}
		}

		return { rows, errors };
	} finally {
		await handle.close();
	}
}
