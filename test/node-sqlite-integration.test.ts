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

	const tdb = new Database(targetDbPath);
	tdb.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			first_name TEXT NOT NULL,
			email TEXT NOT NULL UNIQUE,
			age INTEGER,
			signup_at TEXT,
			active INTEGER NOT NULL DEFAULT 1
		);
		INSERT INTO users (id, first_name, email, age, signup_at, active)
		VALUES (1, 'Alice', 'alice@example.com', 30, '2026-01-01', 1);
	`);
	tdb.close();

	return { dir, targetDbPath };
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
	params: Record<string, any> | ((itemIndex: number) => Record<string, any>);
	targetDbPath: string;
	continueOnFail?: boolean;
}): IExecuteFunctions {
	const inputItems = opts.inputItems ?? [{ json: {} }];
	return {
		getInputData: () => inputItems,
		getNodeParameter: (name: string, itemIndex: number, fallback?: any) => {
			const src = typeof opts.params === 'function' ? opts.params(itemIndex) : opts.params;
			return getParam(src, name, fallback);
		},
		getCredentials: async (credName: string) => {
			if (credName === 'foxSchemaMatchDbApi') {
				return { dialect: 'sqlite', database: opts.targetDbPath };
			}
			throw new Error(`Credential ${credName} not configured`);
		},
		continueOnFail: () => opts.continueOnFail === true,
		getNode: () => TEST_NODE,
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

test('Visual Table Mapper (resourceMapper): getMappingColumns + Insert + Upsert with validation, regex & datetime conversion', async () => {
	const { dir, targetDbPath } = setupTempDb();
	try {
		const node = new FoxSchemaMatch();

		// 1. Load table schema columns via FoxSchema resourceMapping
		const loadCtx = {
			getNodeParameter: (name: string) => {
				if (name === 'tableId') return { mode: 'list', value: 'users' };
				if (name === 'operation') return 'insert';
				return undefined;
			},
			getCredentials: async () => ({ dialect: 'sqlite', database: targetDbPath }),
			getNode: () => TEST_NODE,
		} as any;

		const mappedSchema = await node.methods.resourceMapping.getMappingColumns.call(loadCtx);
		assert.deepEqual(
			mappedSchema.fields.map((f) => f.id),
			['id', 'first_name', 'email', 'age', 'signup_at', 'active'],
		);
		assert.equal(mappedSchema.fields.find((f) => f.id === 'id')?.defaultMatch, true);
		assert.equal(mappedSchema.fields.find((f) => f.id === 'age')?.type, 'number');

		// 2. Insert with Visual Table Mapper (defineBelow) + regex + datetime conversion + error routing
		const inputItems: INodeExecutionData[] = [
			{
				json: {
					uid: 2,
					name: '  Bob Builder  ',
					mail: 'BOB@FOXSCHEMA.COM',
					years: 28,
					joined: '11/24/2026',
				},
			},
			{
				json: {
					uid: 3,
					name: 'Bad Email User',
					mail: 'not-valid-email',
					years: 25,
					joined: '11/24/2026',
				},
			},
			{
				json: {
					uid: 4,
					name: 'Bad Date User',
					mail: 'date@foxschema.com',
					years: 22,
					joined: '02/30/2026',
				},
			},
		];

		const ctx = createMockExecuteContext({
			targetDbPath,
			inputItems,
			params: (itemIndex) => {
				const j = inputItems[itemIndex]?.json ?? {};
				return {
					operation: 'insert',
					tableId: { mode: 'list', value: 'users' },
					mappingMode: 'resourceMapper',
					columns: {
						mappingMode: 'defineBelow',
						value: {
							id: j.uid,
							first_name: j.name,
							email: j.mail,
							age: j.years,
							signup_at: j.joined,
							active: 1,
						},
						matchingColumns: ['id'],
					},
					columnRules: {
						ruleValues: [
							{ targetColumn: 'first_name', trim: true, required: true },
							{
								targetColumn: 'email',
								trim: true,
								caseTransform: 'lowercase',
								regexAction: 'validate',
								regexPattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
							},
							{
								targetColumn: 'age',
								dataType: 'integer',
								minValue: '18',
							},
							{
								targetColumn: 'signup_at',
								inputDateFormat: 'MM/DD/YYYY',
								dateTimeOutput: 'sqlDate',
								targetTimezone: 'UTC',
							},
						],
					},
					errorHandlerMode: 'routeToErrorOutput',
					outputMode: 'summaryWithRows',
				};
			},
		});

		const [matched, errors] = await node.execute.call(ctx);
		assert.equal(matched[0].json.insertedCount, 1);
		assert.equal(errors.length, 2);
		assert.equal(errors[0].json.errorCode, 'REGEX_VALIDATION');
		assert.equal(errors[0].json.column, 'email');
		assert.equal(errors[1].json.errorCode, 'DATE_PARSE_ERROR');
		assert.equal(errors[1].json.column, 'signup_at');

		const db = new Database(targetDbPath, { readonly: true });
		const bob = db.prepare('SELECT id, first_name, email, signup_at FROM users WHERE id = 2').get() as any;
		db.close();
		assert.deepEqual(bob, {
			id: 2,
			first_name: 'Bob Builder',
			email: 'bob@foxschema.com',
			signup_at: '2026-11-24',
		});
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('Auto-Match mode -> Upsert + Update with requireMatchedRow + Error Handler isolation', async () => {
	const { dir, targetDbPath } = setupTempDb();
	try {
		const node = new FoxSchemaMatch();

		// Upsert with normalized Auto-Match + batch isolation on UNIQUE email violation
		const upsertCtx = createMockExecuteContext({
			targetDbPath,
			inputItems: [
				{ json: { id: 1, firstName: 'Alice Upserted', email: 'alice@example.com', age: 31 } },
				{ json: { id: 10, firstName: 'Dup Email', email: 'alice@example.com', age: 40 } },
				{ json: { id: 11, firstName: 'Carol', email: 'carol@example.com', age: 27 } },
			],
			params: {
				operation: 'upsert',
				tableId: { mode: 'list', value: 'users' },
				mappingMode: 'auto',
				matchRule: 'normalized',
				unmatchedSourceBehavior: 'ignore',
				errorHandlerMode: 'routeToErrorOutput',
				outputMode: 'summaryWithRows',
			},
		});

		const [matched, errors] = await node.execute.call(upsertCtx);
		assert.equal(matched[0].json.upsertedCount, 2);
		assert.equal(errors.length, 1);
		assert.equal(errors[0].json.errorCode, 'DB_ERROR');
		assert.equal(errors[0].json.rowIndex, 1);

		// Update with requireMatchedRow
		const updateCtx = createMockExecuteContext({
			targetDbPath,
			inputItems: [
				{ json: { id: 1, first_name: 'Alice Final', age: 32 } },
				{ json: { id: 999, first_name: 'Missing', age: 99 } },
			],
			params: {
				operation: 'update',
				tableId: { mode: 'list', value: 'users' },
				mappingMode: 'auto',
				matchKeyColumns: 'id',
				errorHandlerMode: 'routeToErrorOutput',
				errorHandlerOptions: { requireMatchedRow: true },
				outputMode: 'rowByRow',
			},
		});

		const [uMatched, uErrors] = await node.execute.call(updateCtx);
		assert.equal(uMatched.length, 1);
		assert.equal((uMatched[0].json.data as any).first_name, 'Alice Final');
		assert.equal(uErrors.length, 1);
		assert.equal(uErrors[0].json.errorCode, 'ROW_NOT_FOUND');
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('Manual Field Mapping with dot-path + rollbackAndRouteToError + Dry Run', async () => {
	const { dir, targetDbPath } = setupTempDb();
	try {
		const node = new FoxSchemaMatch();

		// Rollback test
		const txCtx = createMockExecuteContext({
			targetDbPath,
			inputItems: [
				{ json: { user: { id: 20, name: 'Should Rollback', email: 'ok20@example.com' } } },
				{ json: { user: { id: 21, name: 'Dup', email: 'alice@example.com' } } },
			],
			params: {
				operation: 'insert',
				tableId: { mode: 'list', value: 'users' },
				mappingMode: 'manual',
				manualMappings: {
					mappingValues: [
						{ sourceField: 'user.id', targetColumn: 'id' },
						{ sourceField: 'user.name', targetColumn: 'first_name', transform: 'trim' },
						{ sourceField: 'user.email', targetColumn: 'email', transform: 'lowercase' },
					],
				},
				errorHandlerMode: 'rollbackAndRouteToError',
				outputMode: 'summaryWithRows',
			},
		});

		const [txMatched, txErrors] = await node.execute.call(txCtx);
		assert.equal(txMatched[0].json.insertedCount, 0);
		assert.equal(txErrors.length, 1);
		assert.equal(txErrors[0].json.errorCode, 'TRANSACTION_ABORTED');

		const db = new Database(targetDbPath, { readonly: true });
		const row20 = db.prepare('SELECT * FROM users WHERE id = 20').get();
		db.close();
		assert.equal(row20, undefined);

		// Dry Run test
		const dryCtx = createMockExecuteContext({
			targetDbPath,
			inputItems: [{ json: { id: 88, first_name: 'Dry', email: 'dry@example.com' } }],
			params: {
				operation: 'upsert',
				tableId: { mode: 'list', value: 'users' },
				mappingMode: 'auto',
				dryRun: true,
				errorHandlerMode: 'skipAndLog',
				outputMode: 'rowByRow',
			},
		});
		const [dryOut] = await node.execute.call(dryCtx);
		assert.equal(dryOut.length, 1);
		assert.equal(dryOut[0].json.status, 'dryRun');
		assert.match(String(dryOut[0].json.sql), /ON CONFLICT/);
	} finally {
		await ConnectionFactory.closeAll();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
