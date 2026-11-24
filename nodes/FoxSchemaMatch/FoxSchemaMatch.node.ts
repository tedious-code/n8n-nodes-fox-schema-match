import {
	NodeConnectionTypes,
	type ICredentialDataDecryptedObject,
	type ICredentialTestFunctions,
	type ICredentialsDecrypted,
	type IExecuteFunctions,
	type INodeCredentialTestResult,
	type INodeExecutionData,
	type INodeOutputConfiguration,
	type INodeParameters,
	type INodeProperties,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import { testDbConnection } from '../dbConnection';
import { runFoxSchemaMatch } from '../matchPipeline';
import { getTargetColumns, searchTargetTables } from '../schemaCache';

export function configuredOutputs(
	parameters: INodeParameters,
): INodeOutputConfiguration[] {
	const errorMode = parameters.errorHandlerMode as string | undefined;
	if (
		errorMode === 'routeToErrorOutput' ||
		errorMode === 'rollbackAndRouteToError'
	) {
		return [
			{ type: 'main', displayName: 'Matched' },
			{ type: 'main', displayName: 'Errors' },
		];
	}
	return [{ type: 'main', displayName: 'Main' }];
}

const DIALECT_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Amazon Redshift', value: 'redshift' },
	{ name: 'Azure SQL', value: 'azuresql' },
	{ name: 'ClickHouse', value: 'clickhouse' },
	{ name: 'CockroachDB', value: 'cockroachdb' },
	{ name: 'DuckDB', value: 'duckdb' },
	{ name: 'MariaDB', value: 'mariadb' },
	{ name: 'MySQL', value: 'mysql' },
	{ name: 'Oracle', value: 'oracle' },
	{ name: 'PostgreSQL', value: 'postgres' },
	{ name: 'SQL Server', value: 'sqlserver' },
	{ name: 'SQLite', value: 'sqlite' },
	{ name: 'TiDB', value: 'tidb' },
	{ name: 'YugabyteDB', value: 'yugabytedb' },
];

const NETWORK_DIALECTS = [
	'postgres',
	'cockroachdb',
	'yugabytedb',
	'redshift',
	'mysql',
	'mariadb',
	'tidb',
	'sqlserver',
	'azuresql',
	'oracle',
	'clickhouse',
];

const FILE_DIALECTS = ['sqlite', 'duckdb'];

