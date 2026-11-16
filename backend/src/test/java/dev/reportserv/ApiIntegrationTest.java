package dev.reportserv;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.reportserv.batch.ReportExecutionService;
import dev.reportserv.repository.ReportRepository;
import dev.reportserv.storage.ReportStorage;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.http.ContentDisposition;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.*;

/** HTTP boundary tests exercise the Java server with real PostgreSQL and S3. */
@Timeout(120)
class ApiIntegrationTest {
    private static final String SCHEMA = "apitest_" + UUID.randomUUID().toString().replace("-", "");
    private static final String PREFIX = System.getenv().getOrDefault("S3_PREFIX", "reports/").replaceAll("/+$", "") + "/api-test-" + UUID.randomUUID() + "/";
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private static final ObjectMapper JSON = new ObjectMapper();
    private static ConfigurableApplicationContext context;
    private static URI base;

    @BeforeAll static void start() {
        context = new SpringApplicationBuilder(ReportApplication.class).web(WebApplicationType.SERVLET)
            .run("--server.port=0", "--DATABASE_SCHEMA=" + SCHEMA, "--S3_PREFIX=" + PREFIX,
                "--SEED_DEMO=false", "--BATCH_SCHEDULING_ENABLED=false", "--REPORT_PROCESSING_DELAY_MS=0",
                "--spring.main.banner-mode=off", "--logging.level.root=WARN");
        base = URI.create("http://127.0.0.1:" + ((WebServerApplicationContext) context).getWebServer().getPort());
    }

    @AfterAll static void stop() throws Exception {
        try {
            if (context != null) {
                // Only keys registered by this isolated application's jobs.
                var repository = context.getBean(ReportRepository.class);
                var storage = context.getBean(ReportStorage.class);
                var keys = repository.jdbc().queryForList("SELECT object_key FROM job_artifacts UNION SELECT result_metadata->>'key' FROM jobs WHERE result_metadata->>'key' IS NOT NULL UNION SELECT object_key FROM object_cleanup", String.class);
                for (String key : keys) {
                    if (!key.startsWith(PREFIX)) throw new IllegalStateException("Refusing to delete an object outside the HTTP test prefix");
                    storage.delete(key);
                }
            }
        } finally {
            if (context != null) context.close();
            if (!SCHEMA.matches("apitest_[a-f0-9]{32}")) throw new IllegalStateException("Refusing to remove a non-test schema");
            String database = System.getenv("DATABASE_URL");
            if (database != null) {
                var uri = URI.create(database);
                var credentials = uri.getRawUserInfo().split(":", 2);
                String jdbc = "jdbc:postgresql://" + uri.getHost() + ":" + (uri.getPort() < 0 ? 5432 : uri.getPort()) + uri.getRawPath();
                try (var connection = DriverManager.getConnection(jdbc, URLDecoder.decode(credentials[0], StandardCharsets.UTF_8), URLDecoder.decode(credentials[1], StandardCharsets.UTF_8)); var statement = connection.createStatement()) {
                    statement.execute("DROP SCHEMA IF EXISTS \"" + SCHEMA + "\" CASCADE");
                }
            }
        }
    }

    @Test void validatesHttpCommandsAndPreservesErrorEnvelope() throws Exception {
        var ready = get("/api/ready");
        assertEquals(200, ready.statusCode());
        assertEquals("spring-batch", json(ready).path("engine").asText());

        var invalid = post("/api/jobs", Map.of("reportId", "operations", "parameters",
            Map.of("department", "6000", "startDate", "2026-10-01", "endDate", "2026-11-01")));
        assertEquals(400, invalid.statusCode());
        assertEquals("INVALID_PARAMETERS", json(invalid).path("error").path("code").asText());
        assertTrue(json(invalid).path("error").path("fields").path("endDate").asText().contains("31"));
        assertEquals(415, send("/api/jobs", "POST", "{}", "text/plain").statusCode());
        assertEquals(400, send("/api/jobs", "POST", "{broken", "application/json").statusCode());
        var oversized = send("/api/jobs", "POST", "{\"value\":\"" + "a".repeat(70_000) + "\"}", "application/json");
        assertEquals(413, oversized.statusCode());
        assertEquals("REQUEST_TOO_LARGE", json(oversized).path("error").path("code").asText());
        assertEquals(404, get("/api/jobs/9000000").statusCode());
        assertEquals(400, get("/api/jobs/-1").statusCode());
        assertEquals(400, get("/api/jobs?page=0").statusCode());
        assertEquals(400, post("/api/notifications/read", Map.of("ids", List.of(1.5))).statusCode());
        assertEquals("no-store", ready.headers().firstValue("cache-control").orElseThrow());
        assertEquals("nosniff", ready.headers().firstValue("x-content-type-options").orElseThrow());
    }

