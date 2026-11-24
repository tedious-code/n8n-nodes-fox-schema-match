import {
	NodeOperationError,
	type FieldType,
	type ILoadOptionsFunctions,
	type INodeListSearchResult,
	type INodePropertyOptions,
	type ResourceMapperField,
	type ResourceMapperFields,
} from 'n8n-workflow';
import { loadTableSchemas } from './dbConnection';
import type { FoxTableSchema } from './foxSchema';
import { resolveDialect, resolveSchema } from './sqlHelpers';

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

const objectCache = new Map<string, CacheEntry<FoxTableSchema[]>>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const TABLE_LIKE = new Set(['TABLE', 'VIEW', 'MQT']);

function cacheKey(credentials: Record<string, unknown>): string {
	return [
		resolveDialect(credentials.dialect),
		resolveSchema(credentials as any),
		String(credentials.host ?? ''),
		String(credentials.database ?? ''),
		String(credentials.username ?? ''),
	].join('|');
}

export async function loadCachedTables(
	this: ILoadOptionsFunctions,
): Promise<FoxTableSchema[]> {
	const credentials = await this.getCredentials('foxSchemaMatchDbApi');
	const key = cacheKey(credentials as Record<string, unknown>);
	const cached = objectCache.get(key);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.value;
	}
	const objects = await loadTableSchemas(credentials);
	objectCache.set(key, {
		value: objects,
		expiresAt: Date.now() + CACHE_TTL_MS,
	});
	return objects;
}

export function resolveLocatorValue(param: unknown): string {
	if (typeof param === 'object' && param && 'value' in (param as any)) {
		return String((param as any).value ?? '').trim();
	}
	return String(param ?? '').trim();
}

export async function searchTargetTables(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const offset = paginationToken ? parseInt(paginationToken, 10) : 0;
	let objects: FoxTableSchema[];
	try {
		objects = await loadCachedTables.call(this);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new NodeOperationError(
			this.getNode(),
			`FoxSchema catalog lookup failed: ${message}`,
		);
	}

	const search = filter?.trim().toLowerCase();
	const allResults = objects
		.filter((o) => TABLE_LIKE.has(o.objectType))
		.filter((o) => !search || o.name.toLowerCase().includes(search))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((o) => ({
			name: `[${o.objectType || 'TABLE'}] ${o.name}`,
			value: o.name,
			description: o.objectType,
		}));

	const results = allResults.slice(offset, offset + 500);
	return {
		results,
		paginationToken:
			offset + 500 < allResults.length ? String(offset + 500) : undefined,
	};
}

export async function getTargetColumns(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const rawTable = resolveLocatorValue(this.getNodeParameter('tableId', false));
	const tableName = rawTable.includes('.') ? rawTable.split('.').pop()! : rawTable;
	if (!tableName) return [];

	let objects: FoxTableSchema[];
	try {
		objects = await loadCachedTables.call(this);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new NodeOperationError(
			this.getNode(),
			`FoxSchema column lookup failed: ${message}`,
		);
	}

	const obj = objects.find(
		(o) =>
			TABLE_LIKE.has(o.objectType) &&
			o.name.toUpperCase() === tableName.toUpperCase(),
	);
	if (!obj) return [];

	return (obj.columns ?? []).map((col) => {
		const pk = col.primaryKey ? 'PK ' : '';
		const nullable = col.nullable === false ? 'NOT NULL' : 'NULL';
		const def = col.defaultValue ? ` DEFAULT ${col.defaultValue}` : '';
		return {
			name: `${col.name} | ${pk}${col.type} | ${nullable}${def}`,
			value: col.name,
			description: `${pk}${col.type} (${nullable})`,
		};
	});
}

function mapFoxTypeToFieldType(rawType: string): FieldType {
	const t = String(rawType ?? '').toUpperCase();
	if (/BOOL|BIT/.test(t)) return 'boolean';
	if (/INT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|NUMBER|MONEY|SERIAL|DEC|FIXED/.test(t)) {
		return 'number';
	}
	if (/DATE|TIME|TIMESTAMP|DATETIME/.test(t)) return 'dateTime';
	if (/JSON|JSONB/.test(t)) return 'object';
	return 'string';
}

export async function getMappingColumns(
	this: ILoadOptionsFunctions,
): Promise<ResourceMapperFields> {
	const rawTable = resolveLocatorValue(this.getNodeParameter('tableId', false));
	const tableName = rawTable.includes('.') ? rawTable.split('.').pop()! : rawTable;
	if (!tableName) {
		return { fields: [] };
	}

	const operation = String(this.getNodeParameter('operation', 'insert') ?? 'insert');

	let objects: FoxTableSchema[];
	try {
		objects = await loadCachedTables.call(this);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new NodeOperationError(
			this.getNode(),
			`FoxSchema mapping columns lookup failed: ${message}`,
		);
	}

	const obj = objects.find(
		(o) =>
			TABLE_LIKE.has(o.objectType) &&
			o.name.toUpperCase() === tableName.toUpperCase(),
	);
	if (!obj) {
		return { fields: [] };
	}

	const pkSet = new Set(
		(obj.primaryKey?.columns ?? []).map((c) => c.toUpperCase()),
	);

	const fields: ResourceMapperField[] = (obj.columns ?? []).map((col) => {
		const isPk = Boolean(col.primaryKey) || pkSet.has(col.name.toUpperCase());
		const isAutoGenInsert = operation === 'insert' && Boolean(col.identity);
		const isRequiredInsert =
			operation === 'insert' &&
			col.nullable === false &&
			!col.identity &&
			col.defaultValue === undefined;

		return {
			id: col.name,
			displayName: col.name,
			defaultMatch: isPk,
			canBeUsedToMatch: true,
			required: operation === 'insert' ? isRequiredInsert : isPk,
			display: true,
			type: mapFoxTypeToFieldType(col.type),
			removed: isAutoGenInsert,
		};
	});

	return { fields };
}
