package dev.reportserv.batch;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.reportserv.config.SchemaOwner;
import dev.reportserv.domain.ApiException;
import dev.reportserv.domain.ReportCatalog;
import dev.reportserv.domain.ReportRecord;
import dev.reportserv.pipeline.ReportPipeline;
import dev.reportserv.repository.ReportRepository;
import dev.reportserv.storage.ReportStorage;
import jakarta.annotation.PreDestroy;
import org.springframework.batch.core.*;
import org.springframework.batch.core.explore.JobExplorer;
import org.springframework.batch.core.job.builder.JobBuilder;
import org.springframework.batch.core.job.builder.SimpleJobBuilder;
import org.springframework.batch.core.launch.JobLauncher;
import org.springframework.batch.core.repository.JobRepository;
import org.springframework.batch.core.step.builder.StepBuilder;
import org.springframework.batch.repeat.RepeatStatus;
import org.springframework.batch.support.transaction.ResourcelessTransactionManager;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.CountDownLatch;

@Service
public class ReportExecutionService implements ApplicationRunner {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final ReportRepository reports;
    private final ReportCatalog catalog;
    private final ReportStorage storage;
    private final ReportPipeline pipeline;
    private final ReportPlanRegistry plans;
    private final SchemaOwner owner;
    private final JobRepository batch;
    private final JobExplorer explorer;
    private final JobLauncher launcher;
    private final TransactionTemplate transactions;
    private final Map<Integer, Job> jobs = new HashMap<>();
    private final boolean seedDemo;
    private final boolean scheduling;
    private final long processingDelay;
    private final AtomicBoolean busy = new AtomicBoolean();
    private final Object workerState = new Object();
    private volatile CountDownLatch drained = new CountDownLatch(0);
    private volatile boolean initialized;
    private volatile boolean stopping;
    private volatile Thread workerThread;
    private String objectPrefix;

    public ReportExecutionService(ReportRepository reports, ReportCatalog catalog, ReportStorage storage,
                                  ReportPipeline pipeline, ReportPlanRegistry plans, SchemaOwner owner,
                                  JobRepository batch, JobExplorer explorer, JobLauncher launcher,
                                  PlatformTransactionManager transactionManager,
                                  @Value("${SEED_DEMO:true}") boolean seedDemo,
                                  @Value("${BATCH_SCHEDULING_ENABLED:true}") boolean scheduling,
                                  @Value("${REPORT_PROCESSING_DELAY_MS:4000}") long processingDelay) {
        this.reports = reports; this.catalog = catalog; this.storage = storage; this.pipeline = pipeline;
        this.plans = plans; this.owner = owner; this.batch = batch; this.explorer = explorer; this.launcher = launcher;
        this.jdbc = reports.jdbc(); this.mapper = reports.json(); this.transactions = new TransactionTemplate(transactionManager);
        this.seedDemo = seedDemo; this.scheduling = scheduling; this.processingDelay = Math.max(0, processingDelay);
        for (var plan : plans.all()) jobs.put(plan.version(), build(plan));
    }

    @Override public void run(ApplicationArguments arguments) throws Exception { initialize(); }

    public synchronized void initialize() throws Exception {
        if (initialized) return;
        synchronized (workerState) { workerThread = Thread.currentThread(); drained = new CountDownLatch(1); }
        boolean complete = false;
        try {
        String bucket = setting("object_bucket");
        if (bucket != null && !bucket.equals(storage.bucket())) throw new IllegalStateException("S3_BUCKET differs from the bucket associated with this schema");
        storage.check();
        remember("object_bucket", storage.bucket());
        remember("object_namespace", UUID.randomUUID().toString());
        remember("object_prefix", storage.prefix());
        String prefix = setting("object_prefix").replaceAll("^/+|/+$", "");
        objectPrefix = (prefix.isEmpty() ? "" : prefix + "/") + setting("object_namespace") + "/";
        recoverInterrupted();
        cleanup();
        if (setting("initialized") == null) {
            if (seedDemo) seed();
            remember("initialized", "1");
        }
        complete = true;
        } finally {
            synchronized (workerState) { workerThread = null; drained.countDown(); initialized = complete; }
        }
    }

