package dev.reportserv.domain;

import java.time.Instant;
import java.util.Map;

/** Business identity survives Spring Batch execution attempts and application upgrades. */
public record ReportRecord(long id, String reportId, Map<String, Object> parameters,
                           String status, String stage, Instant createdAt, Instant startedAt,
                           Instant completedAt, Instant expiresAt, Map<String, Object> result,
                           Map<String, Object> error, int definitionVersion, Long batchInstanceId,
                           Long lastExecutionId) { }
