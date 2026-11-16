export const reports = [
  { id: 'operations', name: 'Свод по операциям за период', description: 'Операции подразделения за выбранный период.', nightOnly: true, parameterType: 'period', requiresAccount: false },
  { id: 'turnovers', name: 'Обороты по лицевому счету', description: 'Поступления и выбытия по лицевому счету.', nightOnly: false, parameterType: 'period', requiresAccount: true },
  { id: 'obligations', name: 'Исполнение бюджетных обязательств', description: 'Принятые и исполненные обязательства.', nightOnly: false, parameterType: 'period', requiresAccount: false },
  { id: 'payments', name: 'Реестр платежных документов', description: 'Перечень документов с суммами и статусами.', nightOnly: false, parameterType: 'period', requiresAccount: false },
  { id: 'balances', name: 'Остатки по лицевым счетам', description: 'Остатки денежных средств на выбранную дату.', nightOnly: false, parameterType: 'date', requiresAccount: false },
  { id: 'reconciliation', name: 'Сверка поступлений', description: 'Сопоставление поступлений за период.', nightOnly: false, parameterType: 'period', requiresAccount: false },
];

export const departments = [
  { id: '6000', name: 'Центральное управление' },
  { id: '6001', name: 'Территориальное управление' },
];

export class HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function moscowDate(date) {
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Europe/Moscow has a fixed UTC+3 offset (no daylight saving time).
export function inNightWindow(now) {
  const hour = new Date(now.getTime() + 3 * 60 * 60 * 1000).getUTCHours();
  return hour < 6;
}

export function nextNightWindow(now) {
  let start = new Date(`${moscowDate(now)}T00:00:00+03:00`);
  if (!inNightWindow(now)) start = new Date(start.getTime() + 86400000);
  return { start: start.toISOString(), end: new Date(start.getTime() + 6 * 3600000).toISOString() };
}

export function validateCreate(body, maxPeriodDays) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'INVALID_REQUEST', 'Некорректное задание.');
  const report = reports.find(item => item.id === body.reportId);
  if (!report) throw new HttpError(400, 'UNKNOWN_REPORT', 'Выберите доступный отчет.');
  const p = body.parameters;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new HttpError(400, 'INVALID_PARAMETERS', 'Укажите параметры отчета.');
  const fields = {};
  const clean = { department: p.department };
  if (!departments.some(item => item.id === p.department)) fields.department = 'Выберите подразделение из списка.';
  if (report.parameterType === 'date') {
    if (!isoDate(p.asOfDate)) fields.asOfDate = 'Укажите корректную дату.';
    clean.asOfDate = p.asOfDate;
  } else {
    if (!isoDate(p.startDate)) fields.startDate = 'Укажите корректную дату начала.';
    if (!isoDate(p.endDate)) fields.endDate = 'Укажите корректную дату окончания.';
    if (!fields.startDate && !fields.endDate) {
      const days = (Date.parse(p.endDate) - Date.parse(p.startDate)) / 86400000 + 1;
      if (days <= 0) fields.endDate = 'Дата окончания должна быть не раньше даты начала.';
      else if (days > maxPeriodDays) fields.endDate = `Не более ${maxPeriodDays} календарных дней включительно.`;
    }
    clean.startDate = p.startDate;
    clean.endDate = p.endDate;
  }
  if (report.requiresAccount) {
    if (typeof p.account !== 'string' || !/^\d{11}$/.test(p.account)) fields.account = 'Укажите лицевой счет из 11 цифр.';
    clean.account = p.account;
  }
  if (Object.keys(fields).length) throw new HttpError(400, 'INVALID_PARAMETERS', 'Проверьте параметры отчета.', fields);
  return { report, parameters: clean };
}
