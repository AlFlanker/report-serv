import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReportData, validateFixture } from './mock-source.mjs';

const period = { department: '6000', startDate: '2026-11-01', endDate: '2026-11-15' };

test('prepared report data respects period, department, account and snapshot selection', async () => {
  const operations = await readReportData('operations', period);
  assert.equal(operations.rows.length, 5);
  assert.equal(operations.rows[0].date, period.startDate);
  assert.equal(operations.rows.at(-1).date, period.endDate);
  assert.ok(operations.rows.every(row => row.department === '6000'));
  const otherDepartment = await readReportData('operations', { ...period, department: '6001' });
  assert.equal(otherDepartment.rows.length, 2);
  assert.ok(otherDepartment.rows.every(row => row.department === '6001'));

  const turnovers = await readReportData('turnovers', {
    ...period, startDate: '2026-10-01', endDate: '2026-10-31', account: '03210001234',
  });
  assert.equal(turnovers.rows.length, 5);
  assert.ok(turnovers.rows.every(row => row.account === '03210001234'));
  const balances = await readReportData('balances', { department: '6000', asOfDate: '2026-11-14' });
  assert.equal(balances.rows.length, 2);
  assert.ok(balances.rows.every(row => row.date === '2026-10-31'));
  assert.equal((await readReportData('balances', { department: '6000', asOfDate: '2026-10-01' })).rows.length, 0);
});

test('all report fixtures expose usable scalar data and fresh result objects', async () => {
  for (const id of ['obligations', 'payments', 'reconciliation']) {
    const report = await readReportData(id, period);
    assert.ok(report.rows.length > 0, id);
    assert.ok(report.columns.every(column => column.key && column.title), id);
    assert.ok(report.rows.every(row => Object.values(row).every(value => ['string', 'number'].includes(typeof value))), id);
    report.rows[0].department = 'changed';
    report.columns[0].title = 'changed';
    const fresh = await readReportData(id, period);
    assert.equal(fresh.rows[0].department, '6000');
    assert.notEqual(fresh.columns[0].title, 'changed');
  }
  const empty = await readReportData('payments', { ...period, startDate: '2027-01-01', endDate: '2027-01-31' });
  assert.equal(empty.rows.length, 0);
  assert.ok(empty.columns.length > 0);
});

test('invalid adapter parameters fail explicitly', async () => {
  await assert.rejects(readReportData('../payments', period), { code: 'UNKNOWN_REPORT' });
  await assert.rejects(readReportData('payments', null), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(readReportData('payments', { ...period, startDate: '2026-02-30' }), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(readReportData('payments', { ...period, startDate: '2026-11-16' }), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(readReportData('turnovers', period), { code: 'INVALID_PARAMETERS' });
});

test('malformed response schemas and rows are classified as REPORT_FORMAT_MISMATCH', () => {
  const good = {
    columns: [
      { key: 'date', title: 'Дата', type: 'date' },
      { key: 'department', title: 'Подразделение', type: 'string' },
      { key: 'amount', title: 'Сумма', type: 'number' },
    ],
    rows: [{ date: '2026-11-01', department: '6000', amount: 10.50 }],
  };
  assert.doesNotThrow(() => validateFixture('payments', good));
  const badResponses = [
    null,
    false,
    [],
    {},
    { columns: null, rows: [] },
    { columns: [null], rows: [] },
    { columns: [false], rows: [] },
    { columns: [[]], rows: [] },
    { ...good, rows: [null] },
    { ...good, rows: [false] },
    { ...good, rows: [[]] },
    { ...good, rows: [{ ...good.rows[0], amount: '10.50' }] },
    { ...good, rows: [{ ...good.rows[0], amount: Infinity }] },
    { ...good, rows: [{ ...good.rows[0], date: '2026-02-30' }] },
    { ...good, rows: [{ ...good.rows[0], unexpected: true }] },
    { ...good, columns: [...good.columns, good.columns[0]] },
    { ...good, columns: good.columns.map(column => column.key === 'date' ? { ...column, type: 'string' } : column) },
  ];
  for (const response of badResponses) {
    assert.throws(() => validateFixture('payments', response), { code: 'REPORT_FORMAT_MISMATCH' });
  }
  assert.throws(() => validateFixture('turnovers', good), { code: 'REPORT_FORMAT_MISMATCH' });
});
