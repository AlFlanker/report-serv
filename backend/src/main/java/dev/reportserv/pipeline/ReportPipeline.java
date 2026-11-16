package dev.reportserv.pipeline;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import dev.reportserv.storage.ReportStorage;
import dev.reportserv.storage.ReportStorage.StoredObject;

/** Durable row artifacts separate data acquisition from restartable XLSX generation. */
@Service
public class ReportPipeline {
    private static final Set<String> REPORTS = Set.of("operations", "turnovers", "obligations", "payments", "balances", "reconciliation");
    private static final TypeReference<Map<String, Object>> ROW_TYPE = new TypeReference<>() {};
    private final ReportStorage storage;
    private final ObjectMapper mapper;

    public record Artifact(StoredObject object, long rowCount) {}
    public static class SourceFormatException extends IOException {
        public SourceFormatException(String message) { super(message); }
        public String code() { return "REPORT_FORMAT_MISMATCH"; }
    }

    public ReportPipeline(ReportStorage storage, ObjectMapper mapper) { this.storage = storage; this.mapper = mapper; }

    public Artifact extract(String reportId, Map<String, Object> parameters, String objectKey) throws IOException {
        ReportStorage.interrupted();
        if (!REPORTS.contains(reportId)) throw new SourceFormatException("Неизвестный отчет.");
        JsonNode fixture;
        try (InputStream input = getClass().getResourceAsStream("/fixtures/" + reportId + ".json")) {
            if (input == null) throw new SourceFormatException("Подготовленный ответ целевой системы недоступен.");
            fixture = mapper.readTree(input);
        }
        JsonNode columns = fixture.path("columns");
        validateColumns(columns);
        if (!fixture.path("rows").isArray()) throw new SourceFormatException("Некорректные строки ответа целевой системы.");
        Set<String> keys = new HashSet<>();
        columns.forEach(c -> keys.add(c.path("key").asText()));
        if (!keys.contains("date") || !keys.contains("department") || (reportId.equals("turnovers") && !keys.contains("account"))) {
            throw new SourceFormatException("В ответе целевой системы отсутствуют обязательные столбцы.");
        }
        for (JsonNode column : columns) {
            String key = column.path("key").asText();
            if ((key.equals("date") && !column.path("type").asText().equals("date"))
                || ((key.equals("department") || (reportId.equals("turnovers") && key.equals("account")))
                && !column.path("type").asText().equals("string"))) {
                throw new SourceFormatException("Типы обязательных столбцов не соответствуют формату отчета.");
            }
        }
        String department = stringParameter(parameters, "department");
        String start = reportId.equals("balances") ? "" : dateParameter(parameters, "startDate");
        String end = reportId.equals("balances") ? dateParameter(parameters, "asOfDate") : dateParameter(parameters, "endDate");
        String account = reportId.equals("turnovers") ? stringParameter(parameters, "account") : "";
        if (!start.isEmpty() && start.compareTo(end) > 0) throw new SourceFormatException("Некорректный период отчета.");
        String latest = "";
        for (JsonNode row : fixture.path("rows")) {
            ReportStorage.interrupted();
            validateRow(columns, row);
            if (reportId.equals("balances") && row.path("department").asText().equals(department)) {
                String date = row.path("date").asText();
                if (date.compareTo(end) <= 0 && date.compareTo(latest) > 0) latest = date;
            }
        }
        String snapshot = latest;
        AtomicLong count = new AtomicLong();
        StoredObject object = storage.upload(objectKey, ReportStorage.JSONL_CONTENT_TYPE, output -> {
            try (JsonGenerator json = mapper.getFactory().createGenerator(output)) {
                json.disable(JsonGenerator.Feature.AUTO_CLOSE_TARGET);
                json.writeObject(Map.of("columns", columns)); json.writeRaw('\n');
                for (JsonNode row : fixture.path("rows")) {
                    ReportStorage.interrupted();
                    if (!row.path("department").asText().equals(department)) continue;
                    String date = row.path("date").asText();
                    if (reportId.equals("balances") ? !date.equals(snapshot) : date.compareTo(start) < 0 || date.compareTo(end) > 0) continue;
                    if (reportId.equals("turnovers") && !row.path("account").asText().equals(account)) continue;
                    json.writeTree(row); json.writeRaw('\n'); count.incrementAndGet();
                }
            }
        });
        return new Artifact(object, count.get());
    }

