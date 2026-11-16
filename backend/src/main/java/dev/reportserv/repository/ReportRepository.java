package dev.reportserv.repository;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.reportserv.domain.ApiException;
import dev.reportserv.domain.ReportCatalog;
import dev.reportserv.domain.ReportDefinition;
import dev.reportserv.domain.ReportRecord;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.core.namedparam.MapSqlParameterSource;
import org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Repository
public class ReportRepository {
    private static final String COLUMNS = "id,report_id,parameters,status,stage,created_at,started_at,completed_at,expires_at,result_metadata,error_json,definition_version,batch_instance_id,last_execution_id";
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() { };
    private final JdbcTemplate jdbc;
    private final NamedParameterJdbcTemplate named;
    private final ObjectMapper mapper;
    private final ReportCatalog catalog;
    private final RowMapper<ReportRecord> rowMapper = this::read;

    public ReportRepository(JdbcTemplate jdbc, ObjectMapper mapper, ReportCatalog catalog) {
        this.jdbc = jdbc;
        this.named = new NamedParameterJdbcTemplate(jdbc);
        this.mapper = mapper;
        this.catalog = catalog;
    }

    public JdbcTemplate jdbc() { return jdbc; }
    public ObjectMapper json() { return mapper; }

    public ReportRecord get(long id) {
        var rows = jdbc.query("SELECT " + COLUMNS + " FROM jobs WHERE id=?", rowMapper, id);
        if (rows.isEmpty()) throw new ApiException(404, "JOB_NOT_FOUND", "Задание не найдено.");
        return rows.getFirst();
    }

    public ReportRecord create(ReportDefinition definition, Map<String, Object> parameters, Instant now) {
        String stage = definition.nightOnly() && !catalog.inNightWindow(now) ? "Ожидает окна запуска" : "Ожидает запуска";
        return jdbc.queryForObject("INSERT INTO jobs(report_id,parameters,status,stage,created_at,definition_version) "
            + "VALUES(?,?::jsonb,'queued',?,?,?) RETURNING " + COLUMNS, rowMapper,
            definition.id(), encode(parameters), stage, Timestamp.from(now), definition.version());
    }

    public record JobPage(List<ReportRecord> items, long total, long allCount) { }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public JobPage list(Map<String, String> query) {
        String search = query.getOrDefault("search", "");
        String status = query.getOrDefault("status", "");
        String from = query.getOrDefault("createdFrom", "");
        String to = query.getOrDefault("createdTo", "");
        String sort = query.getOrDefault("sort", "desc");
        int page = positive(query.getOrDefault("page", "1"), 1_000_000);
        int pageSize = positive(query.getOrDefault("pageSize", "20"), 100);
        if (search.length() > 200 || !List.of("asc", "desc").contains(sort)
            || (!status.isEmpty() && !List.of("queued", "running", "completed", "failed").contains(status))
            || (!from.isEmpty() && !ReportCatalog.isDate(from)) || (!to.isEmpty() && !ReportCatalog.isDate(to))
            || (!from.isEmpty() && !to.isEmpty() && from.compareTo(to) > 0)) {
            throw invalidFilter();
        }
        var values = new MapSqlParameterSource();
        StringBuilder title = new StringBuilder("CASE report_id");
        int index = 0;
        for (var report : catalog.definitions()) {
            title.append(" WHEN :report").append(index).append(" THEN :title").append(index);
            values.addValue("report" + index, report.id()).addValue("title" + index, report.name());
            index++;
        }
        title.append(" ELSE report_id END");
        values.addValue("search", search.toLowerCase(java.util.Locale.forLanguageTag("ru")).replaceFirst("^№\\s*", ""));
        var filters = new ArrayList<String>();
        filters.add("strpos(lower((" + title + ") || ' ' || id::text),:search)>0");
        if (!status.isEmpty()) { filters.add("status=:status"); values.addValue("status", status); }
        if (!from.isEmpty()) {
            filters.add("created_at >= (CAST(:fromDate AS date)::timestamp AT TIME ZONE 'Europe/Moscow')");
            values.addValue("fromDate", from);
        }
        if (!to.isEmpty()) {
            filters.add("created_at < ((CAST(:toDate AS date) + 1)::timestamp AT TIME ZONE 'Europe/Moscow')");
            values.addValue("toDate", to);
        }
        String where = " FROM jobs WHERE " + String.join(" AND ", filters);
        long allCount = jdbc.queryForObject("SELECT count(*) FROM jobs", Long.class);
        long total = named.queryForObject("SELECT count(*)" + where, values, Long.class);
        values.addValue("limit", pageSize).addValue("offset", (long) (page - 1) * pageSize);
        var items = named.query("SELECT " + COLUMNS + where + " ORDER BY created_at " + sort + ",id " + sort
            + " LIMIT :limit OFFSET :offset", values, rowMapper);
        return new JobPage(items, total, allCount);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Map<String, Object> notifications() {
        var items = jdbc.query("SELECT * FROM notifications ORDER BY is_read ASC,id DESC LIMIT 100", (rs, row) -> {
            Map<String, Object> notification = new LinkedHashMap<>();
            notification.put("id", rs.getLong("id"));
            notification.put("jobId", rs.getLong("job_id"));
            notification.put("title", rs.getString("title"));
            notification.put("createdAt", rs.getTimestamp("created_at").toInstant().toString());
            notification.put("read", rs.getBoolean("is_read"));
            return notification;
        });
        long count = jdbc.queryForObject("SELECT count(*) FROM notifications WHERE NOT is_read", Long.class);
        return Map.of("items", items, "unreadCount", count);
    }

    public void markNotifications(List<Long> ids) {
        if (ids.isEmpty()) return;
        named.update("UPDATE notifications SET is_read=true WHERE id IN (:ids)", Map.of("ids", ids));
    }

    private ReportRecord read(ResultSet rs, int row) throws SQLException {
        return new ReportRecord(rs.getLong("id"), rs.getString("report_id"), decode(rs.getString("parameters")),
            rs.getString("status"), rs.getString("stage"), instant(rs, "created_at"), instant(rs, "started_at"),
            instant(rs, "completed_at"), instant(rs, "expires_at"), decode(rs.getString("result_metadata")),
            decode(rs.getString("error_json")), rs.getInt("definition_version"),
            rs.getObject("batch_instance_id", Long.class), rs.getObject("last_execution_id", Long.class));
    }

    private static Instant instant(ResultSet rs, String key) throws SQLException {
        Timestamp value = rs.getTimestamp(key);
        return value == null ? null : value.toInstant();
    }

    private Map<String, Object> decode(String value) {
        if (value == null) return null;
        try { return mapper.readValue(value, MAP_TYPE); }
        catch (Exception error) { throw new IllegalStateException("Stored report metadata is invalid", error); }
    }

    private String encode(Map<String, Object> value) {
        try { return mapper.writeValueAsString(value); }
        catch (Exception error) { throw new IllegalArgumentException("Report parameters cannot be encoded", error); }
    }

    private static int positive(String value, int maximum) {
        try {
            if (!value.matches("[0-9]+")) throw invalidFilter();
            int parsed = Integer.parseInt(value);
            if (parsed < 1 || parsed > maximum) throw invalidFilter();
            return parsed;
        } catch (NumberFormatException error) { throw invalidFilter(); }
    }

    private static ApiException invalidFilter() { return new ApiException(400, "INVALID_FILTER", "Некорректные параметры поиска."); }
}