    public boolean isReady() { return initialized && !stopping && owner.isHealthy(); }

    private Job build(ReportPlanRegistry.Plan plan) {
        List<Step> steps = new ArrayList<>();
        for (var stage : plan.stages()) {
            Step step = new StepBuilder(stage.name(), batch)
                .tasklet((contribution, context) -> {
                    JobExecution execution = contribution.getStepExecution().getJobExecution();
                    long id = execution.getJobParameters().getLong("jobId");
                    ReportRecord report = reports.get(id);
                    owner.verify();
                    jdbc.update("UPDATE jobs SET stage=? WHERE id=? AND status='running' AND last_execution_id=?", stage.label(), id, execution.getId());
                    if (Thread.currentThread().isInterrupted() || stopping || !owner.isHealthy()) throw new JobInterruptedException("Report execution interrupted");
                    if (stage.kind() == ReportPlanRegistry.Kind.PUBLISH) {
                        publish(report, artifact(id, stage.inputs().getFirst(), plan.version()), execution);
                    } else {
                        Map<String,Object> artifact = ensureArtifact(report, stage, execution.getId());
                        var checkpoint = contribution.getStepExecution().getExecutionContext();
                        checkpoint.putString("artifactKey", (String) artifact.get("object_key"));
                        checkpoint.putLong("rowCount", ((Number) artifact.get("row_count")).longValue());
                        checkpoint.putLong("sizeBytes", ((Number) artifact.get("size_bytes")).longValue());
                        checkpoint.putString("bucket", storage.bucket());
                        // Persist small references, never result rows or workbook bytes.
                        execution.getExecutionContext().putString(stage.name() + ".artifactKey", (String) artifact.get("object_key"));
                        execution.getExecutionContext().putLong(stage.name() + ".rowCount", ((Number) artifact.get("row_count")).longValue());
                        batch.updateExecutionContext(execution);
                        contribution.incrementWriteCount(((Number) artifact.get("row_count")).longValue());
                    }
                    return RepeatStatus.FINISHED;
                }, new ResourcelessTransactionManager())
                .build();
            steps.add(step);
        }
        SimpleJobBuilder builder = new JobBuilder(plan.jobName(), batch).listener(new JobExecutionListener() {
            @Override public void beforeJob(JobExecution execution) {
                owner.verify();
                long id = execution.getJobParameters().getLong("jobId");
                int changed = jdbc.update("UPDATE jobs SET status='running',batch_instance_id=?,last_execution_id=?,error_json=NULL WHERE id=? AND status IN ('queued','running') AND (last_execution_id IS NULL OR last_execution_id<=?)",
                    execution.getJobInstance().getInstanceId(), execution.getId(), id, execution.getId());
                if (changed != 1) throw new IllegalStateException("Report job no longer accepts this execution");
            }
            @Override public void afterJob(JobExecution execution) { finishAttempt(execution); }
        }).start(steps.getFirst());
        for (int index = 1; index < steps.size(); index++) builder = builder.next(steps.get(index));
        return builder.build();
    }