    public Artifact render(String reportName, Map<String, Object> parameters, String sourceKey, String objectKey) throws IOException {
        try (var source = storage.open(sourceKey); var parser = mapper.getFactory().createParser(new BufferedInputStream(source.body(), 64 * 1024))) {
            JsonNode columns = readHeader(parser);
            List<StreamingWorkbook.Column> workbookColumns = new ArrayList<>();
            for (JsonNode column : columns) workbookColumns.add(new StreamingWorkbook.Column(column.path("key").asText(), column.path("title").asText(), column.path("width").asInt(24)));
            AtomicLong count = new AtomicLong();
            StoredObject object = storage.upload(objectKey, ReportStorage.XLSX_CONTENT_TYPE, output -> count.set(StreamingWorkbook.write(
                output, reportName, parameters, workbookColumns, () -> {
                    ReportStorage.interrupted();
                    JsonNode row = mapper.readTree(parser);
                    if (row == null) return null;
                    validateRow(columns, row);
                    return mapper.convertValue(row, ROW_TYPE);
                })));
            return new Artifact(object, count.get());
        }
    }

    /** Concatenate compatible persisted inputs, opening only one source at a time. */
    public Artifact compose(List<String> sourceKeys, String objectKey) throws IOException {
        if (sourceKeys == null || sourceKeys.isEmpty()) throw new SourceFormatException("Не указаны промежуточные результаты для объединения.");
        AtomicLong count = new AtomicLong();
        StoredObject object = storage.upload(objectKey, ReportStorage.JSONL_CONTENT_TYPE, output -> {
            JsonNode expected = null;
            try (JsonGenerator json = mapper.getFactory().createGenerator(output)) {
                json.disable(JsonGenerator.Feature.AUTO_CLOSE_TARGET);
                for (String key : sourceKeys) {
                    ReportStorage.interrupted();
                    try (var source = storage.open(key); var parser = mapper.getFactory().createParser(new BufferedInputStream(source.body(), 64 * 1024))) {
                        JsonNode columns = readHeader(parser);
                        if (expected == null) { expected = columns; json.writeObject(Map.of("columns", columns)); json.writeRaw('\n'); }
                        else if (!expected.equals(columns)) throw new SourceFormatException("Столбцы промежуточных результатов несовместимы.");
                        JsonNode row;
                        while ((row = mapper.readTree(parser)) != null) {
                            ReportStorage.interrupted();
                            validateRow(columns, row);
                            json.writeTree(row); json.writeRaw('\n'); count.incrementAndGet();
                        }
                    }
                }
            }
        });
        return new Artifact(object, count.get());
    }

    private JsonNode readHeader(JsonParser parser) throws IOException {
        JsonNode header = mapper.readTree(parser);
        if (header == null || !header.isObject()) throw new SourceFormatException("Некорректный заголовок промежуточного результата.");
        JsonNode columns = header.path("columns");
        validateColumns(columns);
        return columns;
    }
    private static void validateColumns(JsonNode columns) throws SourceFormatException {
        if (!columns.isArray() || columns.isEmpty() || columns.size() > 16384) throw new SourceFormatException("Некорректное описание столбцов отчета.");
        Set<String> keys = new HashSet<>();
        for (JsonNode column : columns) {
            if (!column.isObject() || !column.path("key").isTextual() || column.path("key").asText().isBlank()
                || !keys.add(column.path("key").asText()) || !column.path("title").isTextual() || column.path("title").asText().isBlank()
                || !Set.of("date", "string", "number").contains(column.path("type").asText())
                || (column.has("width") && (!column.path("width").isNumber() || column.path("width").asDouble() <= 0))) {
                throw new SourceFormatException("Некорректное описание столбцов отчета.");
            }
        }
    }
    private static void validateRow(JsonNode columns, JsonNode row) throws SourceFormatException {
        if (!row.isObject() || row.size() != columns.size()) throw new SourceFormatException("Полученные данные не соответствуют формату отчета.");
        for (JsonNode column : columns) {
            JsonNode value = row.path(column.path("key").asText());
            boolean valid = switch (column.path("type").asText()) {
                case "date" -> value.isTextual() && validDate(value.asText());
                case "number" -> value.isNumber() && Double.isFinite(value.asDouble());
                case "string" -> value.isTextual();
                default -> false;
            };
            if (!valid) throw new SourceFormatException("Полученные данные не соответствуют формату отчета.");
        }
    }
    private static boolean validDate(String date) {
        if (!date.matches("\\d{4}-\\d{2}-\\d{2}")) return false;
        try { return LocalDate.parse(date).toString().equals(date); } catch (DateTimeParseException e) { return false; }
    }
    private static String stringParameter(Map<String, Object> parameters, String key) throws SourceFormatException {
        if (!(parameters.get(key) instanceof String value) || value.isBlank()) throw new SourceFormatException("Не указан параметр " + key + ".");
        return value;
    }
    private static String dateParameter(Map<String, Object> parameters, String key) throws SourceFormatException {
        String value = stringParameter(parameters, key);
        if (!validDate(value)) throw new SourceFormatException("Некорректная дата.");
        return value;
    }
}
