package dev.reportserv.domain;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Component
public class ReportCatalog {
    public static final ZoneId MOSCOW = ZoneId.of("Europe/Moscow");
    private static final List<ReportDefinition> DEFINITIONS = List.of(
        new ReportDefinition("operations", "Свод по операциям за период", "Операции подразделения за выбранный период.", true, "period", false, 1),
        new ReportDefinition("turnovers", "Обороты по лицевому счету", "Поступления и выбытия по лицевому счету.", false, "period", true, 1),
        new ReportDefinition("obligations", "Исполнение бюджетных обязательств", "Принятые и исполненные обязательства.", false, "period", false, 1),
        new ReportDefinition("payments", "Реестр платежных документов", "Перечень документов с суммами и статусами.", false, "period", false, 1),
        new ReportDefinition("balances", "Остатки по лицевым счетам", "Остатки денежных средств на выбранную дату.", false, "date", false, 1),
        new ReportDefinition("reconciliation", "Сверка поступлений", "Сопоставление поступлений за период.", false, "period", false, 1)
    );
    private final int maxPeriodDays;
    private final int retentionDays;
    private final Clock clock;

    public ReportCatalog(@Value("${MAX_PERIOD_DAYS:31}") int maxPeriodDays,
                         @Value("${RETENTION_DAYS:7}") int retentionDays, Clock clock) {
        if (maxPeriodDays < 1 || maxPeriodDays > 365) throw new IllegalArgumentException("MAX_PERIOD_DAYS must be from 1 to 365");
        if (retentionDays < 1 || retentionDays > 365) throw new IllegalArgumentException("RETENTION_DAYS must be from 1 to 365");
        this.maxPeriodDays = maxPeriodDays;
        this.retentionDays = retentionDays;
        this.clock = clock;
    }

    public int maxPeriodDays() { return maxPeriodDays; }
    public int retentionDays() { return retentionDays; }
    public Instant now() { return clock.instant(); }
    public List<ReportDefinition> definitions() { return DEFINITIONS; }

    public ReportDefinition get(String id) {
        return DEFINITIONS.stream().filter(report -> report.id().equals(id)).findFirst()
            .orElseThrow(() -> new ApiException(400, "UNKNOWN_REPORT", "Выберите доступный отчет."));
    }

    public List<Map<String, String>> departments() {
        return List.of(Map.of("id", "6000", "name", "Центральное управление"),
            Map.of("id", "6001", "name", "Территориальное управление"));
    }

    public boolean inNightWindow(Instant instant) { return instant.atZone(MOSCOW).getHour() < 6; }

    public Map<String, String> nextWindow(Instant instant) {
        var date = instant.atZone(MOSCOW).toLocalDate();
        if (!inNightWindow(instant)) date = date.plusDays(1);
        return Map.of("start", date.atStartOfDay(MOSCOW).toInstant().toString(),
            "end", date.atTime(6, 0).atZone(MOSCOW).toInstant().toString());
    }

    public Map<String, Object> view() {
        return Map.of("reports", DEFINITIONS, "departments", departments(),
            "config", Map.of("maxPeriodDays", maxPeriodDays, "retentionDays", retentionDays,
                "timeZone", "Europe/Moscow", "nightStartHour", 0, "nightEndHour", 6),
            "serverTime", now().toString(), "nextNightWindow", nextWindow(now()));
    }

    public record ValidatedReport(ReportDefinition definition, Map<String, Object> parameters) { }

    public ValidatedReport validate(Map<String, Object> body) {
        if (body == null) throw new ApiException(400, "INVALID_REQUEST", "Некорректное задание.");
        if (!(body.get("reportId") instanceof String id)) throw new ApiException(400, "UNKNOWN_REPORT", "Выберите доступный отчет.");
        var definition = get(id);
        if (!(body.get("parameters") instanceof Map<?, ?> parameters)) {
            throw new ApiException(400, "INVALID_PARAMETERS", "Укажите параметры отчета.");
        }
        Map<String, String> errors = new LinkedHashMap<>();
        Map<String, Object> clean = new LinkedHashMap<>();
        var department = parameters.get("department");
        if (!(department instanceof String) || !List.of("6000", "6001").contains(department)) {
            errors.put("department", "Выберите подразделение из списка.");
        } else clean.put("department", department);
        if (definition.parameterType().equals("date")) {
            if (!isDate(parameters.get("asOfDate"))) errors.put("asOfDate", "Укажите корректную дату.");
            else clean.put("asOfDate", parameters.get("asOfDate"));
        } else {
            if (!isDate(parameters.get("startDate"))) errors.put("startDate", "Укажите корректную дату начала.");
            else clean.put("startDate", parameters.get("startDate"));
            if (!isDate(parameters.get("endDate"))) errors.put("endDate", "Укажите корректную дату окончания.");
            else clean.put("endDate", parameters.get("endDate"));
            if (!errors.containsKey("startDate") && !errors.containsKey("endDate")) {
                long days = ChronoUnit.DAYS.between(LocalDate.parse((String) clean.get("startDate")), LocalDate.parse((String) clean.get("endDate"))) + 1;
                if (days <= 0) errors.put("endDate", "Дата окончания должна быть не раньше даты начала.");
                else if (days > maxPeriodDays) errors.put("endDate", "Не более " + maxPeriodDays + " календарных дней включительно.");
            }
        }
        if (definition.requiresAccount()) {
            if (!(parameters.get("account") instanceof String account) || !account.matches("[0-9]{11}")) {
                errors.put("account", "Укажите лицевой счет из 11 цифр.");
            } else clean.put("account", parameters.get("account"));
        }
        if (!errors.isEmpty()) throw new ApiException(400, "INVALID_PARAMETERS", "Проверьте параметры отчета.", errors);
        return new ValidatedReport(definition, Map.copyOf(clean));
    }

    public static boolean isDate(Object value) {
        if (!(value instanceof String text) || !text.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) return false;
        try { return LocalDate.parse(text).toString().equals(text); }
        catch (RuntimeException ignored) { return false; }
    }
}
