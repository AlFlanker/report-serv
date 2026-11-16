import ExcelJS from 'exceljs';
import { readReportData } from './mock-source.mjs';

export async function buildWorkbook(report, parameters) {
  const { columns, rows } = await readReportData(report.id, parameters);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Сервис отчетов';
  const metadata = workbook.addWorksheet('Параметры');
  metadata.columns = [{ header: 'Параметр', key: 'key', width: 28 }, { header: 'Значение', key: 'value', width: 72 }];
  metadata.addRows([
    { key: 'Отчет', value: report.name },
    { key: 'Подразделение', value: parameters.department },
    { key: 'Дата начала', value: parameters.startDate ?? '' },
    { key: 'Дата окончания', value: parameters.endDate ?? '' },
    { key: 'На дату', value: parameters.asOfDate ?? '' },
    { key: 'Лицевой счет', value: parameters.account ?? '' },
    { key: 'Источник', value: 'Подготовленные демонстрационные ответы целевой системы' },
  ]);
  const sheet = workbook.addWorksheet('Данные');
  sheet.columns = columns.map(column => ({ header: column.title, key: column.key, width: column.width ?? 24 }));
  sheet.addRows(rows);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  for (const worksheet of [metadata, sheet]) {
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1677D2' } };
  }
  return { file: Buffer.from(await workbook.xlsx.writeBuffer()), rowCount: rows.length };
}
