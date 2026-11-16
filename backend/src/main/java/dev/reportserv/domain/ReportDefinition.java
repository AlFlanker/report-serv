package dev.reportserv.domain;

public record ReportDefinition(String id, String name, String description, boolean nightOnly,
                               String parameterType, boolean requiresAccount, int version) { }
