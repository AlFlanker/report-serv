import { readFile } from 'node:fs/promises';

const reportIds = new Set(['operations', 'turnovers', 'obligations', 'payments', 'balances', 'reconciliation']);

function failure(message, code = 'REPORT_FORMAT_MISMATCH') {
  return Object.assign(new Error(message), { code });
}

function isDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** Validate a target-system response without altering it or accessing files. */
export function validateFixture(reportId, fixture, { signal } = {}) {
  signal?.throwIfAborted();
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)
    || !Array.isArray(fixture.columns) || !fixture.columns.length || !Array.isArray(fixture.rows)) {
    throw failure('Полученные данные не соответствуют формату отчёта.');
  }
  const keys = new Set();
  for (const column of fixture.columns) {
    signal?.throwIfAborted();
    if (!column || typeof column !== 'object' || Array.isArray(column)
      || typeof column.key !== 'string' || !column.key || keys.has(column.key)
      || typeof column.title !== 'string' || !column.title
      || !['date', 'string', 'number'].includes(column.type)
      || (column.width !== undefined && (!Number.isFinite(column.width) || column.width <= 0))) {
      throw failure('Некорректное описание столбцов отчёта.');
    }
    keys.add(column.key);
  }
  if (!keys.has('date') || !keys.has('department') || (reportId === 'turnovers' && !keys.has('account'))) {
    throw failure('В ответе целевой системы отсутствуют обязательные столбцы.');
  }
  if (fixture.columns.find(column => column.key === 'date').type !== 'date'
    || fixture.columns.find(column => column.key === 'department').type !== 'string'
    || (reportId === 'turnovers' && fixture.columns.find(column => column.key === 'account').type !== 'string')) {
    throw failure('Типы обязательных столбцов не соответствуют формату отчёта.');
  }
  for (const row of fixture.rows) {
    signal?.throwIfAborted();
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(key => !keys.has(key))) {
      throw failure('Некорректная строка ответа целевой системы.');
    }
    for (const { key, type } of fixture.columns) {
      const value = row[key];
      const valid = type === 'date' ? isDate(value)
        : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === 'string';
      if (!valid) throw failure('Полученные данные не соответствуют формату отчёта.');
    }
  }
}

/**
 * Prepared responses of the target systems: no network or target database calls.
 * The small, fixed JSON fixtures are loaded once per request. Rows are filtered
 * lazily and copied individually, without allocating a second result array.
 * A real target-system adapter should expose a cursor through this AsyncIterable
 * contract, honor the AbortSignal and close its cursor when iteration ends.
 * Period reports use fixed October/November 2026 data and may return zero rows;
 * balances use the latest prepared snapshot on or before the requested date.
 */
export async function openReportData(reportId, parameters, { signal } = {}) {
  signal?.throwIfAborted();
  if (!reportIds.has(reportId)) throw failure('Неизвестный отчёт.', 'UNKNOWN_REPORT');
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)
    || typeof parameters.department !== 'string' || !parameters.department) {
    throw failure('Не указано подразделение.', 'INVALID_PARAMETERS');
  }
  if (reportId === 'balances') {
    if (!isDate(parameters.asOfDate)) throw failure('Некорректная дата отчёта.', 'INVALID_PARAMETERS');
  } else if (!isDate(parameters.startDate) || !isDate(parameters.endDate) || parameters.startDate > parameters.endDate) {
    throw failure('Некорректный период отчёта.', 'INVALID_PARAMETERS');
  }
  if (reportId === 'turnovers' && (typeof parameters.account !== 'string' || !parameters.account)) {
    throw failure('Не указан лицевой счёт.', 'INVALID_PARAMETERS');
  }

  let fixture;
  try {
    fixture = JSON.parse(await readFile(new URL(`./fixtures/${reportId}.json`, import.meta.url), { encoding: 'utf8', signal }));
  } catch {
    signal?.throwIfAborted();
    throw failure('Подготовленный ответ целевой системы недоступен или повреждён.');
  }
  validateFixture(reportId, fixture, { signal });

  let latestDate = '';
  if (reportId === 'balances') {
    for (const row of fixture.rows) {
      signal?.throwIfAborted();
      if (row.department === parameters.department && row.date <= parameters.asOfDate && row.date > latestDate) latestDate = row.date;
    }
  }
  return {
    columns: fixture.columns.map(({ key, title, width }) => ({ key, title, ...(width === undefined ? {} : { width }) })),
    rows: (async function* () {
      for (const row of fixture.rows) {
        signal?.throwIfAborted();
        if (row.department !== parameters.department) continue;
        if (reportId === 'balances') {
          if (row.date !== latestDate) continue;
        } else if (row.date < parameters.startDate || row.date > parameters.endDate) continue;
        if (reportId === 'turnovers' && row.account !== parameters.account) continue;
        // Fixture validation permits only scalar cells, so this copies one row.
        yield { ...row };
      }
      signal?.throwIfAborted();
    })(),
  };
}

/** Compatibility helper for small-fixture tests; production uses openReportData. */
export async function readReportData(reportId, parameters, options) {
  const source = await openReportData(reportId, parameters, options);
  const rows = [];
  for await (const row of source.rows) rows.push(row);
  return { columns: source.columns, rows };
}
