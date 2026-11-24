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
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import { testDbConnection } from '../dbConnection';
import { runFoxSchemaMatch } from '../matchPipeline';
import {
	getMappingColumns,
	getTargetColumns,
	searchTargetTables,
} from '../schemaCache';

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
		subtitle: '={{$parameter["operation"] + " · " + ($parameter["tableId"]?.value || "table")}}',
		description:
			'Load target table schema via FoxSchema, map input items manually or automatically with data type validation, regex rules, and date/time conversion, execute Insert / Update / Upsert across 13 SQL dialects, and route errors cleanly',
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
				'match',
				'upsert',
				'insert',
				'update',
				'mapping',
				'validation',
				'regex',
				'datetime',
				'sql',
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
					'Powered by <a href="https://foxschema.com" target="_blank">FoxSchema (@foxschema/db + @foxschema/sql)</a> — Schema-mapped Insert, Update &amp; Upsert across 13 SQL dialects with validation, regex, and date/time conversion.',
				name: 'foxSchemaBacklink',
				type: 'notice',
				default: '',
			},

			// ----------------------------------
			//         Operation & Table
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
						description: 'Insert mapped rows into the target database table',
						action: 'Insert mapped rows into table',
					},
					{
						name: 'Update',
						value: 'update',
						description: 'Update existing rows in the target table by match key columns',
						action: 'Update mapped rows in table',
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
				description: 'Target database table whose schema and columns are loaded via FoxSchema',
			},

			// ----------------------------------
			//         Column Mapping
			// ----------------------------------
			{
				displayName: 'Column Mapping Mode',
				name: 'mappingMode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Auto-Match (Smart Field Match)',
						value: 'auto',
						description:
							'Automatically match incoming item fields to target table columns',
					},
					{
						name: 'Manual Field Mapping',
						value: 'manual',
						description: 'Map specific source field paths to target columns with transforms',
					},
					{
						name: 'Visual Table Mapper (Columns UI)',
						value: 'resourceMapper',
						description:
							'Load every database column into the UI to map each column manually or automatically',
					},
				],
				default: 'resourceMapper',
			},
			{
				displayName: 'Columns',
				name: 'columns',
				type: 'resourceMapper',
				noDataExpression: true,
				default: {
					mappingMode: 'defineBelow',
					value: null,
				},
				required: true,
				displayOptions: {
					show: {
						mappingMode: ['resourceMapper'],
						operation: ['insert'],
					},
				},
				typeOptions: {
					loadOptionsDependsOn: ['tableId.value', 'operation'],
					resourceMapper: {
						resourceMapperMethod: 'getMappingColumns',
						mode: 'add',
						fieldWords: {
							singular: 'column',
							plural: 'columns',
						},
						addAllFields: true,
						multiKeyMatch: true,
						supportAutoMap: true,
					},
				},
			},
			{
				displayName: 'Columns',
				name: 'columns',
				type: 'resourceMapper',
				noDataExpression: true,
				default: {
					mappingMode: 'defineBelow',
					value: null,
				},
				required: true,
				displayOptions: {
					show: {
						mappingMode: ['resourceMapper'],
						operation: ['update'],
					},
				},
				typeOptions: {
					loadOptionsDependsOn: ['tableId.value', 'operation'],
					resourceMapper: {
						resourceMapperMethod: 'getMappingColumns',
						mode: 'update',
						fieldWords: {
							singular: 'column',
							plural: 'columns',
						},
						addAllFields: true,
						multiKeyMatch: true,
						supportAutoMap: true,
					},
				},
			},
			{
				displayName: 'Columns',
				name: 'columns',
				type: 'resourceMapper',
				noDataExpression: true,
				default: {
					mappingMode: 'defineBelow',
					value: null,
				},
				required: true,
				displayOptions: {
					show: {
						mappingMode: ['resourceMapper'],
						operation: ['upsert'],
					},
				},
				typeOptions: {
					loadOptionsDependsOn: ['tableId.value', 'operation'],
					resourceMapper: {
						resourceMapperMethod: 'getMappingColumns',
						mode: 'upsert',
						fieldWords: {
							singular: 'column',
							plural: 'columns',
						},
						addAllFields: true,
						multiKeyMatch: true,
						supportAutoMap: true,
					},
				},
			},
			{
				displayName: 'Match Rule',
				name: 'matchRule',
				type: 'options',
				displayOptions: {
					show: {
						mappingMode: ['auto', 'resourceMapper'],
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
				displayName: 'Manual Field Mappings',
				name: 'manualMappings',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					multipleValueButtonText: 'Add Field Mapping',
				},
				placeholder: 'Add Field Mapping',
				default: {},
				displayOptions: {
					show: {
						mappingMode: ['manual'],
					},
				},
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
							},
							{
								displayName: 'Skip If Empty',
								name: 'skipIfEmpty',
								type: 'boolean',
								default: false,
							},
							{
								displayName: 'Source Field / Path',
								name: 'sourceField',
								type: 'string',
								default: '',
								placeholder: 'user.email or col_name',
								description: 'Incoming JSON field name or dot/bracket path',
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
						mappingMode: ['auto', 'manual'],
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
						mappingMode: ['auto', 'manual'],
					},
				},
				description:
					'Optional comma-separated key columns override (takes precedence over dropdown selection)',
			},

			// ----------------------------------
			//  Validation, Regex & Date/Time
			// ----------------------------------
			{
				displayName: 'Column Rules (Data Type, Validation, Regex & Date/Time)',
				name: 'columnRules',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
					multipleValueButtonText: 'Add Column Rule',
				},
				placeholder: 'Add Column Rule',
				default: {},
				description:
					'Configure per-column data type enforcement, required/min/max/allowed-value validation, regex validate/extract/replace, and date/time format & timezone conversion',
				options: [
					{
						name: 'ruleValues',
						displayName: 'Column Rule',
						values: [
							{
								displayName: 'Allowed Values (Comma-Separated)',
								name: 'allowedValues',
								type: 'string',
								default: '',
								placeholder: 'free, pro, enterprise',
							},
							{
								displayName: 'Case Transform',
								name: 'caseTransform',
								type: 'options',
								options: [
									{ name: 'Lowercase', value: 'lowercase' },
									{ name: 'None', value: 'none' },
									{ name: 'Uppercase', value: 'uppercase' },
								],
								default: 'none',
							},
							{
								displayName: 'Column Name or ID',
								name: 'targetColumn',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getTargetColumns',
									loadOptionsDependsOn: ['tableId.value'],
								},
								default: '',
								description:
									'Target table column to validate or transform. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
							},
							{
								displayName: 'Custom Validation Message',
								name: 'validationMessage',
								type: 'string',
								default: '',
								placeholder: 'Invalid email address',
							},
							{
								displayName: 'Data Type',
								name: 'dataType',
								type: 'options',
								options: [
									{ name: 'Auto (From Database Schema)', value: 'auto' },
									{ name: 'Boolean', value: 'boolean' },
									{ name: 'Date', value: 'date' },
									{ name: 'Date & Time', value: 'datetime' },
									{ name: 'Decimal / Float', value: 'decimal' },
									{ name: 'Integer', value: 'integer' },
									{ name: 'JSON', value: 'json' },
									{ name: 'String', value: 'string' },
								],
								default: 'auto',
							},
							{
								displayName: 'Date / Time Input Format',
								name: 'inputDateFormat',
								type: 'options',
								options: [
									{ name: 'Auto-Detect', value: 'auto' },
									{ name: 'DD/MM/YYYY', value: 'DD/MM/YYYY' },
									{ name: 'MM/DD/YYYY', value: 'MM/DD/YYYY' },
									{ name: 'Unix Milliseconds', value: 'unixMs' },
									{ name: 'Unix Seconds', value: 'unixSeconds' },
									{ name: 'YYYY-MM-DD', value: 'YYYY-MM-DD' },
								],
								default: 'auto',
							},
							{
								displayName: 'Date / Time Output Format',
								name: 'dateTimeOutput',
								type: 'options',
								options: [
									{ name: 'ISO 8601', value: 'iso' },
									{ name: 'None (Keep As-Is)', value: 'none' },
									{ name: 'SQL Date (YYYY-MM-DD)', value: 'sqlDate' },
									{ name: 'SQL DateTime', value: 'sqlDateTime', description: 'Format as YYYY-MM-DD HH:mm:ss' },
									{ name: 'SQL Time', value: 'sqlTime', description: 'Format as HH:mm:ss' },
									{ name: 'Unix Milliseconds', value: 'unixMs' },
									{ name: 'Unix Seconds', value: 'unixSeconds' },
								],
								default: 'none',
							},
							{
								displayName: 'Default Value',
								name: 'defaultValue',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Fail If Regex Does Not Match',
								name: 'failOnRegexMismatch',
								type: 'boolean',
								default: true,
								description: 'Whether an Extract regex miss raises a REGEX_VALIDATION error instead of setting null',
							},
							{
								displayName: 'Max Value / Length',
								name: 'maxValue',
								type: 'string',
								default: '',
								description: 'Maximum numeric value or maximum string length',
							},
							{
								displayName: 'Min Value / Length',
								name: 'minValue',
								type: 'string',
								default: '',
								description: 'Minimum numeric value or minimum string length',
							},
							{
								displayName: 'Regex Action',
								name: 'regexAction',
								type: 'options',
								options: [
									{ name: 'Extract Match / Capture Group', value: 'extract' },
									{ name: 'Find & Replace', value: 'replace' },
									{ name: 'Validate Pattern', value: 'validate' },
								],
								default: 'validate',
							},
							{
								displayName: 'Regex Flags',
								name: 'regexFlags',
								type: 'string',
								default: '',
								placeholder: 'i or gi',
							},
							{
								displayName: 'Regex Pattern',
								name: 'regexPattern',
								type: 'string',
								default: '',
								placeholder: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
							},
							{
								displayName: 'Regex Replacement',
								name: 'regexReplacement',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Required (Disallow Empty / Null)',
								name: 'required',
								type: 'boolean',
								default: false,
							},
							{
								displayName: 'Target Timezone',
								name: 'targetTimezone',
								type: 'string',
								default: 'UTC',
								placeholder: 'UTC, America/Chicago, Asia/Ho_Chi_Minh',
								description: 'IANA timezone used when converting date/time outputs',
							},
							{
								displayName: 'Trim Whitespace',
								name: 'trim',
								type: 'boolean',
								default: false,
							},
						],
					},
				],
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
							'Continue writing valid rows to Matched output (0) and route failed validation/regex/DB rows to Errors output (1)',
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
							'Abort immediately and throw NodeOperationError on the first validation or database error',
					},
				],
				default: 'routeToErrorOutput',
				description: 'How validation, regex, date conversion, and database errors should be handled',
			},
			{
				displayName: 'Error Handler Options',
				name: 'errorHandlerOptions',
				type: 'collection',
				placeholder: 'Add Error Handler Option',
				default: {},
				options: [
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
					'Whether to validate, coerce, and compile SQL statements without writing to the target database',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Batch Size',
						name: 'batchSize',
						type: 'number',
						default: 100,
						description: 'Maximum rows per multi-row Insert / Upsert statement (capped per dialect)',
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
							'Whether to bypass FoxSchema catalog lookup (disables column discovery and schema checks)',
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
		resourceMapping: {
			getMappingColumns,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		return runFoxSchemaMatch(this);
	}
}
