import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NzAlertModule } from 'ng-zorro-antd/alert';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzDatePickerModule } from 'ng-zorro-antd/date-picker';
import { NzDrawerModule } from 'ng-zorro-antd/drawer';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzPaginationModule } from 'ng-zorro-antd/pagination';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzSpinModule } from 'ng-zorro-antd/spin';
import { NzTableModule } from 'ng-zorro-antd/table';
import { Catalog, JobList, JobStatus, ReportDefinition, ReportJob, ReportNotification, ReportParameters, TimeWindow } from './models';
import { StatusBadgeComponent } from './status-badge.component';

@Component({
  selector: 'app-root',
  imports: [FormsModule, NzAlertModule, NzButtonModule, NzDatePickerModule, NzDrawerModule, NzIconModule,
    NzInputModule, NzModalModule, NzPaginationModule, NzSelectModule, NzSpinModule, NzTableModule, StatusBadgeComponent],
  templateUrl: './app.component.html', styleUrl: './app.component.css',
})
export class AppComponent {
  private readonly http = inject(HttpClient);
  private readonly notices = inject(NzNotificationService);
  private readonly destroyRef = inject(DestroyRef);
  private listRequest?: Subscription;
  private detailRequest?: Subscription;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private readonly pendingNotifications = new Set<number>();
  private serverOffset = 0;
  readonly catalog = signal<Catalog | null>(null);
  readonly jobs = signal<ReportJob[]>([]);
  readonly total = signal(0);
  readonly allCount = signal(0);
  readonly updatedAt = signal('');
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly loadError = signal('');
  readonly detailError = signal('');
  readonly selectedJob = signal<ReportJob | null>(null);
  readonly modalOpen = signal(false);
  readonly step = signal(1);
  readonly selectedReport = signal<ReportDefinition | null>(null);
  readonly reportSearch = signal('');
  readonly saving = signal(false);
  readonly submitError = signal('');
  readonly showValidation = signal(false);
  readonly highlightedId = signal<number | null>(null);
  readonly downloadingId = signal<number | null>(null);
  readonly supportCopied = signal(false);
  readonly filteredReports = computed(() => {
    const search = this.reportSearch().trim().toLocaleLowerCase('ru');
    return (this.catalog()?.reports ?? []).filter(report => report.name.toLocaleLowerCase('ru').includes(search));
  });
  search = '';
  status: JobStatus | '' = '';
  createdWindow = '7';
  createdRange: Date[] = [];
  page = 1;
  pageSize = 20;
  sort: 'asc' | 'desc' = 'desc';
  startDate: Date | null = null;
  endDate: Date | null = null;
  asOfDate: Date | null = null;
  department = '6000';
  account = '';
  private rawDates: Partial<Record<'startDate' | 'endDate' | 'asOfDate', string>> = {};
  private dateInputErrors: Partial<Record<'startDate' | 'endDate' | 'asOfDate', string>> = {};

  constructor() {
    this.loadCatalog();
    const interval = setInterval(() => {
      if (this.catalog() && !document.hidden) {
        this.loadJobs(false); this.refreshDetail(); this.loadNotifications();
      }
    }, 3000);
    this.destroyRef.onDestroy(() => {
      clearInterval(interval); clearTimeout(this.searchTimer);
      this.listRequest?.unsubscribe(); this.detailRequest?.unsubscribe();
    });
  }