    private Map<String,Object> ensureArtifact(ReportRecord report, ReportPlanRegistry.Stage stage, long executionId) throws Exception {
        Map<String,Object> ready = findArtifact(report.id(), stage.name(), report.definitionVersion());
        if (ready != null && ((Timestamp) ready.get("expires_at")).toInstant().isAfter(catalog.now())) return ready;
        String suffix = stage.kind() == ReportPlanRegistry.Kind.RENDER ? ".xlsx" : ".jsonl";
        String key = objectPrefix + "job-" + report.id() + "/v" + report.definitionVersion() + "/" + stage.name() + "-" + UUID.randomUUID() + suffix;
        registerCleanup(key, "upload");
        try {
            ReportPipeline.Artifact generated = switch (stage.kind()) {
                case EXTRACT -> pipeline.extract(stage.sourceReportId() == null ? report.reportId() : stage.sourceReportId(), report.parameters(), key);
                case COMPOSE -> pipeline.compose(stage.inputs().stream().map(input -> (String) artifact(report.id(), input, report.definitionVersion()).get("object_key")).toList(), key);
                case RENDER -> pipeline.render(catalog.get(report.reportId()).name(), report.parameters(),
                    (String) artifact(report.id(), stage.inputs().getFirst(), report.definitionVersion()).get("object_key"), key);
                default -> throw new IllegalStateException("Unsupported artifact stage");
            };
            if (Thread.currentThread().isInterrupted() || stopping || !owner.isHealthy()) throw new JobInterruptedException("Report execution interrupted");
            owner.verify();
            transactions.executeWithoutResult(status -> {
                Long current = jdbc.queryForObject("SELECT last_execution_id FROM jobs WHERE id=? FOR UPDATE", Long.class, report.id());
                if (!Objects.equals(current, executionId)) throw new IllegalStateException("Report execution was replaced by another owner");
                Map<String,Object> previous = findArtifact(report.id(), stage.name(), report.definitionVersion());
                if (previous != null && !key.equals(previous.get("object_key"))) registerCleanup((String) previous.get("object_key"), "superseded");
                jdbc.update("INSERT INTO job_artifacts(job_id,step_name,definition_version,object_key,bucket,size_bytes,row_count,created_at,expires_at) "
                    + "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,step_name,definition_version) DO UPDATE SET object_key=excluded.object_key,bucket=excluded.bucket,"
                    + "size_bytes=excluded.size_bytes,row_count=excluded.row_count,created_at=excluded.created_at,expires_at=excluded.expires_at",
                    report.id(), stage.name(), report.definitionVersion(), key, storage.bucket(), generated.object().sizeBytes(), generated.rowCount(),
                    ts(catalog.now()), ts(catalog.now().plus(catalog.retentionDays(), ChronoUnit.DAYS)));
                jdbc.update("DELETE FROM object_cleanup WHERE object_key=?", key);
            });
            return artifact(report.id(), stage.name(), report.definitionVersion());
        } catch (Exception error) {
            // A lost transaction acknowledgement may have committed the reference.
            // Cleanup only if PostgreSQL confirms the key is still an orphan.
            try {
                Integer referenced = jdbc.queryForObject("SELECT count(*) FROM job_artifacts WHERE object_key=?", Integer.class, key);
                if (referenced != null && referenced == 0) cleanOne(key);
            } catch (Exception ignored) { }
            throw error;
        }
    }

    private void publish(ReportRecord report, Map<String,Object> artifact, JobExecution execution) {
        owner.verify();
        Instant completed = catalog.now();
        Map<String,Object> result = new LinkedHashMap<>();
        result.put("fileName", "report-" + report.id() + "-" + report.reportId() + ".xlsx");
        result.put("sizeBytes", artifact.get("size_bytes")); result.put("rowCount", artifact.get("row_count"));
        result.put("storage", "s3"); result.put("bucket", storage.bucket()); result.put("key", artifact.get("object_key"));
        transactions.executeWithoutResult(status -> {
            int changed = jdbc.update("UPDATE jobs SET status='completed',stage='Готово к скачиванию',completed_at=?,expires_at=?,result_metadata=?::jsonb,error_json=NULL,ready_at=NULL WHERE id=? AND status='running' AND last_execution_id=?",
                ts(completed), ts(completed.plus(catalog.retentionDays(), ChronoUnit.DAYS)), json(result), report.id(), execution.getId());
            if (changed == 0) {
                var current = reports.get(report.id());
                if (current.status().equals("completed") && Objects.equals(current.lastExecutionId(), execution.getId())
                    && current.result() != null && Objects.equals(current.result().get("key"), artifact.get("object_key"))) return;
                throw new IllegalStateException("Report publication belongs to a replaced execution");
            }
            // Retain all prerequisites for the complete result's lifetime.
            jdbc.update("UPDATE job_artifacts SET expires_at=? WHERE job_id=?", ts(completed.plus(catalog.retentionDays(), ChronoUnit.DAYS)), report.id());
            if (!Boolean.FALSE.equals(execution.getJobParameters().getParameters().getOrDefault("notify", new JobParameter<>(true, Boolean.class)).getValue())) {
                notify(report.id(), "completed:" + report.id(), "Отчет по заданию №" + report.id() + " готов к скачиванию", completed);
            }
        });
    }

