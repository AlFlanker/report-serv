package dev.reportserv;

import dev.reportserv.batch.ReportExecutionService;
import dev.reportserv.batch.ReportPlanRegistry;
import dev.reportserv.domain.ApiException;
import dev.reportserv.domain.ReportCatalog;
import dev.reportserv.domain.ReportRecord;
import dev.reportserv.pipeline.ReportPipeline;
import dev.reportserv.repository.ReportRepository;
import dev.reportserv.storage.ReportStorage;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.Delete;
import software.amazon.awssdk.services.s3.model.ObjectIdentifier;
import software.amazon.awssdk.services.s3.model.S3Exception;

import javax.xml.parsers.DocumentBuilderFactory;
import javax.xml.parsers.SAXParserFactory;
import org.xml.sax.Attributes;
import org.xml.sax.helpers.DefaultHandler;
import java.io.ByteArrayInputStream;
import java.io.BufferedWriter;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.sql.DriverManager;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.HexFormat;
import java.util.Random;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Real PostgreSQL + S3. Every test owns one random schema and object prefix. */
@Timeout(120)
class BatchIntegrationTest {
    private static final Instant INITIAL_TIME = Instant.parse("2026-11-16T10:00:00Z");
    private static final Map<String, Object> PERIOD = Map.of("department", "6000", "account", "03210001234",
        "startDate", "2026-10-01", "endDate", "2026-10-31");

    @Test
    void restartReusesCompletedExtractionAndKeepsOneJobInstance() throws Exception {
        try (var fixture = new Fixture()) {
            var pipeline = fixture.pipeline();
            doThrow(new IOException("Injected render failure after persisted extraction")).doCallRealMethod()
                .when(pipeline).render(anyString(), anyMap(), anyString(), anyString());
            var created = fixture.create("turnovers", PERIOD);
            var failed = fixture.drive(created.id(), "failed");
            assertEquals(1, failed.definitionVersion());
            assertTrue(fixture.engine().canRestart(created.id()));
            assertNotNull(failed.batchInstanceId());
            var extracted = fixture.firstArtifact(created.id());
            String sourceKey = (String) extracted.get("object_key");
            fixture.assertObjectExists(sourceKey);
            assertEquals(1, fixture.count("SELECT count(*) FROM batch_step_execution WHERE status='COMPLETED'"));
            assertTrue(fixture.count("SELECT count(*) FROM batch_step_execution_context") >= 2);

            fixture.engine().restart(created.id());
            var completed = fixture.drive(created.id(), "completed");
            assertEquals(failed.batchInstanceId(), completed.batchInstanceId());
            assertNotEquals(failed.lastExecutionId(), completed.lastExecutionId());
            assertEquals(2, fixture.count("SELECT count(*) FROM batch_job_execution WHERE job_instance_id=?", failed.batchInstanceId()));
            assertEquals(sourceKey, fixture.firstArtifact(created.id()).get("object_key"));
            verify(pipeline, times(1)).extract(eq("turnovers"), anyMap(), anyString());
            verify(pipeline, times(2)).render(anyString(), anyMap(), eq(sourceKey), anyString());
            assertEquals(1, fixture.successNotifications(created.id()));
            assertFalse(fixture.engine().canRestart(created.id()));
            assertEquals(409, assertThrows(ApiException.class, () -> fixture.engine().restart(created.id())).status());
            fixture.assertWorkbook(completed);

            var firstParameters = fixture.identifyingParameters(failed.lastExecutionId());
            assertEquals(firstParameters, fixture.identifyingParameters(completed.lastExecutionId()));
            assertEquals(2, firstParameters.size(), "Only stable business ID and definition version identify an instance");
            assertTrue(firstParameters.containsValue("1"));
        }
    }

    @Test
    void applicationRestartRecoversInterruptedBatchUsingPersistedStepContexts() throws Exception {
        try (var fixture = new Fixture()) {
            doThrow(new IOException("Prepare an interrupted render attempt"))
                .when(fixture.pipeline()).render(anyString(), anyMap(), anyString(), anyString());
            var created = fixture.create("turnovers", PERIOD);
            var failed = fixture.drive(created.id(), "failed");
            String sourceKey = (String) fixture.firstArtifact(created.id()).get("object_key");
            // A process killed during this step leaves these database states.
            // Completed extraction/context and its S3 artifact are untouched.
            fixture.jdbc().update("UPDATE jobs SET status='running',completed_at=NULL,error_json=NULL WHERE id=?", created.id());
            fixture.jdbc().update("UPDATE batch_job_execution SET status='STARTED',end_time=NULL WHERE job_execution_id=?", failed.lastExecutionId());
            fixture.jdbc().update("UPDATE batch_step_execution SET status='STARTED',end_time=NULL WHERE job_execution_id=? AND status='FAILED'", failed.lastExecutionId());

            fixture.restartApplication();
            var completed = fixture.drive(created.id(), "completed");
            assertEquals(failed.batchInstanceId(), completed.batchInstanceId());
            assertNotEquals(failed.lastExecutionId(), completed.lastExecutionId());
            assertEquals(sourceKey, fixture.firstArtifact(created.id()).get("object_key"));
            verify(fixture.pipeline(), never()).extract(anyString(), anyMap(), anyString());
            assertEquals(1, fixture.successNotifications(created.id()));
            fixture.assertWorkbook(completed);
        }
    }

