import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';

test('список, поиск и карточка готового Excel-отчёта', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Формирование отчетов', exact: true })).toBeVisible();
  await expect(page.getByTestId('job-row-1046')).toBeVisible();
  await page.getByTestId('report-search').fill('1046');
  await expect(page.getByTestId('jobs-table').locator('tbody tr[data-testid]')).toHaveCount(1);
  await page.getByTestId('job-details-1046').click();
  await expect(page.getByTestId('details-drawer')).toContainText('Отчет готов к скачиванию');
  await expect(page.getByTestId('details-drawer')).toContainText('03210001234');
  const downloadEvent = page.waitForEvent('download');
  await page.getByTestId('details-drawer').getByRole('button', { name: 'Скачать Excel' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(await download.path());
  expect(workbook.getWorksheet('Данные').rowCount).toBeGreaterThan(1);
  expect(workbook.getWorksheet('Параметры').getColumn(2).values).toContain('03210001234');
  expect(errors).toEqual([]);
});

test('фильтр статуса и сведения об ошибке для поддержки', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByTestId('status-filter').click();
  await page.locator('nz-option-item').filter({ hasText: /^\s*Ошибка\s*$/ }).click();
  await expect(page.getByTestId('jobs-table').locator('tbody tr[data-testid]')).toHaveCount(1);
  await page.getByTestId('job-details-1045').click();
  const drawer = page.getByTestId('details-drawer');
  await expect(drawer).toContainText('REPORT_FORMAT_MISMATCH');
  await expect(drawer).toContainText('Файл не создан');
  await drawer.getByRole('button', { name: 'Скопировать сведения' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('1045');
});

test('создание отчёта, выполнение после закрытия вкладки и скачивание', async ({ page, context, request }) => {
  await page.goto('/');
  await page.getByTestId('new-report').click();
  await page.getByTestId('report-choice-turnovers').click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('start-date').locator('input').fill('01.10.2026');
  await page.getByTestId('start-date').locator('input').press('Tab');
  await page.getByTestId('end-date').locator('input').fill('31.10.2026');
  await page.getByTestId('end-date').locator('input').press('Tab');
  await page.getByTestId('account-input').fill('03210001234');
  const responseEvent = page.waitForResponse(response => response.url().endsWith('/api/jobs') && response.request().method() === 'POST');
  await page.getByTestId('start-report').click();
  const response = await responseEvent;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON().parameters).toMatchObject({
    startDate: '2026-10-01', endDate: '2026-10-31', account: '03210001234',
  });
  // Angular's fetch teardown can release a completed chunked response before
  // Chromium exposes its body to CDP. Use the ID confirmed in the actual UI.
  const createdRow = page.locator('tr.new-job');
  await expect(createdRow).toHaveAttribute('data-testid', /^job-row-\d+$/);
  const job = { id: Number((await createdRow.getAttribute('data-testid')).replace('job-row-', '')) };
  await page.close();
  await expect.poll(async () => {
    const result = await request.get(`/api/jobs/${job.id}`);
    return (await result.json()).status;
  }, { timeout: 20000 }).toBe('completed');
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(reopened.getByTestId(`job-row-${job.id}`)).toContainText('Завершено');
  const downloadEvent = reopened.waitForEvent('download');
  await reopened.getByTestId(`job-download-${job.id}`).click();
  const download = await downloadEvent;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(await download.path());
  expect(workbook.getWorksheet('Данные').rowCount).toBeGreaterThan(1);
  expect(workbook.getWorksheet('Параметры').getColumn(2).values).toContain('2026-10-31');
  await reopened.getByTestId(`job-details-${job.id}`).click();
  await expect(reopened.getByTestId('job-steps')).toBeVisible();
  await expect(reopened.getByTestId('job-step-extract')).toHaveAttribute('data-status', 'completed');
  await expect(reopened.getByTestId('job-step-render')).toHaveAttribute('data-status', 'completed');
  await expect(reopened.getByTestId('job-step-publish')).toHaveAttribute('data-status', 'completed');
  await expect(reopened.getByTestId('restart-job')).toHaveCount(0);
});

test('период свыше 31 дня не отправляется на сервер', async ({ page }) => {
  let submissions = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/jobs') && request.method() === 'POST') submissions++;
  });
  await page.goto('/');
  await page.getByTestId('new-report').click();
  await page.getByTestId('report-choice-operations').click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('start-date').locator('input').fill('01.10.2026');
  await page.getByTestId('start-date').locator('input').press('Tab');
  await page.getByTestId('end-date').locator('input').fill('01.11.2026');
  await page.getByTestId('end-date').locator('input').press('Tab');
  const submit = page.getByTestId('start-report');
  if (await submit.isEnabled()) await submit.click();
  await expect(page.locator('.form-error')).toContainText('31 календарн');
  expect(submissions).toBe(0);
  await expect(page.locator('.ant-modal')).toBeVisible();
});

