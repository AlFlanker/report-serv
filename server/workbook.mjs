import ExcelJS from 'exceljs';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { openReportData } from './mock-source.mjs';

const STREAM_BUFFER_BYTES = 64 * 1024;
const MAX_DATA_ROWS = 1_048_575;

/**
 * ExcelJS 4.4's stock StreamBuf ignores backpressure. Replace this one pinned
 * extension point with a bounded Node stream. Per-row drain waits below then
 * stop the source cursor when ZIP/S3 slow down. Regression-tested on upgrades.
 */
class BoundedWorkbookWriter extends ExcelJS.stream.xlsx.WorkbookWriter {
  _openStream(path) {
    const stream = new PassThrough({ highWaterMark: STREAM_BUFFER_BYTES });
    const write = stream.write.bind(stream);
    // Snapshot ExcelJS's small reusable StringBuf for sheet boundaries.
    stream.write = (chunk, encoding, callback) => write(
      !Buffer.isBuffer(chunk) && typeof chunk?.toBuffer === 'function' ? chunk.toBuffer() : chunk,
      encoding, callback,
    );
    this.worksheetStreams ??= [];
    this.worksheetStreams.push(stream);
    stream.on('error', error => this.cancel?.(error));
    this.zip.append(stream, { name: path });
    stream.once('finish', () => stream.emit('zipped'));
    return stream;
  }
}

function abortError() { return new DOMException('Report generation was cancelled', 'AbortError'); }

async function drainWorksheet(sheet, signal) {
  signal.throwIfAborted();
  if (sheet.stream.writableNeedDrain) await once(sheet.stream, 'drain', { signal });
  signal.throwIfAborted();
}

function header(sheet) {
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1677D2' } };
  sheet.getRow(1).commit();
}

/** Write directly to a Writable; no complete workbook/file buffer or tempfile. */
export async function writeWorkbook(report, parameters, output, { signal: externalSignal, source } = {}) {
  externalSignal?.throwIfAborted();
  const controller = new AbortController();
  const { signal } = controller;
  const cancel = reason => controller.abort(reason instanceof Error ? reason : abortError());
  const onExternalAbort = () => cancel(externalSignal.reason);
  const onOutputClose = () => { if (!output.writableFinished) cancel(abortError()); };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  output.on('error', cancel);
  output.once('close', onOutputClose);
  let workbook;
  const onAbort = () => {
    for (const stream of workbook?.worksheetStreams ?? []) stream.destroy(signal.reason);
    workbook?.zip.abort();
    workbook?.zip.destroy();
    if (!output.destroyed) output.destroy(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const data = source ?? await openReportData(report.id, parameters, { signal });
    signal.throwIfAborted();
    workbook = new BoundedWorkbookWriter({
      stream: output, useSharedStrings: false, useStyles: true,
      zip: { zlib: { level: 1 }, highWaterMark: STREAM_BUFFER_BYTES },
    });
    workbook.cancel = cancel;
    workbook.zip.on('error', cancel);
    workbook.creator = 'Сервис отчетов';
    const metadata = workbook.addWorksheet('Параметры');
    metadata.columns = [{ header: 'Параметр', key: 'key', width: 28 }, { header: 'Значение', key: 'value', width: 72 }];
    header(metadata);
    for (const [key, value] of [
      ['Отчет', report.name], ['Подразделение', parameters.department],
      ['Дата начала', parameters.startDate ?? ''], ['Дата окончания', parameters.endDate ?? ''],
      ['На дату', parameters.asOfDate ?? ''], ['Лицевой счет', parameters.account ?? ''],
      ['Источник', 'Подготовленные демонстрационные ответы целевой системы'],
    ]) {
      metadata.addRow({ key, value }).commit();
      await drainWorksheet(metadata, signal);
    }
    metadata.commit();
    const sheet = workbook.addWorksheet('Данные', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = data.columns.map(column => ({ header: column.title, key: column.key, width: column.width ?? 24 }));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: data.columns.length } };
    header(sheet);
    await drainWorksheet(sheet, signal);
    let rowCount = 0;
    for await (const row of data.rows) {
      signal.throwIfAborted();
      if (rowCount === MAX_DATA_ROWS) throw Object.assign(new Error('Превышено максимальное число строк листа Excel.'), { code: 'REPORT_ROW_LIMIT' });
      sheet.addRow(row).commit();
      rowCount++;
      await drainWorksheet(sheet, signal);
    }
    sheet.commit();
    signal.throwIfAborted();
    await workbook.commit();
    signal.throwIfAborted();
    return { rowCount };
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    externalSignal?.removeEventListener('abort', onExternalAbort);
    output.removeListener('close', onOutputClose);
    // destroy(error) may emit asynchronously after a generation exception.
    if (output.closed) output.removeListener('error', cancel);
    else output.once('close', () => output.removeListener('error', cancel));
  }
}