    private void finishAttempt(JobExecution execution) {
        if (execution.getStatus() == BatchStatus.COMPLETED) return;
        long id = execution.getJobParameters().getLong("jobId");
        if (!owner.isHealthy()) return; // The replacement owner performs recovery.
        if (stopping || Thread.currentThread().isInterrupted() || !owner.isHealthy()) {
            jdbc.update("UPDATE jobs SET status='queued',stage='Ожидает запуска',ready_at=NULL WHERE id=? AND status='running' AND last_execution_id=?", id, execution.getId());
            return;
        }
        Instant at = catalog.now();
        String code = execution.getAllFailureExceptions().stream().anyMatch(error -> hasCode(error, "REPORT_FORMAT_MISMATCH")) ? "REPORT_FORMAT_MISMATCH" : "REPORT_STEP_FAILED";
        String message = code.equals("REPORT_FORMAT_MISMATCH") ? "Полученные данные не соответствуют формату отчета. Файл не создан." : "Не удалось выполнить шаг отчета. Можно повторить выполнение с сохраненных результатов.";
        transactions.executeWithoutResult(status -> {
            int changed = jdbc.update("UPDATE jobs SET status='failed',stage='Ошибка выполнения шага',completed_at=?,error_json=?::jsonb,ready_at=NULL WHERE id=? AND status='running' AND last_execution_id=?",
                ts(at), json(Map.of("code", code, "message", message, "at", at.toString())), id, execution.getId());
            if (changed > 0) notify(id, "failed:" + execution.getId(), "Не удалось сформировать отчет по заданию №" + id, at);
        });
    }

    private boolean hasCode(Throwable error, String code) {
        if (error == null) return false;
        if (error instanceof ApiException api && api.code().equals(code)) return true;
        if (error instanceof ReportPipeline.SourceFormatException source && source.code().equals(code)) return true;
        return error.getMessage() != null && error.getMessage().contains(code) || hasCode(error.getCause(), code);
    }

    @Scheduled(fixedDelayString = "${BATCH_POLL_MS:1000}")
    public void scheduledTick() {
        if (!scheduling || !isReady()) return;
        try { tick(); } catch (Exception error) { System.err.println("Report worker tick failed: " + error.getClass().getSimpleName()); }
    }

    public void tick() throws Exception {
        synchronized (workerState) {
            if (!isReady() || !busy.compareAndSet(false, true)) return;
            workerThread = Thread.currentThread(); drained = new CountDownLatch(1);
        }
        try {
            cleanup();
            List<Map<String,Object>> active = jdbc.queryForList("SELECT id,ready_at FROM jobs WHERE status='running' ORDER BY id LIMIT 1");
            if (!active.isEmpty()) {
                var row = active.getFirst();
                Timestamp readyAt = (Timestamp) row.get("ready_at");
                if (readyAt == null || !readyAt.toInstant().isAfter(catalog.now())) launch(((Number) row.get("id")).longValue(), true);
                return;
            }
            for (var row : jdbc.queryForList("SELECT id,report_id,definition_version FROM jobs WHERE status='queued' ORDER BY created_at,id")) {
                if (catalog.get((String) row.get("report_id")).nightOnly() && !catalog.inNightWindow(catalog.now())) continue;
                long id = ((Number) row.get("id")).longValue();
                if (!plans.supports(((Number) row.get("definition_version")).intValue())) {
                    jdbc.update("UPDATE jobs SET status='failed',stage='Версия отчета недоступна',error_json=?::jsonb WHERE id=?", json(Map.of("code", "DEFINITION_UNAVAILABLE", "message", "Версия отчета недоступна. Создайте новое задание.", "at", catalog.now().toString())), id);
                    continue;
                }
                jdbc.update("UPDATE jobs SET status='running',stage='Получение данных',started_at=COALESCE(started_at,?),ready_at=? WHERE id=? AND status='queued'",
                    ts(catalog.now()), ts(catalog.now().plusMillis(processingDelay)), id);
                break;
            }
        } finally { synchronized (workerState) { workerThread = null; busy.set(false); drained.countDown(); } }
    }