    @Test void createsExecutesAndDownloadsReportWithStoredFilename() throws Exception {
        var created = post("/api/jobs", Map.of("reportId", "turnovers", "parameters", Map.of(
            "department", "6000", "account", "03210001234", "startDate", "2026-10-01", "endDate", "2026-10-31")));
        assertEquals(201, created.statusCode());
        long id = json(created).path("id").asLong();
        assertEquals(1, json(created).path("definitionVersion").asInt());
        var engine = context.getBean(ReportExecutionService.class);
        var repository = context.getBean(ReportRepository.class);
        for (int i = 0; i < 100 && !repository.get(id).status().equals("completed"); i++) {
            engine.tick();
            assertNotEquals("failed", repository.get(id).status(), String.valueOf(repository.get(id).error()));
            Thread.sleep(20);
        }
        assertEquals("completed", repository.get(id).status());
        String savedName = "Отчет \"октябрь\".xlsx";
        repository.jdbc().update("UPDATE jobs SET result_metadata=jsonb_set(result_metadata,'{fileName}',to_jsonb(?::text)) WHERE id=?", savedName, id);
        var completed = json(get("/api/jobs/" + id));
        assertEquals(savedName, completed.path("result").path("fileName").asText());
        assertFalse(completed.path("result").has("key"), "Object locations remain server-side");
        assertFalse(completed.path("canRestart").asBoolean());
        assertTrue(completed.path("steps").size() >= 3);

        var download = HTTP.send(HttpRequest.newBuilder(base.resolve("/api/jobs/" + id + "/download")).timeout(Duration.ofSeconds(30)).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
        assertEquals(200, download.statusCode());
        assertEquals(savedName, ContentDisposition.parse(download.headers().firstValue("content-disposition").orElseThrow()).getFilename());
        assertEquals(download.body().length, Long.parseLong(download.headers().firstValue("content-length").orElseThrow()));
        var entries = new ArrayList<String>();
        try (var zip = new ZipInputStream(new ByteArrayInputStream(download.body()))) {
            for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) entries.add(entry.getName());
        }
        assertTrue(entries.contains("xl/worksheets/sheet2.xml"));
        assertEquals(409, post("/api/jobs/" + id + "/restart", Map.of()).statusCode());

        var notification = json(get("/api/notifications")).path("items").get(0);
        assertEquals(id, notification.path("jobId").asLong());
        assertEquals(200, post("/api/notifications/read", Map.of("ids", List.of(notification.path("id").asLong()))).statusCode());
        assertEquals(0, json(get("/api/notifications")).path("unreadCount").asLong());
    }

    private static HttpResponse<String> get(String path) throws Exception { return send(path, "GET", null, null); }
    private static HttpResponse<String> post(String path, Map<String, Object> body) throws Exception { return send(path, "POST", JSON.writeValueAsString(body), "application/json"); }
    private static HttpResponse<String> send(String path, String method, String body, String contentType) throws Exception {
        var request = HttpRequest.newBuilder(base.resolve(path)).timeout(Duration.ofSeconds(30));
        if (contentType != null) request.header("Content-Type", contentType);
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        return HTTP.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }
    private static JsonNode json(HttpResponse<String> response) throws Exception { return JSON.readTree(response.body()); }
}
