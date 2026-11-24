import test from 'node:test';
import assert from 'node:assert/strict';
import {
	applyColumnValidationRule,
	ColumnRuleError,
	parseDateInput,
} from '../nodes/columnRules';
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
		{ name: 'signup_at', type: 'TIMESTAMP', nullable: true, primaryKey: false },
		{ name: 'tier', type: 'TEXT', nullable: false, defaultValue: "'free'", primaryKey: false },
	],
};

test('Column rules handle regex validate, extract, and replace', () => {
	// Validate
	const validEmail = applyColumnValidationRule(
		'email',
		'  ALICE@Example.COM ',
		{
			targetColumn: 'email',
			trim: true,
			caseTransform: 'lowercase',
			regexAction: 'validate',
			regexPattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
		},
		true,
	);
	assert.equal(validEmail, 'alice@example.com');

	assert.throws(
		() =>
			applyColumnValidationRule(
				'email',
				'not-an-email',
				{
					targetColumn: 'email',
					regexAction: 'validate',
					regexPattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
					validationMessage: 'Bad email format',
				},
				true,
			),
		(err: unknown) =>
			err instanceof ColumnRuleError &&
			err.errorCode === 'REGEX_VALIDATION' &&
			err.message.includes('Bad email format'),
	);

	// Extract
	const orderNum = applyColumnValidationRule(
		'order_code',
		'ORD-2026-0042',
		{
			targetColumn: 'order_code',
			regexAction: 'extract',
			regexPattern: 'ORD-\\d{4}-(\\d+)',
			dataType: 'integer',
		},
		true,
	);
	assert.equal(orderNum, 42);

	// Replace
	const digits = applyColumnValidationRule(
		'phone',
		'(555) 123-4567',
		{
			targetColumn: 'phone',
			regexAction: 'replace',
			regexPattern: '[^0-9]',
			regexFlags: 'g',
			regexReplacement: '',
		},
		true,
	);
	assert.equal(digits, '5551234567');
});

test('Column rules convert date/time formats and timezones accurately', () => {
	// MM/DD/YYYY -> SQL Date
	const sqlDate = applyColumnValidationRule(
		'birth_date',
		'11/24/2026',
		{
			targetColumn: 'birth_date',
			inputDateFormat: 'MM/DD/YYYY',
			dateTimeOutput: 'sqlDate',
			targetTimezone: 'UTC',
		},
		true,
	);
	assert.equal(sqlDate, '2026-11-24');

	// DD/MM/YYYY with time -> SQL DateTime in America/Chicago (UTC-6 in Nov)
	const chicagoDt = applyColumnValidationRule(
		'signup_at',
		'24/11/2026 18:30:00',
		{
			targetColumn: 'signup_at',
			inputDateFormat: 'DD/MM/YYYY',
			dateTimeOutput: 'sqlDateTime',
			targetTimezone: 'America/Chicago',
		},
		true,
	);
	assert.equal(chicagoDt, '2026-11-24 12:30:00');

	// Unix seconds -> ISO 8601
	const isoFromUnix = applyColumnValidationRule(
		'signup_at',
		1700000000,
		{
			targetColumn: 'signup_at',
			inputDateFormat: 'unixSeconds',
			dateTimeOutput: 'iso',
			targetTimezone: 'UTC',
		},
		true,
	);
	assert.equal(isoFromUnix, '2023-11-14T22:13:20.000Z');

	// Invalid calendar date throws DATE_PARSE_ERROR
	assert.throws(() => parseDateInput('02/30/2026', 'MM/DD/YYYY'));
	assert.throws(
		() =>
			applyColumnValidationRule(
				'signup_at',
				'02/30/2026',
				{
					targetColumn: 'signup_at',
					inputDateFormat: 'MM/DD/YYYY',
					dateTimeOutput: 'sqlDate',
				},
				true,
			),
		(err: unknown) => err instanceof ColumnRuleError && err.errorCode === 'DATE_PARSE_ERROR',
	);
});

test('Column rules enforce dataType overrides, min/max, required, and allowedValues', () => {
	assert.throws(
		() =>
			applyColumnValidationRule(
				'age',
				'12.5',
				{ targetColumn: 'age', dataType: 'integer' },
				true,
			),
		(err: unknown) => err instanceof ColumnRuleError && err.errorCode === 'TYPE_COERCION',
	);

	assert.throws(
		() =>
			applyColumnValidationRule(
				'age',
				15,
				{ targetColumn: 'age', dataType: 'integer', minValue: '18' },
				true,
			),
		(err: unknown) => err instanceof ColumnRuleError && err.errorCode === 'VALIDATION_ERROR',
	);

	assert.throws(
		() =>
			applyColumnValidationRule(
				'tier',
				'platinum',
				{ targetColumn: 'tier', allowedValues: 'free, pro, enterprise' },
				true,
			),
		(err: unknown) => err instanceof ColumnRuleError && err.errorCode === 'VALIDATION_ERROR',
	);
});

test('Schema matcher applies columnRules + normalized match + validation failures', () => {
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
				id: '7',
				firstName: '  Alice  ',
				email: 'ALICE@EXAMPLE.COM',
				age: '29',
				signupAt: '11/24/2026',
				tier: 'pro',
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
			manualMappings: [],
			columnRules: [
				{ targetColumn: 'first_name', trim: true, required: true },
				{
					targetColumn: 'email',
					trim: true,
					caseTransform: 'lowercase',
					regexAction: 'validate',
					regexPattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
				},
				{
					targetColumn: 'signup_at',
					inputDateFormat: 'MM/DD/YYYY',
					dateTimeOutput: 'sqlDate',
					targetTimezone: 'UTC',
				},
			],
			matchKeyColumns: keys,
			emptyStringAsNull: true,
			strictTypeValidation: true,
			validateRequiredColumns: true,
			includeIdentityOnInsert: false,
			skipNullValuesOnUpdate: false,
		},
	);

	assert.ok('ok' in okRow);
	assert.equal(okRow.mappedRow.id, 7);
	assert.equal(okRow.mappedRow.first_name, 'Alice');
	assert.equal(okRow.mappedRow.email, 'alice@example.com');
	assert.equal(okRow.mappedRow.signup_at, '2026-11-24');
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