    private void launch(long id, boolean notify) throws Exception {
        ReportRecord report = reports.get(id);
        Job job = jobs.get(report.definitionVersion());
        if (job == null) throw new IllegalStateException("Report definition is unavailable");
        var parameters = new JobParametersBuilder().addLong("jobId", id, true)
            .addLong("definitionVersion", (long) report.definitionVersion(), true)
            .addJobParameter("notify", notify, Boolean.class, false).toJobParameters();
        try { launcher.run(job, parameters); }
        catch (org.springframework.batch.core.repository.JobInstanceAlreadyCompleteException completed) {
            // A crash after Batch committed completion but before the scheduler
            // observed it must not create another instance or duplicate result.
            if (!reports.get(id).status().equals("completed")) throw completed;
        }
    }

    public boolean canRestart(long id) {
        ReportRecord report = reports.get(id);
        if (!report.status().equals("failed") || report.batchInstanceId() == null || !plans.supports(report.definitionVersion())) return false;
        Instant failedAt = report.completedAt() == null ? report.createdAt() : report.completedAt();
        if (!failedAt.plus(catalog.retentionDays(), ChronoUnit.DAYS).isAfter(catalog.now())) return false;
        Integer expired = jdbc.queryForObject("SELECT count(*) FROM job_artifacts WHERE job_id=? AND expires_at<=?", Integer.class, id, ts(catalog.now()));
        if (expired != null && expired > 0) return false;
        for (var step : steps(id)) {
            if (step.get("status").equals("completed") && !step.get("name").equals("publish")) {
                Map<String,Object> saved = findArtifact(id, (String) step.get("name"), report.definitionVersion());
                if (saved == null) return false;
            }
        }
        return true;
    }

    public Map<String,Object> restart(long id) {
        if (!canRestart(id)) throw new ApiException(409, "RESTART_NOT_ALLOWED", "Повторное выполнение недоступно. Создайте новое задание.");
        int changed = jdbc.update("UPDATE jobs SET status='queued',stage='Ожидает повторного запуска',completed_at=NULL,error_json=NULL,ready_at=NULL WHERE id=? AND status='failed'", id);
        if (changed != 1) throw new ApiException(409, "RESTART_NOT_ALLOWED", "Задание уже запущено.");
        return Map.of("id", id, "status", "queued");
    }

    public List<Map<String,Object>> steps(long id) {
        ReportRecord report = reports.get(id);
        if (report.batchInstanceId() == null || !plans.supports(report.definitionVersion())) return List.of();
        var executions = new ArrayList<>(explorer.getJobExecutions(explorer.getJobInstance(report.batchInstanceId())));
        executions.sort(Comparator.comparing(JobExecution::getId));
        Map<String,Map<String,Object>> result = new LinkedHashMap<>();
        for (var stage : plans.get(report.definitionVersion()).stages()) {
            var item = new LinkedHashMap<String,Object>(); item.put("name", stage.name()); item.put("label", stage.label()); item.put("status", "pending"); result.put(stage.name(), item);
        }
        int attempt = 0;
        for (JobExecution execution : executions) {
            attempt++;
            for (StepExecution step : explorer.getJobExecution(execution.getId()).getStepExecutions()) {
                var item = result.get(step.getStepName());
                if (item == null) continue;
                item.remove("error"); item.remove("startedAt"); item.remove("completedAt");
                item.put("status", switch (step.getStatus()) {
                    case COMPLETED -> "completed";
                    case STARTED, STARTING, STOPPING -> "running";
                    case STOPPED -> "stopped";
                    case FAILED, ABANDONED, UNKNOWN -> "failed";
                });
                item.put("attempt", attempt); item.put("readCount", step.getReadCount()); item.put("writeCount", step.getWriteCount());
                if (step.getStartTime() != null) item.put("startedAt", step.getStartTime().toInstant(ZoneOffset.UTC).toString());
                if (step.getEndTime() != null) item.put("completedAt", step.getEndTime().toInstant(ZoneOffset.UTC).toString());
                if (step.getStatus() == BatchStatus.FAILED) item.put("error", "Не удалось выполнить шаг. Подробности доступны по номеру задания.");
            }
        }
        return new ArrayList<>(result.values());
    }

