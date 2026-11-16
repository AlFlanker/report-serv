package dev.reportserv.domain;

import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class ReportCatalogTest {
    private final ReportCatalog catalog = new ReportCatalog(31, 7,
        Clock.fixed(Instant.parse("2026-11-16T10:00:00Z"), ZoneOffset.UTC));

    private static Map<String, Object> period(String start, String end) {
        return Map.of("department", "6000", "startDate", start, "endDate", end);
    }

    @Test void validatesInclusivePeriodAndRejectsImpossibleDates() {
        var result = catalog.validate(Map.of("reportId", "operations", "parameters", period("2026-10-01", "2026-10-31")));
        assertEquals(1, result.definition().version());
        assertEquals("2026-10-31", result.parameters().get("endDate"));
        var tooLong = assertThrows(ApiException.class, () -> catalog.validate(Map.of("reportId", "operations", "parameters", period("2026-10-01", "2026-11-01"))));
        assertTrue(tooLong.fields().get("endDate").contains("31"));
        var impossible = assertThrows(ApiException.class, () -> catalog.validate(Map.of("reportId", "operations", "parameters", period("2026-02-30", "2026-03-01"))));
        assertTrue(impossible.fields().containsKey("startDate"));
        assertThrows(ApiException.class, () -> catalog.validate(Map.of("reportId", "operations", "parameters", period("2026-11-02", "2026-11-01"))));
    }

    @Test void requiresTypedAccountAndKnownDepartmentAndStripsExtraFields() {
        var parameters = new HashMap<>(period("2026-10-01", "2026-10-31"));
        parameters.put("account", "03210001234");
        parameters.put("arbitrarySql", "select * from secrets");
        var valid = catalog.validate(Map.of("reportId", "turnovers", "parameters", parameters));
        assertEquals("03210001234", valid.parameters().get("account"));
        assertFalse(valid.parameters().containsKey("arbitrarySql"));
        parameters.put("account", 3210001234L);
        assertThrows(ApiException.class, () -> catalog.validate(Map.of("reportId", "turnovers", "parameters", parameters)));
        parameters.put("department", "unavailable");
        var error = assertThrows(ApiException.class, () -> catalog.validate(Map.of("reportId", "operations", "parameters", parameters)));
        assertTrue(error.fields().containsKey("department"));
    }

    @Test void supportsSingleDateReportAndStrictDateParsing() {
        var valid = catalog.validate(Map.of("reportId", "balances", "parameters", Map.of("department", "6000", "asOfDate", "2026-11-15")));
        assertEquals(Map.of("department", "6000", "asOfDate", "2026-11-15"), valid.parameters());
        assertFalse(ReportCatalog.isDate("2026-2-01"));
        assertFalse(ReportCatalog.isDate("2026-02-29"));
        assertTrue(ReportCatalog.isDate("2024-02-29"));
        assertThrows(ApiException.class, () -> catalog.validate(Map.of("reportId", "unknown", "parameters", Map.of())));
    }

    @Test void calculatesMoscowWindowWithInclusiveStartExclusiveEnd() {
        assertFalse(catalog.inNightWindow(Instant.parse("2026-11-16T20:59:59Z")));
        assertTrue(catalog.inNightWindow(Instant.parse("2026-11-16T21:00:00Z")));
        assertTrue(catalog.inNightWindow(Instant.parse("2026-11-17T02:59:59Z")));
        assertFalse(catalog.inNightWindow(Instant.parse("2026-11-17T03:00:00Z")));
        assertEquals(Map.of("start", "2026-11-16T21:00:00Z", "end", "2026-11-17T03:00:00Z"), catalog.nextWindow(catalog.now()));
    }

    @Test void validatesConfiguredLimits() {
        assertThrows(IllegalArgumentException.class, () -> new ReportCatalog(0, 7, Clock.systemUTC()));
        assertThrows(IllegalArgumentException.class, () -> new ReportCatalog(31, 366, Clock.systemUTC()));
    }
}
