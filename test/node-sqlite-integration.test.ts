import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { IExecuteFunctions, INode, INodeExecutionData } from 'n8n-workflow';
import {
	FoxSchemaMatch,
	configuredOutputs,
} from '../nodes/FoxSchemaMatch/FoxSchemaMatch.node.ts';
import { ConnectionFactory } from '../nodes/foxSchema';

function setupTempDb() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fox-schema-match-'));
	const targetDbPath = path.join(dir, 'target.db');
	const sourceDbPath = path.join(dir, 'source.db');

	const tdb = new Database(targetDbPath);
	tdb.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			first_name TEXT NOT NULL,
			email TEXT NOT NULL UNIQUE,
			age INTEGER,
			active INTEGER NOT NULL DEFAULT 1
		);
		INSERT INTO users (id, first_name, email, age, active)
		VALUES (1, 'Alice', 'alice@example.com', 30, 1);
	`);
	tdb.close();

	const sdb = new Database(sourceDbPath);
	sdb.exec(`
		CREATE TABLE staging_users (
			uid INTEGER PRIMARY KEY,
			full_name TEXT NOT NULL,
			mail TEXT NOT NULL,
			years INTEGER,
			is_enabled INTEGER NOT NULL
		);
		INSERT INTO staging_users (uid, full_name, mail, years, is_enabled)
		VALUES
			(1, 'Alice Updated', 'alice@example.com', 31, 1),
			(2, 'Bob New', 'bob@example.com', 25, 1),
			(3, 'Inactive User', 'inactive@example.com', 40, 0);
	`);
	sdb.close();

	return { dir, targetDbPath, sourceDbPath };
}

function getParam(obj: Record<string, any>, pathStr: string, fallback?: any) {
	const parts = pathStr.split('.');
	let cur: any = obj;
	for (const p of parts) {
		if (cur === undefined || cur === null) return fallback;
		cur = cur[p];
	}
	return cur === undefined ? fallback : cur;
}

const TEST_NODE: INode = {
	id: 'test-match-node',
	name: 'Fox Schema Match',
	type: 'n8n-nodes-fox-schema-match.foxSchemaMatch',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

function createMockExecuteContext(opts: {
	inputItems?: INodeExecutionData[];
	params: Record<string, any>;
	targetDbPath: string;
	continueOnFail?: boolean;
}): IExecuteFunctions {
	const inputItems = opts.inputItems ?? [{ json: {} }];
	return {
		getInputData: () => inputItems,
		getNodeParameter: (name: string, _itemIndex: number, fallback?: any) =>
			getParam(opts.params, name, fallback),
		getCredentials: async (credName: string) => {
			if (credName === 'foxSchemaMatchDbApi') {
				return { dialect: 'sqlite', database: opts.targetDbPath };
			}
			throw new Error(`Credential ${credName} not configured`);
		},
		continueOnFail: () => opts.continueOnFail === true,
		getNode: () => TEST_NODE,
		helpers: {
			getBinaryDataBuffer: async () => {
				throw new Error('Binary not mocked in this test');
			},
		},
	} as unknown as IExecuteFunctions;
}

test.after(async () => {
	await ConnectionFactory.closeAll();
});

test('configuredOutputs exposes 2 outputs for error routing modes and 1 otherwise', () => {
	assert.equal(configuredOutputs({ errorHandlerMode: 'routeToErrorOutput' }).length, 2);
	assert.equal(configuredOutputs({ errorHandlerMode: 'rollbackAndRouteToError' }).length, 2);
	assert.equal(configuredOutputs({ errorHandlerMode: 'skipAndLog' }).length, 1);
	assert.equal(configuredOutputs({ errorHandlerMode: 'throwError' }).length, 1);
});

test('JSON incoming items -> Upsert with normalized auto-match and primary key detection', async () => {
	const { dir, targetDbPath } = setupTempDb();
	try {
		const node = new FoxSchemaMatch();
		const ctx = createMockExecuteContext({
			targetDbPath,
			inputItems: [
				{ json: { id: 1, firstName: 'Alice Prime', email: 'alice@example.com', age: 32 } },
				{ json: { id: 2, firstName: 'Bob', email: 'bob@example.com', age: 27, ignoredCol: 'x' } },
			],
			params: {
				operation: 'upsert',
				tableId: { mode: 'list', value: 'users' },
				dataSource: 'json',
				jsonInputMode: 'incomingItems',
				mappingMode: 'auto',
				matchRule: 'normalized',
				unmatchedSourceBehavior: 'ignore',
				errorHandlerMode: 'routeToErrorOutput',
				outputMode: 'summaryWithRows',
			},
		});

		const outputs = await node.execute.call(ctx);
		assert.equal(outputs.length, 2);
		assert.equal(outputs[1].length, 0);
		assert.equal(outputs[0][0].json.upsertedCount, 2);

		const db = new Database(targetDbPath, { readonly: true });
		const rows = db.prepare('SELECT id, first_name, email, age FROM users ORDER BY id').all() as any[];
		db.close();
		assert.equal(rows.length, 2);
		assert.equal(rows[0].first_name, 'Alice Prime');
		assert.equal(rows[0].age, 32);
		assert.equal(rows[1].first_name, 'Bob');
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('CSV input -> Upsert into SQLite', async () => {
	const { dir, targetDbPath } = setupTempDb();
	try {
		const node = new FoxSchemaMatch();
		const ctx = createMockExecuteContext({
			targetDbPath,
			params: {
				operation: 'upsert',
				tableId: { mode: 'name', value: 'users' },
				dataSource: 'csv',
				csvInputMode: 'textContent',
				csvText: 'id,first_name,email,age\n1,Alice CSV,alice@example.com,35\n5,Cara,cara@example.com,22',
				csvDelimiter: ',',
				hasHeader: true,
				mappingMode: 'auto',
				matchRule: 'caseInsensitive',
				errorHandlerMode: 'routeToErrorOutput',
				outputMode: 'summaryWithRows',
			},
		});

		const [matched, errors] = await node.execute.call(ctx);
		assert.equal(errors.length, 0);
		assert.equal(matched[0].json.upsertedCount, 2);

		const db = new Database(targetDbPath, { readonly: true });
		const row5 = db.prepare('SELECT first_name, age FROM users WHERE id = 5').get() as any;
		db.close();
		assert.equal(row5.first_name, 'Cara');
		assert.equal(row5.age, 22);
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('Pipe-delimited Text -> Update with requireMatchedRow error handler', async () => {
	const { dir, targetDbPath } = setupTempDb();
	try {
		const node = new FoxSchemaMatch();
		const ctx = createMockExecuteContext({
			targetDbPath,
			params: {
				operation: 'update',
				tableId: { mode: 'list', value: 'users' },
				dataSource: 'text',
				textInputMode: 'textContent',
				textFormat: 'pipe',
				textContent: 'id|first_name|age\n1|Alice Text|44\n999|Missing User|50',
				hasHeader: true,
				mappingMode: 'auto',
				matchKeyColumns: 'id',
				errorHandlerMode: 'routeToErrorOutput',
				errorHandlerOptions: {
					requireMatchedRow: true,
				},
				outputMode: 'rowByRow',
			},
		});

		const [matched, errors] = await node.execute.call(ctx);
		assert.equal(matched.length, 1);
		assert.equal((matched[0].json.data as any).first_name, 'Alice Text');
		assert.equal(errors.length, 1);
		assert.equal(errors[0].json.errorCode, 'ROW_NOT_FOUND');
		assert.equal(errors[0].json.rowIndex, 1);
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('Raw SQL Query from inline source DB -> Manual Column Mapping -> Upsert to target DB', async () => {
	const { dir, targetDbPath, sourceDbPath } = setupTempDb();
	try {
		const node = new FoxSchemaMatch();
		const ctx = createMockExecuteContext({
			targetDbPath,
			params: {
				operation: 'upsert',
				tableId: { mode: 'list', value: 'users' },
				dataSource: 'rawQuery',
				rawQueryConnectionMode: 'inline',
				sourceInlineDialect: 'sqlite',
				sourceInlineDatabase: sourceDbPath,
				rawSql: 'SELECT uid, full_name, mail, years FROM staging_users WHERE is_enabled = ?',
				rawQueryBindings: {
					parameterValues: [{ type: 'number', value: '1' }],
				},
				mappingMode: 'manual',
				manualMappings: {
					mappingValues: [
						{ sourceField: 'uid', targetColumn: 'id' },
						{ sourceField: 'full_name', targetColumn: 'first_name', transform: 'trim' },
						{ sourceField: 'mail', targetColumn: 'email', transform: 'lowercase' },
						{ sourceField: 'years', targetColumn: 'age' },
					],
				},
				errorHandlerMode: 'routeToErrorOutput',
				outputMode: 'summaryWithRows',
			},
		});

		const [matched, errors] = await node.execute.call(ctx);
		assert.equal(errors.length, 0);
		assert.equal(matched[0].json.upsertedCount, 2);

		const db = new Database(targetDbPath, { readonly: true });
		const rows = db.prepare('SELECT id, first_name FROM users ORDER BY id').all() as any[];
		db.close();
		assert.deepEqual(rows, [
			{ id: 1, first_name: 'Alice Updated' },
			{ id: 2, first_name: 'Bob New' },
		]);
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('Error Handler isolates failing batch rows (type coercion + DB UNIQUE constraint) to Error output', async () => {
	const { dir, targetDbPath } = setupTempDb();
	try {
		const node = new FoxSchemaMatch();
		const ctx = createMockExecuteContext({
			targetDbPath,
			inputItems: [
				{ json: { id: 10, first_name: 'Valid Ten', email: 'ten@example.com', age: 20 } },
				{ json: { id: 11, first_name: 'Bad Age', email: 'badage@example.com', age: 'not-int' } },
				{ json: { id: 12, first_name: 'Dup Email', email: 'alice@example.com', age: 28 } },
				{ json: { id: 13, first_name: 'Valid Thirteen', email: 'thirteen@example.com', age: 33 } },
			],
			params: {
				operation: 'insert',
				tableId: { mode: 'list', value: 'users' },
				dataSource: 'json',
				jsonInputMode: 'incomingItems',
				mappingMode: 'auto',
				errorHandlerMode: 'routeToErrorOutput',
				errorHandlerOptions: {
					isolateFailedBatchRows: true,
					strictTypeValidation: true,
				},
				outputMode: 'summaryWithRows',
			},
		});

		const [matched, errors] = await node.execute.call(ctx);
		assert.equal(matched[0].json.insertedCount, 2);
		assert.equal(errors.length, 2);
		assert.equal(errors[0].json.errorCode, 'TYPE_COERCION');
		assert.equal(errors[0].json.rowIndex, 1);
		assert.equal(errors[1].json.errorCode, 'DB_ERROR');
		assert.equal(errors[1].json.rowIndex, 2);

		const db = new Database(targetDbPath, { readonly: true });
		const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c;
		db.close();
		assert.equal(count, 3); // 1 initial + 2 valid inserts
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('Error Handler rollbackAndRouteToError rolls back entire batch on DB failure', async () => {
	const { dir, targetDbPath } = setupTempDb();
	try {
		const node = new FoxSchemaMatch();
		const ctx = createMockExecuteContext({
			targetDbPath,
			inputItems: [
				{ json: { id: 20, first_name: 'Would Rollback', email: 'tx@example.com', age: 20 } },
				{ json: { id: 21, first_name: 'Dup Email', email: 'alice@example.com', age: 21 } },
			],
			params: {
				operation: 'insert',
				tableId: { mode: 'list', value: 'users' },
				dataSource: 'json',
				jsonInputMode: 'incomingItems',
				mappingMode: 'auto',
				errorHandlerMode: 'rollbackAndRouteToError',
				outputMode: 'summaryWithRows',
			},
		});

		const [matched, errors] = await node.execute.call(ctx);
		assert.equal(matched[0].json.insertedCount, 0);
		assert.equal(errors.length, 1);
		assert.equal(errors[0].json.errorCode, 'TRANSACTION_ABORTED');

		const db = new Database(targetDbPath, { readonly: true });
		const row20 = db.prepare('SELECT * FROM users WHERE id = 20').get();
		db.close();
		assert.equal(row20, undefined);
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('Dry Run compiles SQL without mutating the database', async () => {
	const { dir, targetDbPath } = setupTempDb();
	try {
		const node = new FoxSchemaMatch();
		const ctx = createMockExecuteContext({
			targetDbPath,
			inputItems: [
				{ json: { id: 99, first_name: 'Dry Run User', email: 'dry@example.com', age: 40 } },
			],
			params: {
				operation: 'upsert',
				tableId: { mode: 'list', value: 'users' },
				dataSource: 'json',
				jsonInputMode: 'incomingItems',
				mappingMode: 'auto',
				dryRun: true,
				errorHandlerMode: 'skipAndLog',
				outputMode: 'rowByRow',
			},
		});

		const [matched] = await node.execute.call(ctx);
		assert.equal(matched.length, 1);
		assert.equal(matched[0].json.status, 'dryRun');
		assert.match(String(matched[0].json.sql), /ON CONFLICT/);

		const db = new Database(targetDbPath, { readonly: true });
		const row99 = db.prepare('SELECT * FROM users WHERE id = 99').get();
		db.close();
		assert.equal(row99, undefined);
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
