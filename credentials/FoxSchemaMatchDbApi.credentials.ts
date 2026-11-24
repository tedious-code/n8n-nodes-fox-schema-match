import {
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

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

export class FoxSchemaMatchDbApi implements ICredentialType {
	name = 'foxSchemaMatchDbApi';
	displayName = 'Fox Schema Match Database API';
	documentationUrl = 'https://foxschema.com';
	icon = {
		light: 'file:foxschema.svg',
		dark: 'file:foxschema.dark.svg',
	} as const;

	properties: INodeProperties[] = [
		{
			displayName: 'Dialect',
			name: 'dialect',
			type: 'options',
			options: [
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
			],
			default: 'postgres',
			description: 'Target database dialect powered by FoxSchema (@foxschema/db). Db2 is not supported.',
		},
		{
			displayName: 'Host',
			name: 'host',
			type: 'string',
			required: true,
			default: 'localhost',
			displayOptions: {
				show: {
					dialect: NETWORK_DIALECTS,
				},
			},
		},
		{
			displayName: 'Database / Service',
			name: 'database',
			type: 'string',
			required: true,
			default: '',
			description:
				'Database name or Oracle service name / SID',
			displayOptions: {
				show: {
					dialect: NETWORK_DIALECTS,
				},
			},
		},
		{
			displayName: 'Database File Path',
			name: 'database',
			type: 'string',
			required: true,
			default: '',
			placeholder: '/data/app.db',
			description: 'Absolute path to the SQLite (.db) or DuckDB (.duckdb) file',
			displayOptions: {
				show: {
					dialect: FILE_DIALECTS,
				},
			},
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			required: true,
			default: '',
			displayOptions: {
				show: {
					dialect: NETWORK_DIALECTS,
				},
			},
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: {
				password: true,
			},
			required: false,
			default: '',
			displayOptions: {
				show: {
					dialect: NETWORK_DIALECTS,
				},
			},
		},
		{
			displayName: 'Port',
			name: 'port',
			type: 'number',
			default: 5432,
			displayOptions: {
				show: {
					dialect: NETWORK_DIALECTS,
				},
			},
		},
		{
			displayName: 'Schema',
			name: 'schema',
			type: 'string',
			default: '',
			description:
				'Optional schema / owner / database. Defaults: public (Postgres), dbo (SQL Server), database name (MySQL/ClickHouse), username (Oracle), main (DuckDB).',
		},
		{
			displayName: 'Use SSL',
			name: 'useSsl',
			type: 'boolean',
			default: false,
			displayOptions: {
				show: {
					dialect: NETWORK_DIALECTS,
				},
			},
		},
		{
			displayName: 'Reject Unauthorized SSL',
			name: 'rejectUnauthorized',
			type: 'boolean',
			default: true,
			displayOptions: {
				show: {
					useSsl: [true],
					dialect: NETWORK_DIALECTS,
				},
			},
		},
	];

	test: ICredentialTestRequest = {
		request: {
			baseURL: '=http://{{$credentials.host}}:{{$credentials.port}}',
			url: '/',
		},
	};
}