    private void recoverInterrupted() {
        LocalDateTime stamp = LocalDateTime.ofInstant(catalog.now(), ZoneOffset.UTC);
        for (long id : jdbc.queryForList("SELECT job_execution_id FROM batch_job_execution WHERE status IN ('STARTING','STARTED','STOPPING','UNKNOWN')", Long.class)) {
            JobExecution execution = explorer.getJobExecution(id);
            if (execution == null) continue;
            for (StepExecution step : execution.getStepExecutions()) {
                if (step.getStatus().isRunning() || step.getStatus() == BatchStatus.UNKNOWN) {
                    step.setStatus(BatchStatus.FAILED); step.setExitStatus(ExitStatus.FAILED.addExitDescription("Interrupted by previous process termination")); step.setEndTime(stamp); batch.update(step);
                }
            }
            execution.setStatus(BatchStatus.FAILED); execution.setExitStatus(ExitStatus.FAILED.addExitDescription("Recovered interrupted execution")); execution.setEndTime(stamp); batch.update(execution);
        }
        jdbc.update("UPDATE jobs SET status='queued',stage='Ожидает восстановления',ready_at=NULL WHERE status='running'");
    }

    private void cleanup() {
        Instant now = catalog.now();
        jdbc.update("INSERT INTO object_cleanup(object_key,bucket,reason,created_at) SELECT object_key,bucket,'expired',? FROM job_artifacts WHERE expires_at<=? ON CONFLICT DO NOTHING", ts(now), ts(now));
        jdbc.update("INSERT INTO object_cleanup(object_key,bucket,reason,created_at) SELECT result_metadata->>'key',?,'expired',? FROM jobs "
            + "WHERE status='completed' AND expires_at<=? AND result_metadata->>'key' IS NOT NULL AND result_metadata->>'objectDeletedAt' IS NULL ON CONFLICT DO NOTHING", storage.bucket(), ts(now), ts(now));
        for (var pending : jdbc.queryForList("SELECT object_key,bucket FROM object_cleanup ORDER BY created_at LIMIT 20")) {
            if (!storage.bucket().equals(pending.get("bucket"))) continue;
            try { cleanOne((String) pending.get("object_key")); } catch (Exception ignored) { }
        }
    }

    private void cleanOne(String key) throws Exception {
        // Protect an artifact already committed when a transaction reply was lost.
        Integer live = jdbc.queryForObject("SELECT count(*) FROM job_artifacts WHERE object_key=? AND expires_at>?", Integer.class, key, ts(catalog.now()));
        if (live != null && live > 0) { jdbc.update("DELETE FROM object_cleanup WHERE object_key=?", key); return; }
        storage.delete(key);
        transactions.executeWithoutResult(status -> {
            jdbc.update("DELETE FROM job_artifacts WHERE object_key=? AND expires_at<=?", key, ts(catalog.now()));
            jdbc.update("UPDATE jobs SET result_metadata=result_metadata || jsonb_build_object('objectDeletedAt',?::text) WHERE status='completed' AND expires_at<=? AND result_metadata->>'key'=?",
                catalog.now().toString(), ts(catalog.now()), key);
            jdbc.update("DELETE FROM object_cleanup WHERE object_key=?", key);
        });
    }