test('пустое состояние позволяет создать первое задание', async ({ page }) => {
  await page.route('**/api/jobs?*', route => route.fulfill({ json: { items: [], total: 0, allCount: 0, updatedAt: new Date().toISOString() } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'У вас пока нет заданий' })).toBeVisible();
  await page.getByTestId('new-report').click();
  await expect(page.getByTestId('report-choice-balances')).toBeVisible();
});

test('несуществующая дата не заменяется прежним значением', async ({ page }) => {
  let submissions = 0;
  page.on('request', request => {
    if (request.url().endsWith('/api/jobs') && request.method() === 'POST') submissions++;
  });
  await page.goto('/');
  await page.getByTestId('new-report').click();
  await page.getByTestId('report-choice-balances').click();
  await page.getByTestId('next-step').click();
  await page.getByTestId('as-of-date').locator('input').fill('31.02.2026');
  await page.getByTestId('as-of-date').locator('input').press('Tab');
  await page.getByTestId('start-report').click();
  await expect(page.locator('.form-error')).toContainText('корректную дату');
  expect(submissions).toBe(0);
});

test('отсутствие результатов поиска не подменяется пустым кабинетом', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('report-search').fill('несуществующий отчет 999999');
  await expect(page.getByTestId('jobs-table').locator('tbody tr[data-testid]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'У вас пока нет заданий' })).toHaveCount(0);
  await page.getByTestId('report-search').fill('');
  await expect(page.getByTestId('job-row-1046')).toBeVisible();
});

test('узкий экран сохраняет доступ к форме и не расширяет страницу', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('new-report')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByTestId('new-report').click();
  await page.getByTestId('report-choice-balances').click();
  await page.getByTestId('next-step').click();
  await expect(page.getByTestId('as-of-date')).toBeVisible();
  await expect(page.getByTestId('start-report')).toBeVisible();
});

test('ошибка повторного запуска сохраняет шаги, успешный запуск возвращает задание в очередь', async ({ page, request }) => {
  const response = await request.get('/api/jobs/1046');
  expect(response.ok()).toBe(true);
  const original = await response.json();
  let attempts = 0;
  let detail = {
    ...original,
    status: 'failed', stage: 'Ошибка формирования Excel', canRestart: true,
    error: { code: 'REPORT_STEP_FAILED', message: 'Не удалось сформировать Excel.', at: new Date().toISOString() },
    steps: [
      { name: 'extract', label: 'Получение данных', status: 'completed', attempt: 1, writeCount: 5 },
      { name: 'render', label: 'Формирование Excel', status: 'failed', attempt: 1, error: 'Ошибка записи документа.' },
      { name: 'publish', label: 'Публикация результата', status: 'pending' },
    ],
  };
  // Only the transient failure fixture is mocked here; persistence and Batch
  // restart are exercised against PostgreSQL/S3 in BatchIntegrationTest.
  await page.route('**/api/jobs/1046', route => route.fulfill({ json: detail }));
  await page.route('**/api/jobs/1046/restart', async route => {
    expect(route.request().method()).toBe('POST');
    attempts++;
    if (attempts === 1) {
      await route.fulfill({ status: 409, json: { error: { code: 'RESTART_NOT_ALLOWED', message: 'Повторный запуск временно недоступен.' } } });
      return;
    }
    detail = { ...detail, status: 'queued', stage: 'Ожидает повторного запуска', canRestart: false, error: undefined };
    await route.fulfill({ json: detail });
  });
  await page.goto('/');
  await page.getByTestId('job-details-1046').click();
  await expect(page.getByTestId('job-step-extract')).toHaveAttribute('data-status', 'completed');
  await expect(page.getByTestId('job-step-render')).toContainText('Ошибка записи документа.');
  await page.getByTestId('restart-job').click();
  await expect(page.getByTestId('restart-error')).toContainText('Повторный запуск временно недоступен.');
  await expect(page.getByTestId('job-step-extract')).toHaveAttribute('data-status', 'completed');
  await page.getByTestId('restart-job').click();
  await expect(page.getByTestId('restart-job')).toHaveCount(0);
  await expect(page.getByTestId('details-drawer')).toContainText('В очереди');
  await expect(page.getByTestId('job-step-extract')).toHaveAttribute('data-status', 'completed');
  expect(attempts).toBe(2);
});
