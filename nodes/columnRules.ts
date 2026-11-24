import type {
	ColumnDataTypeOverride,
	ColumnValidationRule,
	DateTimeOutputFormat,
	InputDateFormat,
	MatchErrorCode,
} from './types';

export class ColumnRuleError extends Error {
	constructor(
		readonly errorCode: MatchErrorCode,
		readonly column: string,
		message: string,
	) {
		super(message);
	}
}

export function parseDateInput(
	raw: unknown,
	inputFormat: InputDateFormat = 'auto',
): Date {
	if (raw instanceof Date) {
		if (Number.isNaN(raw.getTime())) {
			throw new Error('Invalid Date object');
		}
		return raw;
	}

	if (typeof raw === 'number') {
		if (!Number.isFinite(raw)) {
			throw new Error(`Invalid numeric date: ${raw}`);
		}
		if (inputFormat === 'unixSeconds') return new Date(raw * 1000);
		if (inputFormat === 'unixMs') return new Date(raw);
		// Auto-detect seconds vs milliseconds
		const ms = Math.abs(raw) < 1e12 ? raw * 1000 : raw;
		return new Date(ms);
	}

	const str = String(raw ?? '').trim();
	if (!str) {
		throw new Error('Empty date string');
	}

	if (inputFormat === 'unixSeconds') {
		const n = Number(str);
		if (!Number.isFinite(n)) throw new Error(`Expected unix seconds, got "${str}"`);
		return new Date(n * 1000);
	}

	if (inputFormat === 'unixMs') {
		const n = Number(str);
		if (!Number.isFinite(n)) throw new Error(`Expected unix milliseconds, got "${str}"`);
		return new Date(n);
	}

	if (inputFormat === 'MM/DD/YYYY' || inputFormat === 'DD/MM/YYYY') {
		const m = str.match(
			/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
		);
		if (!m) {
			throw new Error(`Value "${str}" does not match format ${inputFormat}`);
		}
		const part1 = Number(m[1]);
		const part2 = Number(m[2]);
		const year = Number(m[3]);
		const month = inputFormat === 'MM/DD/YYYY' ? part1 : part2;
		const day = inputFormat === 'MM/DD/YYYY' ? part2 : part1;
		const hour = m[4] ? Number(m[4]) : 0;
		const min = m[5] ? Number(m[5]) : 0;
		const sec = m[6] ? Number(m[6]) : 0;

		const d = new Date(Date.UTC(year, month - 1, day, hour, min, sec));
		if (
			d.getUTCFullYear() !== year ||
			d.getUTCMonth() !== month - 1 ||
			d.getUTCDate() !== day ||
			d.getUTCHours() !== hour ||
			d.getUTCMinutes() !== min ||
			d.getUTCSeconds() !== sec
		) {
			throw new Error(`Calendar date "${str}" is out of range for ${inputFormat}`);
		}
		return d;
	}

	if (inputFormat === 'YYYY-MM-DD') {
		const m = str.match(
			/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
		);
		if (!m) {
			throw new Error(`Value "${str}" does not match YYYY-MM-DD`);
		}
		const year = Number(m[1]);
		const month = Number(m[2]);
		const day = Number(m[3]);
		const hour = m[4] ? Number(m[4]) : 0;
		const min = m[5] ? Number(m[5]) : 0;
		const sec = m[6] ? Number(m[6]) : 0;
		const d = new Date(Date.UTC(year, month - 1, day, hour, min, sec));
		if (
			d.getUTCFullYear() !== year ||
			d.getUTCMonth() !== month - 1 ||
			d.getUTCDate() !== day
		) {
			throw new Error(`Calendar date "${str}" is out of range`);
		}
		return d;
	}

	// Auto mode: pure numeric string epoch check
	if (/^-?\d{10,13}$/.test(str)) {
		const n = Number(str);
		const ms = str.length <= 10 ? n * 1000 : n;
		return new Date(ms);
	}

	// Standard ISO / RFC date parse
	const parsed = new Date(str);
	if (!Number.isNaN(parsed.getTime())) {
		return parsed;
	}

	// Fallback MM/DD/YYYY in auto mode
	const slashMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (slashMatch) {
		return parseDateInput(str, 'MM/DD/YYYY');
	}

	throw new Error(`Unable to parse date/time value "${str}"`);
}

function formatDatePartsInTimezone(
	date: Date,
	timeZone: string,
): { year: string; month: string; day: string; hour: string; minute: string; second: string } {
	const fmt = new Intl.DateTimeFormat('en-CA', {
		timeZone: timeZone || 'UTC',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	});
	const parts = fmt.formatToParts(date);
	const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
	const rawHour = pick('hour');
	return {
		year: pick('year'),
		month: pick('month'),
		day: pick('day'),
		hour: rawHour === '24' ? '00' : rawHour,
		minute: pick('minute'),
		second: pick('second'),
	};
}