const SOURCE_INLINE_CONNECTION_FIELDS: INodeProperties[] = [
	{
		displayName: 'Source Connection String (Optional)',
		name: 'sourceInlineConnectionString',
		type: 'string',
		typeOptions: { password: true },
		default: '',
		placeholder: 'postgres://user:pass@host:5432/source_db',
		displayOptions: {
			show: {
				dataSource: ['rawQuery'],
				rawQueryConnectionMode: ['inline'],
			},
		},
	},
	{
		displayName: 'Source Database / Service',
		name: 'sourceInlineDatabase',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				dataSource: ['rawQuery'],
				rawQueryConnectionMode: ['inline'],
				sourceInlineDialect: NETWORK_DIALECTS,
			},
		},
	},
	{
		displayName: 'Source Database File Path',
		name: 'sourceInlineDatabase',
		type: 'string',
		default: '',
		placeholder: '/data/source.db',
		displayOptions: {
			show: {
				dataSource: ['rawQuery'],
				rawQueryConnectionMode: ['inline'],
				sourceInlineDialect: FILE_DIALECTS,
			},
		},
	},
	{
		displayName: 'Source Dialect',
		name: 'sourceInlineDialect',
		type: 'options',
		options: DIALECT_OPTIONS,
		default: 'postgres',
		displayOptions: {
			show: {
				dataSource: ['rawQuery'],
				rawQueryConnectionMode: ['inline'],
			},
		},
	},
	{
		displayName: 'Source Host',
		name: 'sourceInlineHost',
		type: 'string',
		default: 'localhost',
		displayOptions: {
			show: {
				dataSource: ['rawQuery'],
				rawQueryConnectionMode: ['inline'],
				sourceInlineDialect: NETWORK_DIALECTS,
			},
		},
	},
	{
		displayName: 'Source Password',
		name: 'sourceInlinePassword',
		type: 'string',
		typeOptions: { password: true },
		default: '',
		displayOptions: {
			show: {
				dataSource: ['rawQuery'],
				rawQueryConnectionMode: ['inline'],
				sourceInlineDialect: NETWORK_DIALECTS,
			},
		},
	},
	{
		displayName: 'Source Port',
		name: 'sourceInlinePort',
		type: 'number',
		default: 5432,
		displayOptions: {
			show: {
				dataSource: ['rawQuery'],
				rawQueryConnectionMode: ['inline'],
				sourceInlineDialect: NETWORK_DIALECTS,
			},
		},
	},
	{
		displayName: 'Source Reject Unauthorized SSL',
		name: 'sourceInlineRejectUnauthorized',
		type: 'boolean',
		default: true,
		displayOptions: {
			show: {
				dataSource: ['rawQuery'],
				rawQueryConnectionMode: ['inline'],
				sourceInlineDialect: NETWORK_DIALECTS,
				sourceInlineUseSsl: [true],
			},
		},
	},
	{
		displayName: 'Source Schema',
		name: 'sourceInlineSchema',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				dataSource: ['rawQuery'],
				rawQueryConnectionMode: ['inline'],
			},
		},
	},
	{
		displayName: 'Source Use SSL',
		name: 'sourceInlineUseSsl',
		type: 'boolean',
		default: false,
		displayOptions: {
			show: {
				dataSource: ['rawQuery'],
				rawQueryConnectionMode: ['inline'],
				sourceInlineDialect: NETWORK_DIALECTS,
			},
		},
	},
	{
		displayName: 'Source Username',
		name: 'sourceInlineUsername',
		type: 'string',
		default: '',
		displayOptions: {
			show: {
				dataSource: ['rawQuery'],
				rawQueryConnectionMode: ['inline'],
				sourceInlineDialect: NETWORK_DIALECTS,
			},
		},
	},
];