    @Test
    void nightWindowAndDefinitionVersionRemainServerControlled() throws Exception {
        try (var fixture = new Fixture()) {
            var operations = fixture.create("operations", Map.of("department", "6000", "startDate", "2026-11-01", "endDate", "2026-11-15"));
            fixture.engine().tick();
            assertEquals("queued", fixture.repo().get(operations.id()).status());
            assertNull(fixture.repo().get(operations.id()).batchInstanceId());
            fixture.clock().set(Instant.parse("2026-11-16T21:00:00Z")); // 00:00 Moscow
            var completed = fixture.drive(operations.id(), "completed");
            assertEquals(1, completed.definitionVersion());
            fixture.assertWorkbook(completed);

            var unsupported = fixture.create("turnovers", PERIOD);
            fixture.jdbc().update("UPDATE jobs SET definition_version=999,status='failed' WHERE id=?", unsupported.id());
            assertFalse(fixture.engine().canRestart(unsupported.id()));
            assertThrows(ApiException.class, () -> fixture.engine().restart(unsupported.id()));
            assertNull(fixture.repo().get(unsupported.id()).batchInstanceId());
        }
    }

    @Test
    void retentionRemovesFinalAndIntermediateObjectsButPreservesHistory() throws Exception {
        try (var fixture = new Fixture()) {
            var created = fixture.create("turnovers", PERIOD);
            var completed = fixture.drive(created.id(), "completed");
            var keys = fixture.jdbc().queryForList("SELECT object_key FROM job_artifacts WHERE job_id=?", String.class, created.id());
            assertFalse(keys.isEmpty());
            String resultKey = (String) completed.result().get("key");
            keys = new ArrayList<>(keys);
            keys.add(resultKey);
            for (String key : keys) fixture.assertObjectExists(key);
            fixture.clock().set(completed.expiresAt().plus(Duration.ofDays(1)));
            fixture.engine().tick();
            for (String key : keys) fixture.assertObjectAbsent(key);
            assertEquals("completed", fixture.repo().get(created.id()).status());
            assertEquals(1, fixture.successNotifications(created.id()));
        }
    }

    @Test
    void expiredIntermediateResultsCannotBeUsedForRestart() throws Exception {
        try (var fixture = new Fixture()) {
            doThrow(new IOException("Rendering unavailable"))
                .when(fixture.pipeline()).render(anyString(), anyMap(), anyString(), anyString());
            var created = fixture.create("turnovers", PERIOD);
            fixture.drive(created.id(), "failed");
            assertTrue(fixture.engine().canRestart(created.id()));
            fixture.clock().set(INITIAL_TIME.plus(Duration.ofDays(9)));
            assertFalse(fixture.engine().canRestart(created.id()));
            assertThrows(ApiException.class, () -> fixture.engine().restart(created.id()));
        }
    }

    @Test
    void compositionStreamsTwoPersistedSourcesIntoOneWorkbook() throws Exception {
        try (var fixture = new Fixture()) {
            var first = fixture.pipeline().extract("turnovers", PERIOD, fixture.prefix + "first.jsonl");
            var secondParameters = new HashMap<>(PERIOD);
            secondParameters.put("department", "6001");
            var second = fixture.pipeline().extract("turnovers", secondParameters, fixture.prefix + "second.jsonl");
            var composed = fixture.pipeline().compose(List.of(first.object().key(), second.object().key()), fixture.prefix + "composed.jsonl");
            assertEquals(first.rowCount() + second.rowCount(), composed.rowCount());
            assertTrue(composed.rowCount() > 0);
            var result = fixture.pipeline().render("Составной отчет", PERIOD, composed.object().key(), fixture.prefix + "composed.xlsx");
            assertEquals(composed.rowCount(), result.rowCount());
            var workbook = fixture.workbookEntries(result.object().key());
            assertEquals(result.rowCount() + 1, xmlRowCount(workbook.get("xl/worksheets/sheet2.xml")));
        }
    }