export function formatDateOutput(
	date: Date,
	outputFormat: DateTimeOutputFormat,
	targetTimezone = 'UTC',
): string | number {
	const tz = targetTimezone.trim() || 'UTC';

	switch (outputFormat) {
		case 'unixSeconds':
			return Math.floor(date.getTime() / 1000);
		case 'unixMs':
			return date.getTime();
		case 'sqlDate': {
			const p = formatDatePartsInTimezone(date, tz);
			return `${p.year}-${p.month}-${p.day}`;
		}
		case 'sqlTime': {
			const p = formatDatePartsInTimezone(date, tz);
			return `${p.hour}:${p.minute}:${p.second}`;
		}
		case 'sqlDateTime': {
			const p = formatDatePartsInTimezone(date, tz);
			return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
		}
		case 'iso':
		default: {
			if (tz.toUpperCase() === 'UTC') {
				return date.toISOString();
			}
			const p = formatDatePartsInTimezone(date, tz);
			return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
		}
	}
}

function coerceByDataTypeOverride(
	colName: string,
	value: unknown,
	dataType: ColumnDataTypeOverride,
): unknown {
	if (value === null || value === undefined) return null;

	switch (dataType) {
		case 'string':
			return typeof value === 'object' ? JSON.stringify(value) : String(value);
		case 'integer': {
			const n = typeof value === 'number' ? value : Number(String(value).trim().replace(/,/g, ''));
			if (!Number.isInteger(n)) {
				throw new ColumnRuleError(
					'TYPE_COERCION',
					colName,
					`Column "${colName}" expected integer, got "${value}"`,
				);
			}
			return n;
		}
		case 'decimal': {
			const n = typeof value === 'number' ? value : Number(String(value).trim().replace(/,/g, ''));
			if (!Number.isFinite(n)) {
				throw new ColumnRuleError(
					'TYPE_COERCION',
					colName,
					`Column "${colName}" expected decimal number, got "${value}"`,
				);
			}
			return n;
		}
		case 'boolean': {
			if (typeof value === 'boolean') return value;
			if (typeof value === 'number') return value !== 0;
			const s = String(value).trim().toLowerCase();
			if (['true', '1', 'yes', 'y', 't', 'on'].includes(s)) return true;
			if (['false', '0', 'no', 'n', 'f', 'off'].includes(s)) return false;
			throw new ColumnRuleError(
				'TYPE_COERCION',
				colName,
				`Column "${colName}" expected boolean, got "${value}"`,
			);
		}
		case 'json': {
			if (typeof value === 'object') return JSON.stringify(value);
			const s = String(value);
			let ok = false;
			try {
				JSON.parse(s);
				ok = true;
			} catch {
				ok = false;
			}
			if (!ok) {
				throw new ColumnRuleError(
					'TYPE_COERCION',
					colName,
					`Column "${colName}" expected valid JSON`,
				);
			}
			return s;
		}
		case 'date':
		case 'datetime':
		case 'auto':
		default:
			return value;
	}
}

/**
 * Apply per-column cleanup, regex (validate / extract / replace),
 * date/time parsing + formatting, data type validation, and min/max/enum rules.
 */
