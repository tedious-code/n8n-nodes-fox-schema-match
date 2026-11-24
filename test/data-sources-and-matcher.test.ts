import test from 'node:test';
import assert from 'node:assert/strict';
import {
	parseCsvString,
	parseJsonPayload,
	parseTextPayload,
} from '../nodes/dataSources';
import {
	buildTargetTableMeta,
	matchSourceRow,
	resolveEffectiveMatchKeys,
} from '../nodes/schemaMatcher';
import {
	compileInsertStatement,
	compileUpdateStatement,
	compileUpsertStatement,
} from '../nodes/writeEngine';
import type { FoxTableSchema } from '../nodes/foxSchema';
import type { MappedRowResult } from '../nodes/types';

const SAMPLE_TABLE: FoxTableSchema = {
	name: 'users',
	objectType: 'TABLE',
	primaryKey: { name: 'pk_users', columns: ['id'] },
	columns: [
		{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
		{ name: 'first_name', type: 'VARCHAR(100)', nullable: false, primaryKey: false },
		{ name: 'email', type: 'TEXT', nullable: false, primaryKey: false },
		{ name: 'age', type: 'INTEGER', nullable: true, primaryKey: false },
		{ name: 'is_active', type: 'BOOLEAN', nullable: false, defaultValue: '1', primaryKey: false },
		{ name: 'meta', type: 'JSON', nullable: true, primaryKey: false },
	],
};

test('CSV parser handles quoted commas, escaped quotes, BOM, and custom headers', () => {
	const csv = '\uFEFFid,name,note\n1,"Alice, Bob","She said ""hi"""\n2,Charlie,"line1\nline2"';
	const res = parseCsvString(csv, { itemIndex: 0, hasHeader: true });
	assert.equal(res.errors.length, 0);
	assert.equal(res.rows.length, 2);
	assert.deepEqual(res.rows[0].data, {
		id: '1',
		name: 'Alice, Bob',
		note: 'She said "hi"',
	});
	assert.equal(res.rows[1].data.note, 'line1\nline2');

	const noHeader = parseCsvString('10;Dana\n11;Eli', {
		itemIndex: 0,
		delimiter: ';',
		hasHeader: false,
		customHeaders: 'id, first_name',
	});
	assert.equal(noHeader.errors.length, 0);
	assert.deepEqual(noHeader.rows[0].data, { id: '10', first_name: 'Dana' });
	assert.deepEqual(noHeader.rows[1].positionalValues, ['11', 'Eli']);

	const malformed = parseCsvString('id,name\n1,"unterminated', { itemIndex: 0 });
	assert.equal(malformed.rows.length, 0);
	assert.equal(malformed.errors.length, 1);
	assert.equal(malformed.errors[0].errorCode, 'PARSE_ERROR');
});

test('JSON parser handles arrays, NDJSON, jsonRootPath, and malformed input', () => {
	const nested = parseJsonPayload(
		{ payload: { rows: [{ id: 1, email: 'a@b.com' }, { id: 2, email: 'c@d.com' }] } },
		{ jsonRootPath: 'payload.rows', itemIndex: 0 },
	);
	assert.equal(nested.errors.length, 0);
	assert.equal(nested.rows.length, 2);
	assert.equal(nested.rows[1].data.id, 2);

	const ndjson = parseJsonPayload('{"id":1,"name":"A"}\n{"id":2,"name":"B"}', {
		itemIndex: 0,
	});
	assert.equal(ndjson.errors.length, 0);
	assert.equal(ndjson.rows.length, 2);

	const bad = parseJsonPayload('{invalid json', { itemIndex: 0 });
	assert.equal(bad.errors.length, 1);
	assert.equal(bad.errors[0].errorCode, 'PARSE_ERROR');
});

test('Text parser handles pipe, keyValue, regex, fixedWidth, and lines', () => {
	const pipeRes = parseTextPayload('id|first_name|email\n1|Alice|a@b.com\n2|Bob|b@b.com', {
		textFormat: 'pipe',
		hasHeader: true,
		itemIndex: 0,
	});
	assert.equal(pipeRes.errors.length, 0);
	assert.equal(pipeRes.rows.length, 2);
	assert.equal(pipeRes.rows[0].data.email, 'a@b.com');

	const kvRes = parseTextPayload('id=1 name="Alice Smith" age=30\nid=2 badtoken', {
		textFormat: 'keyValue',
		itemIndex: 0,
	});
	assert.equal(kvRes.rows.length, 1);
	assert.equal(kvRes.errors.length, 1);
	assert.deepEqual(kvRes.rows[0].data, { id: '1', name: 'Alice Smith', age: '30' });

	const regexRes = parseTextPayload('101 Alice a@b.com\nbad-line', {
		textFormat: 'regex',
		regexPattern: '^(?<id>\\d+)\\s+(?<first_name>\\S+)\\s+(?<email>\\S+)$',
		failOnUnmatchedLine: true,
		itemIndex: 0,
	});
	assert.equal(regexRes.rows.length, 1);
	assert.equal(regexRes.errors.length, 1);
	assert.equal(regexRes.rows[0].data.first_name, 'Alice');

	const fwRes = parseTextPayload('001  Alice     pro       ', {
		textFormat: 'fixedWidth',
		fixedWidthSpec: 'id:0-5,first_name:5-15,tier:15-25',
		itemIndex: 0,
	});
	assert.equal(fwRes.errors.length, 0);
	assert.deepEqual(fwRes.rows[0].data, {
		id: '001',
		first_name: 'Alice',
		tier: 'pro',
	});
});

test('Schema matcher supports normalized auto-match, manual transforms, and validation errors', () => {
	const meta = buildTargetTableMeta(SAMPLE_TABLE, 'public');
	const keys = resolveEffectiveMatchKeys({
		configuredKeys: [],
		tableMeta: meta,
		matchRule: 'normalized',
	});
	assert.deepEqual(keys, ['id']);

	const okRow = matchSourceRow(
		{
			rowIndex: 0,
			itemIndex: 0,
			data: {
				ID: '42',
				firstName: '  Alice  ',
				EMAIL: 'ALICE@EXAMPLE.COM',
				age: '29',
				isActive: 'true',
				extraField: 'ignored',
			},
		},
		{
			operation: 'upsert',
			table: 'users',
			dialect: 'postgres',
			tableMeta: meta,
			mappingMode: 'auto',
			matchRule: 'normalized',
			unmatchedSourceBehavior: 'ignore',
			manualMappings: [
				{ sourceField: 'firstName', targetColumn: 'first_name', transform: 'trim' },
				{ sourceField: 'EMAIL', targetColumn: 'email', transform: 'lowercase' },
			],
			positionalColumns: [],
			matchKeyColumns: keys,
			emptyStringAsNull: true,
			strictTypeValidation: true,
			validateRequiredColumns: true,
			includeIdentityOnInsert: false,
			skipNullValuesOnUpdate: false,
		},
	);

	assert.ok('ok' in okRow);
	assert.equal(okRow.mappedRow.id, 42);
	assert.equal(okRow.mappedRow.first_name, 'Alice');
	assert.equal(okRow.mappedRow.email, 'alice@example.com');
	assert.equal(okRow.mappedRow.age, 29);
	assert.equal(okRow.mappedRow.is_active, true);

	const badType = matchSourceRow(
		{
			rowIndex: 1,
			itemIndex: 0,
			data: { id: 'not-a-number', firstName: 'Bob', email: 'bob@example.com' },
		},
		{
			operation: 'insert',
			table: 'users',
			dialect: 'postgres',
			tableMeta: meta,
			mappingMode: 'auto',
			matchRule: 'normalized',
			unmatchedSourceBehavior: 'ignore',
			manualMappings: [],
			positionalColumns: [],
			matchKeyColumns: keys,
			emptyStringAsNull: true,
			strictTypeValidation: true,
			validateRequiredColumns: true,
			includeIdentityOnInsert: false,
			skipNullValuesOnUpdate: false,
		},
	);
	assert.ok(!('ok' in badType));
	assert.equal(badType.errorCode, 'TYPE_COERCION');

	const missingRequired = matchSourceRow(
		{
			rowIndex: 2,
			itemIndex: 0,
			data: { id: 3, firstName: 'Eve' },
		},
		{
			operation: 'insert',
			table: 'users',
			dialect: 'postgres',
			tableMeta: meta,
			mappingMode: 'auto',
			matchRule: 'normalized',
			unmatchedSourceBehavior: 'ignore',
			manualMappings: [],
			positionalColumns: [],
			matchKeyColumns: keys,
			emptyStringAsNull: true,
			strictTypeValidation: true,
			validateRequiredColumns: true,
			includeIdentityOnInsert: false,
			skipNullValuesOnUpdate: false,
		},
	);
	assert.ok(!('ok' in missingRequired));
	assert.equal(missingRequired.errorCode, 'MISSING_REQUIRED_COLUMN');
});

test('Multi-dialect SQL compilation generates accurate Insert, Update, and Upsert syntax', () => {
	const rows: MappedRowResult[] = [
		{
			ok: true,
			rowIndex: 0,
			itemIndex: 0,
			sourceRow: {},
			mappedRow: { id: 1, name: 'Alice', email: 'a@b.com' },
			matchedColumns: ['id', 'name', 'email'],
			unmatchedFields: [],
		},
	];

	const pgUpsert = compileUpsertStatement({
		dialect: 'postgres',
		qualifiedTable: '"public"."users"',
		columns: ['id', 'name', 'email'],
		matchKeys: ['id'],
		rows,
		dryRun: false,
	});
	assert.match(pgUpsert.sql, /ON CONFLICT \("id"\) DO UPDATE SET "name" = EXCLUDED\."name", "email" = EXCLUDED\."email" RETURNING \*/);

	const mysqlUpsert = compileUpsertStatement({
		dialect: 'mysql',
		qualifiedTable: '`app`.`users`',
		columns: ['id', 'name', 'email'],
		matchKeys: ['id'],
		rows,
		dryRun: false,
	});
	assert.match(mysqlUpsert.sql, /ON DUPLICATE KEY UPDATE `name` = VALUES\(`name`\), `email` = VALUES\(`email`\)/);

	const mssqlUpsert = compileUpsertStatement({
		dialect: 'sqlserver',
		qualifiedTable: '[dbo].[users]',
		columns: ['id', 'name', 'email'],
		matchKeys: ['id'],
		rows,
		dryRun: false,
	});
	assert.match(mssqlUpsert.sql, /MERGE INTO \[dbo\]\.\[users\] AS T USING \(VALUES \(\?, \?, \?\)\) AS S \(\[id\], \[name\], \[email\]\) ON \(T\.\[id\] = S\.\[id\]\)/);

	const oraUpsert = compileUpsertStatement({
		dialect: 'oracle',
		qualifiedTable: '"APP"."USERS"',
		columns: ['id', 'name', 'email'],
		matchKeys: ['id'],
		rows,
		dryRun: false,
	});
	assert.match(oraUpsert.sql, /MERGE INTO "APP"\."USERS" T USING \(SELECT \? AS "ID", \? AS "NAME", \? AS "EMAIL" FROM DUAL\) S/);

	const insertStmt = compileInsertStatement({
		dialect: 'mysql',
		qualifiedTable: '`app`.`users`',
		columns: ['id', 'name'],
		rows,
		ignoreDuplicates: true,
		dryRun: true,
	});
	assert.match(insertStmt.sql, /^INSERT IGNORE INTO `app`\.`users`/);

	const updateStmt = compileUpdateStatement({
		dialect: 'postgres',
		qualifiedTable: '"public"."users"',
		row: rows[0],
		matchKeys: ['id'],
		dryRun: true,
		returning: false,
	});
	assert.equal(updateStmt.sql, 'UPDATE "public"."users" SET "name" = ?, "email" = ? WHERE "id" = ?');
	assert.deepEqual(updateStmt.params, ['Alice', 'a@b.com', 1]);
});