    private Map<String,Object> findArtifact(long id, String step, int version) {
        var rows = jdbc.queryForList("SELECT * FROM job_artifacts WHERE job_id=? AND step_name=? AND definition_version=?", id, step, version);
        return rows.isEmpty() ? null : rows.getFirst();
    }
    private Map<String,Object> artifact(long id, String step, int version) {
        var row = findArtifact(id, step, version);
        if (row == null || !((Timestamp) row.get("expires_at")).toInstant().isAfter(catalog.now())) throw new IllegalStateException("Saved intermediate data has expired or is unavailable");
        return row;
    }
    private void registerCleanup(String key, String reason) { jdbc.update("INSERT INTO object_cleanup(object_key,bucket,reason,created_at) VALUES(?,?,?,?) ON CONFLICT(object_key) DO NOTHING", key, storage.bucket(), reason, ts(catalog.now())); }
    private void notify(long id, String event, String title, Instant at) { jdbc.update("INSERT INTO notifications(job_id,title,created_at,event_key) VALUES(?,?,?,?) ON CONFLICT(event_key) DO NOTHING", id, title, ts(at), event); }
    private String setting(String key) { var values = jdbc.queryForList("SELECT value FROM settings WHERE key=?", String.class, key); return values.isEmpty() ? null : values.getFirst(); }
    private void remember(String key, String value) { jdbc.update("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING", key, value); }
    private String json(Object value) { try { return mapper.writeValueAsString(value); } catch (Exception error) { throw new IllegalArgumentException("Cannot encode report metadata", error); } }
    private static Timestamp ts(Instant value) { return Timestamp.from(value); }

    private void seed() throws Exception {
        Instant now = catalog.now();
        Map<String,Object> period = Map.of("startDate", "2026-11-01", "endDate", "2026-11-15", "department", "6000");
        record Seed(long id, String report, Map<String,Object> parameters, String status, long offset) { }
        List<Seed> seeds = List.of(
            new Seed(1043,"reconciliation",Map.of("startDate","2026-11-01","endDate","2026-11-14","department","6000"),"queued",23*3600000),
            new Seed(1044,"balances",Map.of("asOfDate","2026-11-15","department","6000"),"queued",22*3600000),
            new Seed(1045,"payments",period,"failed",25*60000),
            new Seed(1046,"turnovers",Map.of("startDate","2026-10-01","endDate","2026-10-31","department","6000","account","03210001234"),"queued",10*60000),
            new Seed(1047,"obligations",period,"running",3*60000),
            new Seed(1048,"operations",period,"queued",60000)
        );
        transactions.executeWithoutResult(status -> {
            for (Seed sample : seeds) {
                jdbc.update("INSERT INTO jobs(id,report_id,parameters,status,stage,created_at,started_at,ready_at,error_json,completed_at) VALUES(?,?,?::jsonb,?,?,?,?,?,?::jsonb,?) ON CONFLICT(id) DO NOTHING",
                    sample.id(), sample.report(), json(sample.parameters()), sample.status(), sample.status().equals("failed") ? "Файл не создан" : "Ожидает запуска",
                    ts(now.minusMillis(sample.offset())), sample.status().equals("running") ? ts(now) : null,
                    sample.status().equals("running") ? ts(now.plusMillis(processingDelay)) : null,
                    sample.status().equals("failed") ? json(Map.of("code","REPORT_FORMAT_MISMATCH","message","Полученные данные не соответствуют формату отчета. Файл не создан.","at",now.toString())) : null,
                    sample.status().equals("failed") ? ts(now) : null);
            }
            jdbc.queryForObject("SELECT setval(pg_get_serial_sequence('jobs','id'),(SELECT max(id) FROM jobs),true)", Long.class);
        });
        for (long id : new long[]{1043,1044,1046}) if (!reports.get(id).status().equals("completed")) launch(id, false);
    }

    @PreDestroy
    public void stop() {
        Thread worker;
        CountDownLatch completion;
        synchronized (workerState) { stopping = true; worker = workerThread; completion = drained; }
        if (worker == null || worker == Thread.currentThread()) return;
        worker.interrupt();
        // Keep queue ownership and the S3 client alive until the in-flight
        // attempt has completed its abort/cleanup path. The HTTP SDK has
        // bounded request timeouts; a hard kill remains recoverable on startup.
        boolean interrupted = false;
        while (completion.getCount() != 0) {
            try { completion.await(); }
            catch (InterruptedException exception) { interrupted = true; worker.interrupt(); }
        }
        if (interrupted) Thread.currentThread().interrupt();
    }
}