export class FoxSchemaMatch implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Fox Schema Match',
		name: 'foxSchemaMatch',
		icon: {
			light: 'file:foxschema.svg',
			dark: 'file:foxschema.dark.svg',
		},
		group: ['transform', 'output'],
		version: 1,
		subtitle: '={{$parameter["dataSource"] + " -> " + $parameter["operation"]}}',
		description:
			'Fox Schema Pipe Match: ingest Raw SQL Queries, JSON, CSV, or Delimited/Structured Text, match & coerce to target database table columns (Insert, Update, Upsert) across 13 SQL dialects with row/batch error handling',
		documentationUrl: 'https://foxschema.com',
		defaults: {
			name: 'Fox Schema Match',
		},
		codex: {
			categories: ['Data & Storage', 'Development'],
			resources: {
				primaryDocumentation: [{ url: 'https://foxschema.com' }],
				credentialDocumentation: [{ url: 'https://foxschema.com' }],
			},
			alias: [
				'foxschema',
				'pipe',
				'match',
				'upsert',
				'insert',
				'update',
				'csv',
				'json',
				'sql',
				'etl',
			],
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: `={{(${configuredOutputs})($parameter)}}`,
		credentials: [
			{
				name: 'foxSchemaMatchDbApi',
				required: true,
				testedBy: 'targetDbConnectionTest',
			},
		],
		properties: [
			{
				displayName:
					'Powered by <a href="https://foxschema.com" target="_blank">FoxSchema (@foxschema/db + @foxschema/sql)</a> — Pipe Match data from Raw SQL, JSON, CSV, or Text into 13 SQL dialects.',
				name: 'foxSchemaBacklink',
				type: 'notice',
				default: '',
			},

			// ----------------------------------
			//         Target Operation
			// ----------------------------------
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Create or Update',
						value: 'upsert',
						description:
							'Create a new record, or update the current one if it already exists (upsert)',
						action: 'Create or update matched rows',
					},
					{
						name: 'Insert',
						value: 'insert',
						description: 'Insert matched rows into the target database table',
						action: 'Insert matched rows into table',
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Update existing rows in the target table by match key columns',
						action: 'Update matched rows in table',
					},
				],
				default: 'upsert',
			},
			{
				displayName: 'Target Table',
				name: 'tableId',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						placeholder: 'Select a target table...',
						typeOptions: {
							searchListMethod: 'searchTargetTables',
							searchFilterRequired: false,
							searchable: true,
						},
					},
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						placeholder: 'users or public.users',
					},
				],
				description: 'Target database table (discovered via FoxSchema catalog)',
			},

			// ----------------------------------
			//         Data Source Input
			// ----------------------------------
			{
				displayName: 'Data Source',
				name: 'dataSource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'CSV',
						value: 'csv',
						description: 'Parse CSV text or binary file into rows',
					},
					{
						name: 'Execute Raw Query',
						value: 'rawQuery',
						description: 'Execute a raw SQL query against a source database and pipe its rows',
					},
					{
						name: 'JSON',
						value: 'json',
						description: 'Read incoming n8n JSON items, JSON/NDJSON string, or JSON binary file',
					},
					{
						name: 'Text (Pipe / Delimited / Structured)',
						value: 'text',
						description:
							'Parse pipe-delimited (|), TSV, custom delimiter, key-value, regex, or fixed-width text',
					},
				],
				default: 'json',
				description: 'Input data source format to parse and match to target columns',
			},

			// --- Raw Query Source ---
			{
				displayName: 'Source DB Connection',
				name: 'rawQueryConnectionMode',
				type: 'options',
				displayOptions: {
					show: {
						dataSource: ['rawQuery'],
					},
				},
				options: [
					{
						name: 'Inline Source Connection',
						value: 'inline',
						description: 'Specify source dialect, host, credentials, or file path directly on the node',
					},
					{
						name: 'Same as Target Credential',
						value: 'sameAsTarget',
						description: 'Run the source SQL query against the same database as Target Table',
					},
				],
				default: 'sameAsTarget',
			},
			...SOURCE_INLINE_CONNECTION_FIELDS,
			{
				displayName: 'Raw SQL Query',
				name: 'rawSql',
				type: 'string',
				typeOptions: {
					editor: 'sqlEditor',
					sqlDialect: 'StandardSQL',
					rows: 5,
				},
				default: 'SELECT * FROM staging_users',
				placeholder: 'SELECT user_id, name, email FROM staging_users WHERE active = ?',
				displayOptions: {
					show: {
						dataSource: ['rawQuery'],
					},
				},
				description:
					'SQL query returning rows to pipe into the target table (supports ? bind parameters)',
			},
			{
				displayName: 'Query Bind Parameters',
				name: 'rawQueryBindings',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					multipleValueButtonText: 'Add Parameter',
				},
				default: {},
				displayOptions: {
					show: {
						dataSource: ['rawQuery'],
					},
				},
				options: [
					{
						name: 'parameterValues',
						displayName: 'Parameter',
						values: [
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								default: 'string',
								options: [
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'Date', value: 'date' },
									{ name: 'JSON', value: 'json' },
									{ name: 'Null', value: 'null' },
									{ name: 'Number', value: 'number' },
									{ name: 'SQL Expression', value: 'sql' },
									{ name: 'String', value: 'string' },
								],
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},
			{
				displayName: 'Query Result Data Path',
				name: 'rawQueryDataPath',
				type: 'string',
				default: '',
				placeholder: 'e.g. [0].rows',
				displayOptions: {
					show: {
						dataSource: ['rawQuery'],
					},
				},
				description: 'Optional dot/bracket path to extract rows from the query result',
			},
			{
				displayName: 'Query Timeout (Ms)',
				name: 'rawQueryTimeoutMs',
				type: 'number',
				default: 15000,
				displayOptions: {
					show: {
						dataSource: ['rawQuery'],
					},
				},
			},

			// --- JSON Source ---
			{
				displayName: 'JSON Source Mode',
				name: 'jsonInputMode',
				type: 'options',
				displayOptions: {
					show: {
						dataSource: ['json'],
					},
				},
				options: [
					{
						name: 'Binary File (JSON / NDJSON)',
						value: 'binary',
					},
					{
						name: 'Incoming Workflow Items (JSON)',
						value: 'incomingItems',
					},
					{
						name: 'JSON / NDJSON String or Expression',
						value: 'jsonString',
					},
				],
				default: 'incomingItems',
			},
			{
				displayName: 'JSON Payload',
				name: 'jsonPayload',
				type: 'string',
				typeOptions: {
					rows: 5,
				},
				default: '[]',
				placeholder: '[{"user_id": 1, "name": "Alice", "email": "alice@example.com"}]',
				displayOptions: {
					show: {
						dataSource: ['json'],
						jsonInputMode: ['jsonString'],
					},
				},
				description: 'JSON object, JSON array, or NDJSON text (supports n8n expressions)',
			},
			{
				displayName: 'JSON Root Path (Optional)',
				name: 'jsonRootPath',
				type: 'string',
				default: '',
				placeholder: 'e.g. data.records',
				displayOptions: {
					show: {
						dataSource: ['json'],
					},
				},
				description: 'Optional dot/bracket path to extract an object or array from the JSON payload',
			},

			// --- CSV Source ---
			{
				displayName: 'CSV Input Mode',
				name: 'csvInputMode',
				type: 'options',
				displayOptions: {
					show: {
						dataSource: ['csv'],
					},
				},
				options: [
					{ name: 'Binary File', value: 'binary' },
					{ name: 'Text or Expression', value: 'textContent' },
				],
				default: 'textContent',
			},
			{
				displayName: 'CSV Content',
				name: 'csvText',
				type: 'string',
				typeOptions: {
					rows: 6,
				},
				default: '',
				placeholder: 'user_id,name,email\n1,Alice,alice@example.com\n2,Bob,bob@example.com',
				displayOptions: {
					show: {
						dataSource: ['csv'],
						csvInputMode: ['textContent'],
					},
				},
			},
			{
				displayName: 'CSV Delimiter',
				name: 'csvDelimiter',
				type: 'options',
				displayOptions: {
					show: {
						dataSource: ['csv'],
					},
				},
				options: [
					{ name: 'Comma (,)', value: ',' },
					{ name: 'Custom', value: 'custom' },
					{ name: 'Pipe (|)', value: '|' },
					{ name: 'Semicolon (;)', value: ';' },
					{ name: 'Tab', value: '\\t' },
				],
				default: ',',
			},
			{
				displayName: 'Custom Delimiter',
				name: 'csvCustomDelimiter',
				type: 'string',
				default: ',',
				displayOptions: {
					show: {
						dataSource: ['csv'],
						csvDelimiter: ['custom'],
					},
				},
			},

			// --- Text Source ---
			{
				displayName: 'Text Input Mode',
				name: 'textInputMode',
				type: 'options',
				displayOptions: {
					show: {
						dataSource: ['text'],
					},
				},
				options: [
					{ name: 'Binary File', value: 'binary' },
					{ name: 'Text or Expression', value: 'textContent' },
				],
				default: 'textContent',
			},
			{
				displayName: 'Text Format',
				name: 'textFormat',
				type: 'options',
				displayOptions: {
					show: {
						dataSource: ['text'],
					},
				},
				options: [
					{
						name: 'Custom Delimiter',
						value: 'customDelimiter',
						description: 'Split text using a custom delimiter string',
					},
					{
						name: 'Fixed-Width Columns',
						value: 'fixedWidth',
						description: 'Extract fields by character ranges or widths (e.g. code:0-5,name:5-25)',
					},
					{
						name: 'Key-Value Pairs',
						value: 'keyValue',
						description: 'Parse key=value lines (e.g. code=1 name="Alice" tier=pro)',
					},
					{
						name: 'Pipe-Delimited (|)',
						value: 'pipe',
						description: 'Parse FoxSchema pipe-separated lines (code|name|email)',
					},
					{
						name: 'Raw Lines',
						value: 'lines',
						description: 'Emit each line as { line, lineNumber }',
					},
					{
						name: 'Regex Capture Groups',
						value: 'regex',
						description: 'Match each line with a regex using named or positional capture groups',
					},
					{
						name: 'Tab-Delimited (TSV)',
						value: 'tsv',
						description: 'Parse tab-separated text lines',
					},
				],
				default: 'pipe',
			},
			{
				displayName: 'Text Content',
				name: 'textContent',
				type: 'string',
				typeOptions: {
					rows: 6,
				},
				default: '',
				placeholder: 'user_id|name|email\n1|Alice|alice@example.com',
				displayOptions: {
					show: {
						dataSource: ['text'],
						textInputMode: ['textContent'],
					},
				},
			},
			{
				displayName: 'Custom Delimiter',
				name: 'textCustomDelimiter',
				type: 'string',
				default: '|',
				displayOptions: {
					show: {
						dataSource: ['text'],
						textFormat: ['customDelimiter'],
					},
				},
			},
			{
				displayName: 'Pair Separator',
				name: 'kvPairDelimiter',
				type: 'string',
				default: '\\s+',
				placeholder: '\\s+ or ; or |',
				displayOptions: {
					show: {
						dataSource: ['text'],
						textFormat: ['keyValue'],
					},
				},
				description: 'Separator between key-value pairs (defaults to whitespace \\s+)',
			},
			{
				displayName: 'Key-Value Separator',
				name: 'kvSeparator',
				type: 'string',
				default: '=',
				displayOptions: {
					show: {
						dataSource: ['text'],
						textFormat: ['keyValue'],
					},
				},
			},
			{
				displayName: 'Regex Pattern',
				name: 'regexPattern',
				type: 'string',
				default: '',
				placeholder: '^(?&lt;user_id&gt;\\d+)\\s+(?&lt;name&gt;[^|]+)\\|(?&lt;email&gt;.+)$',
				displayOptions: {
					show: {
						dataSource: ['text'],
						textFormat: ['regex'],
					},
				},
				description: 'Regular expression with named groups (?&lt;col&gt;...) or numbered capture groups',
			},
			{
				displayName: 'Fixed-Width Spec',
				name: 'fixedWidthSpec',
				type: 'string',
				default: '',
				placeholder: 'user_id:0-5,name:5-25,email:25-60 or user_id:5,name:20,email:35',
				displayOptions: {
					show: {
						dataSource: ['text'],
						textFormat: ['fixedWidth'],
					},
				},
			},

			// --- Shared Binary / Header Properties ---
			{
				displayName: 'Binary Property',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				displayOptions: {
					show: {
						dataSource: ['json', 'csv', 'text'],
					},
				},
				description: 'Name of the binary property containing the file when reading Binary input',
			},
			{
				displayName: 'First Row Is Header',
				name: 'hasHeader',
				type: 'boolean',
				default: true,
				displayOptions: {
					show: {
						dataSource: ['csv', 'text'],
					},
				},
				description: 'Whether the first row contains column headers',
			},
			{
				displayName: 'Custom Column Headers',
				name: 'customHeaders',
				type: 'string',
				default: '',
				placeholder: 'user_id, name, email',
				displayOptions: {
					show: {
						dataSource: ['csv', 'text'],
					},
				},
				description:
					'Comma-separated column names used when First Row Is Header is off (or for numbered regex groups)',
			},

			// ----------------------------------
			//       Schema Match / Mapping
			// ----------------------------------
			{
				displayName: 'Column Mapping Mode',
				name: 'mappingMode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Auto-Match (Fox Schema Smart Match)',
						value: 'auto',
						description:
							'Automatically match source fields to target table columns with optional overrides/transforms',
					},
					{
						name: 'Manual Column Mapping',
						value: 'manual',
						description: 'Explicitly map each source field or JSON path to a target table column',
					},
					{
						name: 'Positional (Column Order)',
						value: 'positional',
						description: 'Map source values by column position to target columns in order',
					},
				],
				default: 'auto',
			},
			{
				displayName: 'Match Rule',
				name: 'matchRule',
				type: 'options',
				displayOptions: {
					show: {
						mappingMode: ['auto'],
					},
				},
				options: [
					{
						name: 'Case-Insensitive',
						value: 'caseInsensitive',
						description: 'Match email -> EMAIL, Name -> name',
					},
					{
						name: 'Exact (Case-Sensitive)',
						value: 'exact',
						description: 'Require exact column name casing match',
					},
					{
						name: 'Normalized (Ignore _ / - / Case)',
						value: 'normalized',
						description: 'Match firstName / first-name / FIRST_NAME -> first_name',
					},
				],
				default: 'caseInsensitive',
			},
			{
				displayName: 'Unmatched Source Fields',
				name: 'unmatchedSourceBehavior',
				type: 'options',
				displayOptions: {
					show: {
						mappingMode: ['auto'],
					},
				},
				options: [
					{
						name: 'Ignore Extra Source Fields',
						value: 'ignore',
						description: 'Skip source fields that do not exist in the target table',
					},
					{
						name: 'Include As-Is (Bypass Schema Check)',
						value: 'include',
						description: 'Include unmatched fields directly in SQL statements',
					},
					{
						name: 'Treat as Row Error',
						value: 'error',
						description: 'Fail rows containing fields absent from the target table schema',
					},
				],
				default: 'ignore',
			},
			{
				displayName: 'Positional Target Columns',
				name: 'positionalColumns',
				type: 'string',
				default: '',
				placeholder: 'user_id, name, email (leave empty to use table column order)',
				displayOptions: {
					show: {
						mappingMode: ['positional'],
					},
				},
				description:
					'Comma-separated target columns in positional order; empty uses the table catalog order',
			},
			{
				displayName: 'Column Mappings / Overrides',
				name: 'manualMappings',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					multipleValueButtonText: 'Add Column Mapping',
				},
				placeholder: 'Add Column Mapping',
				default: {},
				displayOptions: {
					show: {
						mappingMode: ['auto', 'manual'],
					},
				},
				description:
					'Define explicit source-to-target mappings, value transforms, and defaults (overrides Auto-Match when matched)',
				options: [
					{
						name: 'mappingValues',
						displayName: 'Mapping',
						values: [
							{
								displayName: 'Default Value',
								name: 'defaultValue',
								type: 'string',
								default: '',
								description: 'Fallback value when source field is missing or empty',
							},
							{
								displayName: 'Skip If Empty',
								name: 'skipIfEmpty',
								type: 'boolean',
								default: false,
								description: 'Whether to omit this column when the source value is empty/null',
							},
							{
								displayName: 'Source Field / Path',
								name: 'sourceField',
								type: 'string',
								default: '',
								placeholder: 'user.email or col_name',
								description: 'Source field name or dot/bracket path',
							},
							{
								displayName: 'Target Column Name or ID',
								name: 'targetColumn',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getTargetColumns',
									loadOptionsDependsOn: ['tableId.value'],
								},
								default: '',
								description:
									'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{
								displayName: 'Transform',
								name: 'transform',
								type: 'options',
								options: [
									{ name: 'JSON Stringify', value: 'jsonStringify' },
									{ name: 'Lowercase', value: 'lowercase' },
									{ name: 'None', value: 'none' },
									{ name: 'Null If Empty', value: 'nullIfEmpty' },
									{ name: 'To Boolean', value: 'toBoolean' },
									{ name: 'To ISO Date', value: 'toIsoDate' },
									{ name: 'To Number', value: 'toNumber' },
									{ name: 'Trim Whitespace', value: 'trim' },
									{ name: 'Uppercase', value: 'uppercase' },
								],
								default: 'none',
							},
						],
					},
				],
			},
			{
				displayName: 'Match Key Column Names or IDs',
				name: 'matchKeySelect',
				type: 'multiOptions',
				typeOptions: {
					loadOptionsMethod: 'getTargetColumns',
					loadOptionsDependsOn: ['tableId.value'],
				},
				default: [],
				displayOptions: {
					show: {
						operation: ['update', 'upsert'],
					},
				},
				description:
					'Columns used to match existing rows for Update / Upsert. Leave empty to auto-detect Primary Key from FoxSchema catalog. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Match Key Columns (Override)',
				name: 'matchKeyColumns',
				type: 'string',
				default: '',
				placeholder: 'user_id or tenant_id, external_id (optional override)',
				displayOptions: {
					show: {
						operation: ['update', 'upsert'],
					},
				},
				description:
					'Optional comma-separated key columns override (supports expressions; takes precedence over dropdown selection)',
			},

			// ----------------------------------
			//          Error Handler
			// ----------------------------------
			{
				displayName: 'Error Handler',
				name: 'errorHandlerMode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Rollback Batch & Route to Error Output',
						value: 'rollbackAndRouteToError',
						description:
							'Wrap writes in a transaction, roll back on any failure, and emit error details to the Errors output',
					},
					{
						name: 'Route Failed Rows to Error Output',
						value: 'routeToErrorOutput',
						description:
							'Continue writing valid rows to Matched output (0) and route failed parse/match/DB rows to Errors output (1)',
					},
					{
						name: 'Skip Failed Rows & Log in Summary',
						value: 'skipAndLog',
						description:
							'Single output mode: continue valid rows and include failed rows in the summary errors array',
					},
					{
						name: 'Stop Workflow (Throw Error)',
						value: 'throwError',
						description:
							'Abort immediately and throw NodeOperationError on the first parse, schema, or database error',
					},
				],
				default: 'routeToErrorOutput',
				description: 'How parse, schema mismatch, coercion, and database errors should be handled',
			},
			{
				displayName: 'Error Handler Options',
				name: 'errorHandlerOptions',
				type: 'collection',
				placeholder: 'Add Error Handler Option',
				default: {},
				options: [
					{
						displayName: 'Fail on Regex Line Mismatch',
						name: 'failOnUnmatchedLine',
						type: 'boolean',
						default: true,
						description: 'Whether lines that do not match the Regex Pattern produce an error record',
					},
					{
						displayName: 'Isolate Failed Batch Rows',
						name: 'isolateFailedBatchRows',
						type: 'boolean',
						default: true,
						description:
							'Whether to retry a failed multi-row batch one row at a time so only bad rows route to Errors',
					},
					{
						displayName: 'Require Matched Row on Update',
						name: 'requireMatchedRow',
						type: 'boolean',
						default: false,
						description:
							'Whether an Update affecting 0 rows should be treated as a ROW_NOT_FOUND error',
					},
					{
						displayName: 'Retry Attempts',
						name: 'retryAttempts',
						type: 'number',
						default: 0,
						description: 'Number of retry attempts when a database statement fails',
					},
					{
						displayName: 'Retry Delay (Ms)',
						name: 'retryDelayMs',
						type: 'number',
						default: 300,
						description: 'Delay between retry attempts in milliseconds',
					},
					{
						displayName: 'Strict Type Validation',
						name: 'strictTypeValidation',
						type: 'boolean',
						default: true,
						description:
							'Whether invalid numbers, booleans, dates, or JSON fail validation before hitting the database',
					},
					{
						displayName: 'Validate Required NOT NULL Columns',
						name: 'validateRequiredColumns',
						type: 'boolean',
						default: true,
						description:
							'Whether inserts fail early when a NOT NULL column without a default is missing',
					},
				],
			},

			// ----------------------------------
			//         Output & Options
			// ----------------------------------
			{
				displayName: 'Output Mode',
				name: 'outputMode',
				type: 'options',
				options: [
					{
						name: 'One Item Per Matched Row',
						value: 'rowByRow',
						description: 'Emit each written/dry-run row as its own n8n output item',
					},
					{
						name: 'Summary Counts Only',
						value: 'summaryOnly',
						description: 'Emit counts and matched column metadata without row arrays',
					},
					{
						name: 'Summary With Results Array',
						value: 'summaryWithRows',
						description: 'Emit one summary item containing counts and results[]',
					},
				],
				default: 'summaryWithRows',
			},
			{
				displayName: 'Preview SQL (Dry Run)',
				name: 'dryRun',
				type: 'boolean',
				default: false,
				description:
					'Whether to parse, match, coerce, and compile SQL statements without writing to the target database',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Allow Unsafe SQL',
						name: 'allowUnsafeSql',
						type: 'boolean',
						default: false,
						description: 'Whether to allow SQL Expression typed bind parameters in Raw SQL Query mode',
					},
					{
						displayName: 'Batch Size',
						name: 'batchSize',
						type: 'number',
						default: 100,
						description: 'Maximum rows per multi-row Insert / Upsert statement (capped per dialect)',
					},
					{
						displayName: 'Comment Line Prefix',
						name: 'commentPrefix',
						type: 'string',
						default: '',
						placeholder: '# or --',
						description: 'Skip CSV/text lines starting with this prefix',
					},
					{
						displayName: 'Ignore Duplicates on Insert',
						name: 'ignoreDuplicates',
						type: 'boolean',
						default: false,
						description: 'Whether to emit ON CONFLICT DO NOTHING / INSERT IGNORE during Insert when supported',
					},
					{
						displayName: 'Include Identity Columns on Insert',
						name: 'includeIdentityOnInsert',
						type: 'boolean',
						default: false,
						description: 'Whether auto-matched identity/auto-increment columns are included in Insert',
					},
					{
						displayName: 'Skip Empty Lines',
						name: 'skipEmptyLines',
						type: 'boolean',
						default: true,
						description: 'Whether blank lines are ignored when parsing CSV or Text',
					},
					{
						displayName: 'Skip Null Values on Update',
						name: 'skipNullValuesOnUpdate',
						type: 'boolean',
						default: false,
						description: 'Whether null/empty mapped values are omitted from Update SET clauses',
					},
					{
						displayName: 'Skip Schema Lookup',
						name: 'skipSchemaLookup',
						type: 'boolean',
						default: false,
						description:
							'Whether to bypass FoxSchema catalog lookup (disables column discovery and type checks)',
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeoutMs',
						type: 'number',
						default: 15000,
						description: 'Database connection and query timeout in milliseconds',
					},
					{
						displayName: 'Treat Empty String as Null',
						name: 'emptyStringAsNull',
						type: 'boolean',
						default: true,
						description: 'Whether empty strings ("") are converted to SQL NULL',
					},
					{
						displayName: 'Trim Parsed Values',
						name: 'trimValues',
						type: 'boolean',
						default: true,
						description: 'Whether leading and trailing whitespace is trimmed from CSV/text cells',
					},
					{
						displayName: 'Use Transaction',
						name: 'useTransaction',
						type: 'boolean',
						default: false,
						description: 'Whether to wrap target writes in a single database transaction',
					},
				],
			},
		],
	};

	methods = {
		credentialTest: {
			async targetDbConnectionTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const credentials = credential.data as ICredentialDataDecryptedObject;
				const res = await testDbConnection(credentials);
				if (!res.ok) {
					return { status: 'Error', message: res.message };
				}
				return { status: 'OK', message: 'Target connection successful!' };
			},
		},
		listSearch: {
			searchTargetTables,
		},
		loadOptions: {
			getTargetColumns,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return runFoxSchemaMatch(this);
	}
}