  loadCatalog(): void {
    this.loading.set(true); this.loadError.set('');
    this.http.get<Catalog>('/api/catalog').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: catalog => {
        this.catalog.set(catalog);
        this.serverOffset = new Date(catalog.serverTime).getTime() - Date.now();
        this.loadJobs(); this.loadNotifications();
      },
      error: error => {
        this.loadError.set(this.errorMessage(error, 'Не удалось загрузить отчёты. Проверьте соединение и повторите попытку.'));
        this.loading.set(false);
      },
    });
  }

  loadJobs(showLoading = true): void {
    if (!showLoading && this.listRequest && !this.listRequest.closed) return;
    this.listRequest?.unsubscribe();
    if (showLoading) this.refreshing.set(true);
    let params = new HttpParams().set('page', this.page).set('pageSize', this.pageSize).set('sort', this.sort);
    if (this.search.trim()) params = params.set('search', this.search.trim());
    if (this.status) params = params.set('status', this.status);
    if (this.createdWindow !== 'all' && this.createdWindow !== 'custom') {
      const today = this.moscowDate();
      const from = new Date(`${today}T12:00:00`);
      from.setDate(from.getDate() - Number(this.createdWindow) + 1);
      params = params.set('createdFrom', this.dateValue(from)).set('createdTo', today);
    } else if (this.createdWindow === 'custom' && this.createdRange.length === 2) {
      params = params.set('createdFrom', this.dateValue(this.createdRange[0]!)).set('createdTo', this.dateValue(this.createdRange[1]!));
    }
    this.listRequest = this.http.get<JobList>('/api/jobs', { params }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: data => {
        this.jobs.set(data.items); this.total.set(data.total); this.allCount.set(data.allCount); this.updatedAt.set(data.updatedAt);
        this.loadError.set(''); this.loading.set(false); this.refreshing.set(false);
        if (data.total > 0 && this.page > Math.ceil(data.total / this.pageSize)) {
          this.page = Math.ceil(data.total / this.pageSize); this.loadJobs();
        }
      },
      error: error => {
        this.loadError.set(this.errorMessage(error, 'Не удалось обновить задания. Повторите попытку.'));
        this.loading.set(false); this.refreshing.set(false);
      },
    });
  }
  refresh(): void { this.loadJobs(); this.refreshDetail(); this.loadNotifications(); }
  searchChanged(): void { clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.filtersChanged(), 300); }
  filtersChanged(): void { this.page = 1; this.loadJobs(); }
  pageChanged(page: number): void { this.page = page; this.loadJobs(); }
  pageSizeChanged(size: number): void { this.pageSize = size; this.filtersChanged(); }
  toggleSort(): void { this.sort = this.sort === 'desc' ? 'asc' : 'desc'; this.filtersChanged(); }
  clearFilters(): void { this.search = ''; this.status = ''; this.createdWindow = 'all'; this.createdRange = []; this.filtersChanged(); }
  openCreate(): void {
    this.http.get<Catalog>('/api/catalog').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: catalog => { this.catalog.set(catalog); this.serverOffset = new Date(catalog.serverTime).getTime() - Date.now(); },
      error: () => { /* Existing catalogue remains usable; server validates scheduling. */ },
    });
    this.selectedReport.set(null); this.reportSearch.set(''); this.step.set(1);
    this.submitError.set(''); this.showValidation.set(false); this.modalOpen.set(true);
  }
  selectReport(report: ReportDefinition): void { this.selectedReport.set(report); }
  nextStep(): void {
    if (!this.selectedReport()) return;
    const yesterday = new Date(`${this.moscowDate()}T12:00:00`);
    yesterday.setDate(yesterday.getDate() - 1);
    this.endDate = yesterday; this.startDate = new Date(yesterday.getFullYear(), yesterday.getMonth(), 1, 12);
    this.rawDates = {}; this.dateInputErrors = {};
    this.asOfDate = new Date(yesterday); this.department = this.catalog()?.departments[0]?.id ?? '6000'; this.account = '';
    this.showValidation.set(false); this.submitError.set(''); this.step.set(2);
  }
  backToReports(): void { this.step.set(1); this.submitError.set(''); }
  closeCreate(): void { if (!this.saving()) this.modalOpen.set(false); }
  // NG-ZORRO opens its calendar on the first input event without committing pasted
  // text. Keep the user's raw date until blur so typing/paste and calendar selection
  // have the same date-only semantics, and never submit the previous date silently.
  captureDate(field: 'startDate' | 'endDate' | 'asOfDate', event: Event): void {
    if (event.target instanceof HTMLInputElement) this.rawDates[field] = event.target.value;
  }
  commitDate(field: 'startDate' | 'endDate' | 'asOfDate'): void {
    const raw = this.rawDates[field];
    if (raw === undefined) return;
    delete this.rawDates[field];
    const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw.trim());
    let parsed: Date | null = null;
    if (match) {
      const day = Number(match[1]), month = Number(match[2]) - 1, year = Number(match[3]);
      const candidate = new Date(0);
      candidate.setFullYear(year, month, day);
      candidate.setHours(12, 0, 0, 0);
      if (candidate.getFullYear() === year && candidate.getMonth() === month && candidate.getDate() === day) parsed = candidate;
    }
    this[field] = parsed;
    this.dateInputErrors[field] = parsed || !raw.trim() ? '' : 'Введите корректную дату в формате ДД.ММ.ГГГГ.';
  }
  dateChanged(field: 'startDate' | 'endDate' | 'asOfDate', value: Date | null): void {
    this[field] = value;
    if (value) this.dateInputErrors[field] = '';
  }
  validationError(): string {
    const report = this.selectedReport();
    if (!report) return 'Выберите отчёт.';
    if (!this.department) return 'Выберите подразделение.';
    if (report.parameterType === 'date') {
      if (this.dateInputErrors.asOfDate) return this.dateInputErrors.asOfDate;
      if (!this.asOfDate || Number.isNaN(this.asOfDate.getTime())) return 'Укажите дату отчёта.';
    } else {
      if (this.dateInputErrors.startDate || this.dateInputErrors.endDate) return this.dateInputErrors.startDate || this.dateInputErrors.endDate || '';
      if (!this.startDate || !this.endDate || Number.isNaN(this.startDate.getTime()) || Number.isNaN(this.endDate.getTime())) return 'Укажите дату начала и дату окончания.';
      const start = Date.parse(this.dateValue(this.startDate));
      const end = Date.parse(this.dateValue(this.endDate));
      if (start > end) return 'Дата окончания не может быть раньше даты начала.';
      if ((end - start) / 86400000 + 1 > (this.catalog()?.config.maxPeriodDays ?? 31)) return `Период должен быть не более ${this.catalog()?.config.maxPeriodDays ?? 31} календарного дня включительно.`;
    }
    if (report.requiresAccount && !/^\d{11}$/.test(this.account.trim())) return 'Укажите лицевой счёт: 11 цифр.';
    return '';
  }
  submit(): void {
    this.showValidation.set(true);
    if (this.validationError() || this.saving()) return;
    const report = this.selectedReport()!;
    const parameters: ReportParameters = { department: this.department };
    if (report.parameterType === 'date') parameters.asOfDate = this.dateValue(this.asOfDate!);
    else { parameters.startDate = this.dateValue(this.startDate!); parameters.endDate = this.dateValue(this.endDate!); }
    if (report.requiresAccount) parameters.account = this.account.trim();
    this.saving.set(true); this.submitError.set('');
    this.http.post<ReportJob>('/api/jobs', { reportId: report.id, parameters }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: job => {
        this.saving.set(false); this.modalOpen.set(false); this.highlightedId.set(job.id);
        this.search = ''; this.status = ''; this.createdWindow = '7'; this.sort = 'desc'; this.page = 1; this.loadJobs();
        this.notices.success(`Задание №${job.id} добавлено в очередь`, 'О готовности сообщим в ЛК.', { nzDuration: 6000 });
      },
      error: error => { this.saving.set(false); this.submitError.set(this.errorMessage(error, 'Не удалось создать задание. Попробуйте ещё раз.')); },
    });
  }
  openDetails(job: ReportJob): void { this.detailRequest?.unsubscribe(); this.selectedJob.set(job); this.detailError.set(''); this.supportCopied.set(false); this.refreshDetail(); }
  closeDetails(): void { this.detailRequest?.unsubscribe(); this.selectedJob.set(null); }
  refreshDetail(): void {
    const id = this.selectedJob()?.id;
    if (id === undefined || (this.detailRequest && !this.detailRequest.closed)) return;
    this.detailRequest = this.http.get<ReportJob>(`/api/jobs/${id}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: job => { if (this.selectedJob()?.id === id) { this.selectedJob.set(job); this.detailError.set(''); } },
      error: error => { if (this.selectedJob()?.id === id) this.detailError.set(this.errorMessage(error, 'Не удалось обновить сведения о задании.')); },
    });
  }
  download(job: ReportJob): void {
    if (this.downloadingId() !== null) return;
    this.downloadingId.set(job.id);
    this.http.get(`/api/jobs/${job.id}/download`, { responseType: 'blob' }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: blob => {
        const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
        anchor.href = url; anchor.download = job.result?.fileName ?? `report-${job.id}.xlsx`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000); this.downloadingId.set(null);
      },
      error: async (error: HttpErrorResponse) => {
        this.downloadingId.set(null); let message = 'Не удалось скачать файл. Повторите попытку.';
        if (error.error instanceof Blob) { try { message = JSON.parse(await error.error.text()).error?.message ?? message; } catch { /* Non-JSON proxy response. */ } }
        this.notices.error('Ошибка скачивания', message);
      },
    });
  }
  async copySupport(job: ReportJob): Promise<void> {
    const text = `Задание №${job.id}\n${job.reportName}\n${this.dateTime(job.error?.at ?? job.createdAt)} МСК\n${job.error?.code ?? ''}\n${job.error?.message ?? ''}`;
    try { await navigator.clipboard.writeText(text); this.supportCopied.set(true); }
    catch { this.notices.info('Сведения для поддержки', text, { nzDuration: 0 }); }
  }
  private loadNotifications(): void {
    this.http.get<{ items: ReportNotification[]; unreadCount: number }>('/api/notifications').pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: data => {
        const unread = data.items.filter(item => !item.read && !this.pendingNotifications.has(item.id));
        if (!unread.length) return;
        unread.forEach(item => { this.pendingNotifications.add(item.id); this.notices.info(item.title, `Задание №${item.jobId}. Откройте подробности в списке заданий.`, { nzDuration: 6000 }); });
        this.http.post('/api/notifications/read', { ids: unread.map(item => item.id) }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ error: () => { /* No repeated toast in this tab if acknowledgement fails. */ } });
      }, error: () => { /* Job polling still reports readiness. */ },
    });
  }
  errorMessage(error: unknown, fallback: string): string { return error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message : fallback; }
  dateValue(date: Date): string { return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
  private moscowDate(): string { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now() + this.serverOffset); }
  dateOnly(value?: string): string { return value ? value.slice(0, 10).split('-').reverse().join('.') : '—'; }
  date(value?: string): string { return value ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow' }).format(new Date(value)) : '—'; }
  time(value?: string): string { return value ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'; }
  dateTime(value?: string): string { return value ? `${this.date(value)}, ${this.time(value)}` : '—'; }
  longDateTime(value?: string): string { return value ? `${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value))}, ${this.time(value)}` : '—'; }
  period(job: ReportJob): string { return job.parameters.asOfDate ? `На ${this.dateOnly(job.parameters.asOfDate)}` : `${this.dateOnly(job.parameters.startDate)} — ${this.dateOnly(job.parameters.endDate)}`; }
  departmentName(id: string): string { const dep = this.catalog()?.departments.find(item => item.id === id); return dep ? `${dep.id} — ${dep.name}` : id; }
  fileSize(bytes = 0): string { return bytes >= 1048576 ? `${(bytes / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ` : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('ru-RU')} КБ`; }
  number(value: number): string { return value.toLocaleString('ru-RU'); }
  expired(job: ReportJob): boolean { return !!job.expiresAt && new Date(job.expiresAt).getTime() <= Date.now() + this.serverOffset; }
  waitingForWindow(job: ReportJob): boolean { return !!job.nextWindow && Date.parse(job.nextWindow.start) > Date.now() + this.serverOffset; }
  windowLabel(window?: TimeWindow): string {
    if (!window) return '00:00–06:00 МСК';
    const day = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' }).format(new Date(window.start));
    return `${day}, ${this.time(window.start)}–${this.time(window.end)} МСК`;
  }
}
