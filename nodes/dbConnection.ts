import {
	NodeOperationError,
	sleep,
	type ICredentialDataDecryptedObject,
	type INode,
} from 'n8n-workflow';
import {
	ConnectionFactory,
	dialectSupportsTransactionalRollback,
	getAdapter,
	getRegisteredProvider,
	type FoxTableSchema,
} from './foxSchema';
import {
	defaultPort,
	resolveDialect,
	resolveSchemaFromConfig,
	rewritePlaceholders,
} from './sqlHelpers';
import { isFileDialect, type SupportedDialect } from './supportedDialects';
import type { ResolvedConnection } from './types';

export function toResolvedConnection(
	config: Record<string, any>,
	timeoutMs?: number,
	labelOverride?: string,
	node?: INode,
): ResolvedConnection {
	const dialect = resolveDialect(config.dialect);
	const connectionString = String(config.connectionString ?? '').trim();
	const database = String(config.database ?? '').trim();

	if (isFileDialect(dialect) && !database && !connectionString) {
		const msg = `Dialect "${dialect}" needs a database file path (for example /data/app.db) or connectionString.`;
		if (node) {
			throw new NodeOperationError(node, msg);
		}
		throw new Error(msg);
	}

	const options: Record<string, unknown> = {
		database,
		username: String(config.username ?? ''),
		password: String(config.password ?? ''),
		schema: resolveSchemaFromConfig(config, dialect),
	};

	if (connectionString) {
		options.connectionString = connectionString;
	}

	if (!isFileDialect(dialect)) {
		options.host = String(config.host ?? 'localhost');
		options.port = Number(config.port || defaultPort(dialect));
		options.ssl = {
			enabled: Boolean(config.useSsl) || dialect === 'azuresql',
			rejectUnauthorized: config.rejectUnauthorized !== false,
		};
	}

	if (timeoutMs !== undefined && timeoutMs > 0) {
		options.timeout = {
			connectMs: timeoutMs,
			queryMs: timeoutMs,
		};
	}

	const label =
		labelOverride ||
		(isFileDialect(dialect)
			? `${dialect}:${database || connectionString}`
			: `${dialect}:${options.host}:${options.port}/${database}`);

	return {
		dialect,
		label,
		options,
	};
}

export interface ManagedDbHandle {
	dialect: SupportedDialect;
	schema: string;
	query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
	beginTransaction: () => Promise<void>;
	commitTransaction: () => Promise<void>;
	rollbackTransaction: () => Promise<void>;
	supportsTransaction: boolean;
	close: () => Promise<void>;
}

export async function openManagedHandle(
	resolved: ResolvedConnection,
	node: INode,
	opts: { pooled?: boolean } = {},
): Promise<ManagedDbHandle> {
	const { dialect, options } = resolved;
	const connection = await ConnectionFactory.create(dialect, options, opts);
	const adapter = getAdapter(dialect);
	let inTransaction = false;
	let closed = false;

	return {
		dialect,
		schema: String(options.schema ?? ''),
		supportsTransaction: Boolean(dialectSupportsTransactionalRollback(dialect)),
		async query(sql: string, params: unknown[] = []) {
			if (closed) {
				throw new NodeOperationError(
					node,
					`This ${dialect} connection is already closed.`,
				);
			}
			const rewritten = rewritePlaceholders(dialect, sql);
			const rows = ((await adapter.query(connection, rewritten, params)) ??
				[]) as Record<string, unknown>[];
			if (dialect === 'oracle' && !inTransaction) {
				await adapter.commitTransaction(connection);
			}
			return rows;
		},
		async beginTransaction() {
			if (!dialectSupportsTransactionalRollback(dialect)) {
				throw new NodeOperationError(
					node,
					`Dialect "${dialect}" does not support transactional rollback.`,
				);
			}
			inTransaction = true;
			await adapter.beginTransaction(connection);
		},
		async commitTransaction() {
			await adapter.commitTransaction(connection);
			inTransaction = false;
		},
		async rollbackTransaction() {
			try {
				await adapter.rollbackTransaction(connection);
			} finally {
				inTransaction = false;
			}
		},
		async close() {
			if (closed) return;
			closed = true;
			await ConnectionFactory.close(dialect, connection);
		},
	};
}

export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
	node: INode,
	onTimeout?: () => void,
): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return promise;
	}

	const controller = new AbortController();
	const timeoutPromise = sleep(timeoutMs, controller.signal).then(() => {
		try {
			onTimeout?.();
		} catch {
			// Ignore cleanup errors during timeout rejection
		}
		throw new NodeOperationError(node, `${label} timed out after ${timeoutMs}ms`);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		controller.abort();
		await timeoutPromise.catch(() => undefined);
	}
}

export async function testDbConnection(
	credentials: ICredentialDataDecryptedObject,
): Promise<{ ok: true } | { ok: false; message: string }> {
	try {
		const resolved = toResolvedConnection(credentials);
		const provider = getRegisteredProvider(resolved.dialect);
		await provider.testConnection(resolved.options);
		return { ok: true };
	} catch (err: any) {
		return { ok: false, message: err?.message || String(err) };
	}
}

export async function loadTableSchemas(
	credentials: ICredentialDataDecryptedObject,
): Promise<FoxTableSchema[]> {
	const resolved = toResolvedConnection(credentials);
	const provider = getRegisteredProvider(resolved.dialect);
	if (!provider.getTables) {
		throw new Error(`Provider "${resolved.dialect}" does not support getTables()`);
	}
	return provider.getTables(resolved.options, String(resolved.options.schema ?? ''));
}