export function applyColumnValidationRule(
	colName: string,
	rawValue: unknown,
	rule: ColumnValidationRule,
	emptyStringAsNull: boolean,
): unknown {
	let val = rawValue;

	const failWith = (code: MatchErrorCode, defaultMsg: string): never => {
		const msg = rule.validationMessage?.trim()
			? `${rule.validationMessage.trim()} (column "${colName}": ${defaultMsg})`
			: defaultMsg;
		throw new ColumnRuleError(code, colName, msg);
	};

	// 1. Default value fallback when missing or empty
	const isInitiallyEmpty =
		val === undefined ||
		val === null ||
		(typeof val === 'string' && val.trim() === '');

	if (isInitiallyEmpty && rule.defaultValue !== undefined && rule.defaultValue !== '') {
		val = rule.defaultValue;
	}

	// 2. Trim & case transform on strings
	if (typeof val === 'string') {
		let s = val;
		if (rule.trim) s = s.trim();
		if (rule.caseTransform === 'lowercase') s = s.toLowerCase();
		else if (rule.caseTransform === 'uppercase') s = s.toUpperCase();
		val = emptyStringAsNull && s === '' ? null : s;
	}

	// 3. Required check
	const isNowEmpty =
		val === undefined || val === null || (typeof val === 'string' && val === '');
	if (rule.required && isNowEmpty) {
		failWith('VALIDATION_ERROR', `Column "${colName}" is required and cannot be empty`);
	}

	if (val === undefined || val === null) {
		return null;
	}

	// 4. Regex validate / extract / replace
	if (rule.regexPattern && rule.regexPattern.length > 0) {
		const action = rule.regexAction || 'validate';
		const flags =
			rule.regexFlags !== undefined && rule.regexFlags !== ''
				? rule.regexFlags
				: action === 'replace'
					? 'g'
					: '';
		let re: RegExp;
		let regexCompileErr: string | null = null;
		try {
			re = new RegExp(rule.regexPattern, flags);
		} catch (err: any) {
			regexCompileErr = err?.message || String(err);
			re = /(?:)/;
		}
		if (regexCompileErr) {
			failWith(
				'REGEX_VALIDATION',
				`Invalid regex pattern for column "${colName}": ${regexCompileErr}`,
			);
		}

		const strVal = String(val);
		if (action === 'validate') {
			if (!re.test(strVal)) {
				failWith(
					'REGEX_VALIDATION',
					`Column "${colName}" value "${strVal}" failed regex /${rule.regexPattern}/${flags}`,
				);
			}
		} else if (action === 'extract') {
			const match = re.exec(strVal);
			if (!match) {
				if (rule.failOnRegexMismatch !== false) {
					failWith(
						'REGEX_VALIDATION',
						`Column "${colName}" value "${strVal}" did not match regex /${rule.regexPattern}/${flags}`,
					);
				}
				val = null;
			} else {
				val = match.groups?.value ?? match[1] ?? match[0];
			}
		} else if (action === 'replace') {
			val = strVal.replace(re, rule.regexReplacement ?? '');
		}
	}

	if (val === null || val === undefined) {
		return null;
	}

	// 5. Date / Time conversion
	const wantsDateConversion =
		(rule.dateTimeOutput && rule.dateTimeOutput !== 'none') ||
		rule.dataType === 'date' ||
		rule.dataType === 'datetime' ||
		(rule.inputDateFormat && rule.inputDateFormat !== 'auto');

	if (wantsDateConversion) {
		let parsed: Date | null = null;
		let parseErr: string | null = null;
		try {
			parsed = parseDateInput(val, rule.inputDateFormat || 'auto');
		} catch (err: any) {
			parseErr = err?.message || String(err);
		}
		if (parseErr || !parsed) {
			failWith('DATE_PARSE_ERROR', `Column "${colName}": ${parseErr}`);
		}
		const outputFormat: DateTimeOutputFormat =
			rule.dateTimeOutput && rule.dateTimeOutput !== 'none'
				? rule.dateTimeOutput
				: rule.dataType === 'date'
					? 'sqlDate'
					: 'iso';
		val = formatDateOutput(parsed!, outputFormat, rule.targetTimezone || 'UTC');
	}

	// 6. Explicit Data Type coercion
	if (rule.dataType && rule.dataType !== 'auto') {
		val = coerceByDataTypeOverride(colName, val, rule.dataType);
	}

	// 7. Allowed values (enum) validation
	if (rule.allowedValues && rule.allowedValues.trim()) {
		const allowed = rule.allowedValues
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (allowed.length > 0 && !allowed.includes(String(val))) {
			failWith(
				'VALIDATION_ERROR',
				`Column "${colName}" value "${val}" must be one of: ${allowed.join(', ')}`,
			);
		}
	}

	// 8. Min / Max validation (numeric value or string length)
	if (rule.minValue !== undefined && rule.minValue !== '') {
		const minNum = Number(rule.minValue);
		if (typeof val === 'number') {
			if (Number.isFinite(minNum) && val < minNum) {
				failWith('VALIDATION_ERROR', `Column "${colName}" value ${val} is below minimum ${minNum}`);
			}
		} else if (typeof val === 'string' && Number.isFinite(minNum) && val.length < minNum) {
			failWith(
				'VALIDATION_ERROR',
				`Column "${colName}" length ${val.length} is shorter than minimum ${minNum}`,
			);
		}
	}

	if (rule.maxValue !== undefined && rule.maxValue !== '') {
		const maxNum = Number(rule.maxValue);
		if (typeof val === 'number') {
			if (Number.isFinite(maxNum) && val > maxNum) {
				failWith('VALIDATION_ERROR', `Column "${colName}" value ${val} exceeds maximum ${maxNum}`);
			}
		} else if (typeof val === 'string' && Number.isFinite(maxNum) && val.length > maxNum) {
			failWith(
				'VALIDATION_ERROR',
				`Column "${colName}" length ${val.length} exceeds maximum ${maxNum}`,
			);
		}
	}

	return val;
}