    @Test
    void versionedCompositePlanPersistsAllFiveSteps() throws Exception {
        try (var fixture = new Fixture()) {
            var created = fixture.create("turnovers", PERIOD);
            fixture.jdbc().update("UPDATE jobs SET definition_version=2 WHERE id=?", created.id());
            var completed = fixture.drive(created.id(), "completed");
            assertEquals(2, completed.definitionVersion());
            assertEquals(5, fixture.count("SELECT count(*) FROM batch_step_execution WHERE job_execution_id=? AND status='COMPLETED'", completed.lastExecutionId()));
            assertEquals(4, fixture.count("SELECT count(*) FROM job_artifacts WHERE job_id=?", created.id()));
            assertEquals(5, fixture.engine().steps(created.id()).size());
            assertTrue(fixture.engine().steps(created.id()).stream().allMatch(step -> step.get("status").equals("completed")));
            long sourceRows = fixture.jdbc().queryForObject("SELECT row_count FROM job_artifacts WHERE job_id=? AND step_name='extractPrimary'", Long.class, created.id());
            assertTrue(sourceRows > 0);
            assertEquals(sourceRows * 2, ((Number) completed.result().get("rowCount")).longValue());
            fixture.assertWorkbook(completed);
        }
    }

    @Test
    void largeWorkbookUsesMultipleRealS3PartsAndStreamingReadback() throws Exception {
        try (var fixture = new Fixture()) {
            var storage = fixture.context.getBean(ReportStorage.class);
            int count = 50_000;
            String[] edgeValues = new String[2];
            String sourceKey = fixture.prefix + "large-source.jsonl";
            storage.upload(sourceKey, ReportStorage.JSONL_CONTENT_TYPE, output -> {
                var writer = new BufferedWriter(new OutputStreamWriter(output, StandardCharsets.UTF_8), 64 * 1024);
                writer.write("{\"columns\":[{\"key\":\"number\",\"title\":\"Номер\",\"type\":\"number\",\"width\":14},{\"key\":\"value\",\"title\":\"Значение\",\"type\":\"string\",\"width\":40}]}\n");
                var random = new Random(871_992);
                byte[] bytes = new byte[128];
                for (int row = 1; row <= count; row++) {
                    random.nextBytes(bytes);
                    String value = HexFormat.of().formatHex(bytes);
                    if (row == 1) edgeValues[0] = value;
                    if (row == count) edgeValues[1] = value;
                    writer.write("{\"number\":" + row + ",\"value\":\"" + value + "\"}\n");
                }
                writer.flush();
            });
            var artifact = fixture.pipeline().render("Проверка большого отчета", PERIOD, sourceKey, fixture.prefix + "large.xlsx");
            assertEquals(count, artifact.rowCount());
            assertTrue(artifact.object().sizeBytes() > 5L * 1024 * 1024, "Compressed workbook must exceed the configured S3 part size");
            assertEquals(artifact.object().sizeBytes(), fixture.s3.headObject(b -> b.bucket(fixture.bucket).key(artifact.object().key())).contentLength());
            var handler = new DefaultHandler() {
                long rows;
                String cell;
                boolean text;
                final StringBuilder content = new StringBuilder();
                final Map<String, String> values = new HashMap<>();
                @Override public void startElement(String uri, String localName, String name, Attributes attributes) {
                    if (name.equals("row")) rows++;
                    if (name.equals("c")) cell = attributes.getValue("r");
                    if (name.equals("t") || name.equals("v")) { text = true; content.setLength(0); }
                }
                @Override public void characters(char[] characters, int start, int length) { if (text) content.append(characters, start, length); }
                @Override public void endElement(String uri, String localName, String name) {
                    if (name.equals("t") || name.equals("v")) {
                        if (List.of("A2", "B2", "A50001", "B50001").contains(cell)) values.put(cell, content.toString());
                        text = false;
                    }
                }
            };
            boolean found = false;
            try (var download = storage.open(artifact.object().key()); var zip = new ZipInputStream(download.body())) {
                for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                    if (!entry.getName().equals("xl/worksheets/sheet2.xml")) continue;
                    var factory = SAXParserFactory.newInstance();
                    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
                    factory.newSAXParser().parse(new FilterInputStream(zip) { @Override public void close() { } }, handler);
                    found = true;
                    break;
                }
            }
            assertTrue(found);
            assertEquals(count + 1, handler.rows);
            assertEquals("1", handler.values.get("A2"));
            assertEquals(Integer.toString(count), handler.values.get("A50001"));
            assertEquals(edgeValues[0], handler.values.get("B2"));
            assertEquals(edgeValues[1], handler.values.get("B50001"));
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class TestHooks {
        @Bean @Primary MutableClock mutableTestClock() { return new MutableClock(INITIAL_TIME); }
        @Bean @Primary ReportPlanRegistry compositeTestPlans() {
            var plans = new ArrayList<>(new ReportPlanRegistry().all());
            plans.add(new ReportPlanRegistry.Plan(2, List.of(
                new ReportPlanRegistry.Stage("extractPrimary", "Основной источник", ReportPlanRegistry.Kind.EXTRACT, List.of(), "turnovers"),
                new ReportPlanRegistry.Stage("extractSecondary", "Дополнительный источник", ReportPlanRegistry.Kind.EXTRACT, List.of(), "turnovers"),
                new ReportPlanRegistry.Stage("compose", "Объединение", ReportPlanRegistry.Kind.COMPOSE, List.of("extractPrimary", "extractSecondary"), null),
                new ReportPlanRegistry.Stage("render", "Формирование Excel", ReportPlanRegistry.Kind.RENDER, List.of("compose"), null),
                new ReportPlanRegistry.Stage("publish", "Публикация результата", ReportPlanRegistry.Kind.PUBLISH, List.of("render"), null)
            )));
            return new ReportPlanRegistry(plans);
        }
        @Bean static BeanPostProcessor spyPipeline() {
            return new BeanPostProcessor() {
                @Override public Object postProcessAfterInitialization(Object bean, String name) throws BeansException {
                    return bean instanceof ReportPipeline ? spy(bean) : bean;
                }
            };
        }
    }

    static final class MutableClock extends Clock {
        private final AtomicReference<Instant> current;
        MutableClock(Instant value) { current = new AtomicReference<>(value); }
        void set(Instant value) { current.set(value); }
        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return Clock.fixed(instant(), zone); }
        @Override public Instant instant() { return current.get(); }
    }

