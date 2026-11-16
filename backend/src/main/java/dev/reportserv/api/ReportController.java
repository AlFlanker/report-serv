package dev.reportserv.api;

import dev.reportserv.batch.ReportExecutionService;
import dev.reportserv.domain.ApiException;
import dev.reportserv.domain.ReportCatalog;
import dev.reportserv.domain.ReportRecord;
import dev.reportserv.repository.ReportRepository;
import dev.reportserv.storage.ReportStorage;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import software.amazon.awssdk.services.s3.model.S3Exception;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class ReportController {
    private final ReportRepository repository;
    private final ReportCatalog catalog;
    private final ReportExecutionService executions;
    private final ReportStorage storage;

    public ReportController(ReportRepository repository, ReportCatalog catalog,
                            ReportExecutionService executions, ReportStorage storage) {
        this.repository = repository;
        this.catalog = catalog;
        this.executions = executions;
        this.storage = storage;
    }

    @GetMapping("/health")
    public Map<String, Object> health() { return Map.of("status", "ok"); }

    @GetMapping("/ready")
    public Map<String, Object> ready() {
        try {
            if (!executions.isReady()) throw new IllegalStateException("Batch initialization is incomplete");
            repository.jdbc().queryForObject("SELECT 1", Integer.class);
            storage.check();
            return Map.of("status", "ok", "database", "postgresql", "storage", "s3", "engine", "spring-batch");
        } catch (Exception error) {
            throw new ApiException(503, "DEPENDENCY_UNAVAILABLE", "База данных или хранилище отчетов временно недоступны.");
        }
    }

    @GetMapping("/catalog")
    public Map<String, Object> catalog() { return catalog.view(); }

    @GetMapping("/jobs")
    public Map<String, Object> jobs(@RequestParam Map<String, String> query) {
        var page = repository.list(query);
        return Map.of("items", page.items().stream().map(job -> view(job, false)).toList(),
            "total", page.total(), "allCount", page.allCount(), "updatedAt", catalog.now().toString());
    }

    @PostMapping(value = "/jobs", consumes = "application/json")
    @ResponseStatus(HttpStatus.CREATED)
    public Map<String, Object> create(@RequestBody Map<String, Object> body) {
        var validated = catalog.validate(body);
        return view(repository.create(validated.definition(), validated.parameters(), catalog.now()), true);
    }

    @GetMapping("/jobs/{id}")
    public Map<String, Object> job(@PathVariable long id) {
        requireId(id);
        return view(repository.get(id), true);
    }

    @GetMapping("/jobs/{id}/steps")
    public Map<String, Object> steps(@PathVariable long id) {
        requireId(id);
        repository.get(id);
        return Map.of("items", executions.steps(id), "canRestart", executions.canRestart(id));
    }

    @PostMapping("/jobs/{id}/restart")
    public Map<String, Object> restart(@PathVariable long id) {
        requireId(id);
        repository.get(id);
        executions.restart(id);
        return view(repository.get(id), true);
    }

    @GetMapping("/jobs/{id}/download")
    public void download(@PathVariable long id, HttpServletResponse response) throws IOException {
        requireId(id);
        var job = repository.get(id);
        if (!"completed".equals(job.status())) throw new ApiException(409, "RESULT_NOT_READY", "Файл еще не готов.");
        if (job.expiresAt() != null && !job.expiresAt().isAfter(catalog.now())) {
            throw new ApiException(410, "RESULT_EXPIRED", "Срок хранения файла истек. Сформируйте новый отчет.");
        }
        if (job.result() == null || !(job.result().get("key") instanceof String key) || job.result().containsKey("objectDeletedAt")) {
            throw new ApiException(410, "RESULT_UNAVAILABLE", "Файл больше недоступен. Сформируйте новый отчет.");
        }
        ReportStorage.Download download;
        try { download = storage.open(key); }
        catch (S3Exception error) {
            if (error.statusCode() == 404) throw new ApiException(410, "RESULT_UNAVAILABLE", "Файл больше недоступен. Сформируйте новый отчет.");
            throw new ApiException(503, "STORAGE_UNAVAILABLE", "Хранилище отчетов временно недоступно. Повторите попытку позже.");
        } catch (Exception error) {
            throw new ApiException(503, "STORAGE_UNAVAILABLE", "Хранилище отчетов временно недоступно. Повторите попытку позже.");
        }
        try (download) {
            response.setContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            String fileName = job.result().get("fileName") instanceof String name && !name.isBlank()
                ? name : "report-" + id + "-" + job.reportId() + ".xlsx";
            response.setHeader("Content-Disposition", ContentDisposition.attachment()
                .filename(fileName, StandardCharsets.UTF_8).build().toString());
            if (download.contentLength() >= 0) response.setContentLengthLong(download.contentLength());
            // Download.close aborts the S3 response instead of draining it when
            // a browser disconnects; no full report buffer is allocated here.
            download.body().transferTo(response.getOutputStream());
        }
    }

    @GetMapping("/notifications")
    public Map<String, Object> notifications() { return repository.notifications(); }

    @PostMapping(value = "/notifications/read", consumes = "application/json")
    public Map<String, Object> markRead(@RequestBody Map<String, Object> body) {
        if (body == null || !(body.get("ids") instanceof List<?> values) || values.size() > 100) throw invalidNotifications();
        var ids = new ArrayList<Long>();
        for (Object value : values) {
            if (!(value instanceof Number number)) throw invalidNotifications();
            long id = number.longValue();
            if (id < 1 || id > 9_007_199_254_740_991L || number.doubleValue() != id) throw invalidNotifications();
            ids.add(id);
        }
        repository.markNotifications(ids);
        return Map.of("ok", true);
    }

    public Map<String, Object> view(ReportRecord job, boolean details) {
        var definition = catalog.get(job.reportId());
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", job.id());
        result.put("reportId", job.reportId());
        result.put("reportName", definition.name());
        result.put("parameters", job.parameters());
        result.put("status", job.status());
        result.put("stage", job.stage());
        result.put("createdAt", job.createdAt().toString());
        putTime(result, "startedAt", job.startedAt());
        putTime(result, "completedAt", job.completedAt());
        putTime(result, "expiresAt", job.expiresAt());
        if (job.result() != null) {
            Map<String, Object> metadata = new LinkedHashMap<>();
            for (String field : List.of("fileName", "sizeBytes", "rowCount")) {
                if (job.result().containsKey(field)) metadata.put(field, job.result().get(field));
            }
            result.put("result", metadata);
        }
        if (job.error() != null) result.put("error", job.error());
        if (job.status().equals("queued") && definition.nightOnly()) result.put("nextWindow", catalog.nextWindow(catalog.now()));
        result.put("definitionVersion", job.definitionVersion());
        if (job.batchInstanceId() != null) result.put("batchInstanceId", job.batchInstanceId());
        if (job.lastExecutionId() != null) result.put("executionId", job.lastExecutionId());
        if (details) {
            result.put("steps", executions.steps(job.id()));
            result.put("canRestart", executions.canRestart(job.id()));
        }
        return result;
    }

    private static void putTime(Map<String, Object> target, String key, Instant instant) { if (instant != null) target.put(key, instant.toString()); }
    private static void requireId(long id) { if (id < 1 || id > 9_007_199_254_740_991L) throw new ApiException(400, "INVALID_JOB_ID", "Некорректный номер задания."); }
    private static ApiException invalidNotifications() { return new ApiException(400, "INVALID_NOTIFICATION_IDS", "Некорректный список уведомлений."); }
}
