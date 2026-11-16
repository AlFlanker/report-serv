export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';
export interface ReportDefinition { id: string; name: string; description: string; nightOnly: boolean; parameterType: 'period' | 'date'; requiresAccount: boolean; }
export interface ReportParameters { startDate?: string; endDate?: string; asOfDate?: string; department: string; account?: string; }
export interface TimeWindow { start: string; end: string; }
export interface Catalog {
  reports: ReportDefinition[];
  departments: { id: string; name: string }[];
  config: { maxPeriodDays: number; retentionDays: number; timeZone: string; nightStartHour: number; nightEndHour: number; };
  serverTime: string;
  nextNightWindow: TimeWindow;
}
export interface ReportJob {
  id: number; reportId: string; reportName: string; parameters: ReportParameters;
  status: JobStatus; stage: string; createdAt: string; startedAt?: string; completedAt?: string; expiresAt?: string;
  result?: { fileName: string; sizeBytes: number; rowCount: number };
  error?: { code: string; message: string; at: string }; nextWindow?: TimeWindow;
}
export interface JobList { items: ReportJob[]; total: number; allCount: number; updatedAt: string; }
export interface ReportNotification { id: number; jobId: number; title: string; createdAt: string; read: boolean; }