    private static final class Fixture implements AutoCloseable {
        final String schema = "batchtest_" + UUID.randomUUID().toString().replace("-", "");
        final String prefix = System.getenv().getOrDefault("S3_PREFIX", "reports/").replaceAll("/+$", "") + "/batch-test-" + UUID.randomUUID() + "/";
        final String bucket = System.getenv().getOrDefault("S3_BUCKET", "reports");
        final String databaseUrl = requireEnvironment("DATABASE_URL");
        final S3Client s3;
        ConfigurableApplicationContext context;

        Fixture() {
            var builder = S3Client.builder().region(Region.of(System.getenv().getOrDefault("S3_REGION", "us-east-1")))
                .forcePathStyle(Boolean.parseBoolean(System.getenv().getOrDefault("S3_FORCE_PATH_STYLE", "true")));
            String endpoint = System.getenv("S3_ENDPOINT");
            if (endpoint != null && !endpoint.isBlank()) builder.endpointOverride(URI.create(endpoint));
            String key = System.getenv("S3_ACCESS_KEY_ID");
            if (key != null && !key.isBlank()) builder.credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(key, requireEnvironment("S3_SECRET_ACCESS_KEY"))));
            else builder.credentialsProvider(DefaultCredentialsProvider.create());
            s3 = builder.build();
            try { start(); }
            catch (RuntimeException failure) { try { close(); } catch (Exception cleanup) { failure.addSuppressed(cleanup); } throw failure; }
        }

        void start() {
            context = new SpringApplicationBuilder(ReportApplication.class, TestHooks.class).web(WebApplicationType.NONE)
                .run("--DATABASE_URL=" + databaseUrl, "--DATABASE_SCHEMA=" + schema, "--S3_PREFIX=" + prefix,
                    "--SEED_DEMO=false", "--BATCH_SCHEDULING_ENABLED=false", "--REPORT_PROCESSING_DELAY_MS=0", "--S3_PART_SIZE_MIB=5",
                    "--spring.main.banner-mode=off", "--logging.level.root=WARN");
        }
        void restartApplication() { context.close(); context = null; start(); }
        ReportRepository repo() { return context.getBean(ReportRepository.class); }
        ReportPipeline pipeline() { return context.getBean(ReportPipeline.class); }
        ReportExecutionService engine() { return context.getBean(ReportExecutionService.class); }
        JdbcTemplate jdbc() { return repo().jdbc(); }
        MutableClock clock() { return context.getBean(MutableClock.class); }
        ReportRecord create(String id, Map<String, Object> parameters) { return repo().create(context.getBean(ReportCatalog.class).get(id), parameters, clock().instant()); }
        ReportRecord drive(long id, String desiredStatus) throws Exception {
            for (int attempt = 0; attempt < 100; attempt++) {
                engine().tick();
                var current = repo().get(id);
                if (current.status().equals(desiredStatus)) return current;
                if (List.of("failed", "completed").contains(current.status())) fail("Unexpected terminal state: " + current.status() + ", " + current.error());
                Thread.sleep(25);
            }
            return fail("Job did not reach " + desiredStatus);
        }
        Map<String, Object> firstArtifact(long job) { return jdbc().queryForMap("SELECT * FROM job_artifacts WHERE job_id=? ORDER BY created_at,step_name LIMIT 1", job); }
        long count(String sql, Object... arguments) { return jdbc().queryForObject(sql, Long.class, arguments); }
        long successNotifications(long job) { return count("SELECT count(*) FROM notifications WHERE job_id=? AND title LIKE 'Отчет%готов%'", job); }
        Map<String, String> identifyingParameters(long execution) {
            var result = new HashMap<String, String>();
            jdbc().query("SELECT parameter_name,parameter_value FROM batch_job_execution_params WHERE job_execution_id=? AND identifying='Y'",
                rs -> { result.put(rs.getString(1), rs.getString(2)); }, execution);
            return result;
        }
        void assertObjectExists(String key) { assertTrue(s3.headObject(b -> b.bucket(bucket).key(key)).contentLength() > 0); }
        void assertObjectAbsent(String key) { assertEquals(404, assertThrows(S3Exception.class, () -> s3.headObject(b -> b.bucket(bucket).key(key))).statusCode()); }
        Map<String, byte[]> workbookEntries(String key) throws IOException {
            Map<String, byte[]> entries = new HashMap<>();
            try (var input = context.getBean(ReportStorage.class).open(key); var zip = new ZipInputStream(input.body())) {
                for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) entries.put(entry.getName(), zip.readAllBytes());
            }
            assertTrue(entries.containsKey("[Content_Types].xml"));
            assertTrue(entries.containsKey("xl/workbook.xml"));
            return entries;
        }
        void assertWorkbook(ReportRecord job) throws Exception {
            assertNotNull(job.result());
            assertEquals("s3", job.result().get("storage"));
            var entries = workbookEntries((String) job.result().get("key"));
            assertEquals(((Number) job.result().get("rowCount")).longValue() + 1, xmlRowCount(entries.get("xl/worksheets/sheet2.xml")));
            assertTrue(new String(entries.get("xl/worksheets/sheet1.xml"), StandardCharsets.UTF_8).contains("03210001234") || job.reportId().equals("operations"));
        }
        @Override public void close() throws Exception {
            try { if (context != null) context.close(); }
            finally {
                try {
                    String token = null;
                    do {
                        var request = software.amazon.awssdk.services.s3.model.ListObjectsV2Request.builder().bucket(bucket).prefix(prefix).continuationToken(token).build();
                        var page = s3.listObjectsV2(request);
                        if (!page.contents().isEmpty()) {
                            var keys = page.contents().stream().map(o -> ObjectIdentifier.builder().key(o.key()).build()).toList();
                            s3.deleteObjects(b -> b.bucket(bucket).delete(Delete.builder().objects(keys).build()));
                        }
                        token = page.nextContinuationToken();
                    } while (token != null);
                } finally {
                    s3.close();
                    if (!schema.matches("batchtest_[a-f0-9]{32}")) throw new IllegalStateException("Refusing to remove a non-test schema");
                    URI uri = URI.create(databaseUrl);
                    String[] credentials = uri.getRawUserInfo().split(":", 2);
                    String jdbcUrl = "jdbc:postgresql://" + uri.getHost() + ":" + (uri.getPort() < 0 ? 5432 : uri.getPort()) + uri.getRawPath();
                    try (var connection = DriverManager.getConnection(jdbcUrl, URLDecoder.decode(credentials[0], StandardCharsets.UTF_8), URLDecoder.decode(credentials[1], StandardCharsets.UTF_8)); var statement = connection.createStatement()) {
                        statement.execute("DROP SCHEMA IF EXISTS \"" + schema + "\" CASCADE");
                    }
                }
            }
        }
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) throw new IllegalStateException(name + " is required for real PostgreSQL/S3 integration tests; run npm run infra:up first");
        return value;
    }
    private static long xmlRowCount(byte[] xml) throws Exception {
        assertNotNull(xml);
        var factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        return factory.newDocumentBuilder().parse(new ByteArrayInputStream(xml)).getElementsByTagName("row").getLength();
    }
}
