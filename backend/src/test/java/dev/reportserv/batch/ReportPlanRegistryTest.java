package dev.reportserv.batch;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static dev.reportserv.batch.ReportPlanRegistry.Kind.*;
import static org.junit.jupiter.api.Assertions.*;

class ReportPlanRegistryTest {
    private static ReportPlanRegistry.Stage stage(String name, ReportPlanRegistry.Kind kind, String... inputs) {
        return new ReportPlanRegistry.Stage(name, name, kind, List.of(inputs), null);
    }
    private static ReportPlanRegistry registry(ReportPlanRegistry.Stage... stages) {
        return new ReportPlanRegistry(List.of(new ReportPlanRegistry.Plan(2, List.of(stages))));
    }

    @Test void publicationRequiresExactlyOneFinalRenderedExcel() {
        var extract = stage("extract", EXTRACT);
        var render = stage("render", RENDER, "extract");
        assertAll(
            () -> assertThrows(IllegalArgumentException.class, () -> registry(extract, stage("publish", PUBLISH, "extract"))),
            () -> assertThrows(IllegalArgumentException.class, () -> registry(extract, render, stage("early", PUBLISH, "render"), stage("publish", PUBLISH, "render"))),
            () -> assertThrows(IllegalArgumentException.class, () -> registry(extract, render, stage("bad", COMPOSE, "render"), stage("publish", PUBLISH, "render"))),
            () -> assertThrows(IllegalArgumentException.class, () -> registry(extract, render, stage("again", RENDER, "render"), stage("publish", PUBLISH, "again"))),
            () -> assertThrows(IllegalArgumentException.class, () -> registry(extract, stage("render", RENDER, "unknown"), stage("publish", PUBLISH, "render")))
        );
    }

    @Test void immutableVersionedPlanSupportsSeveralSourcesAndComposition() {
        var inputs = new ArrayList<>(List.of("first", "second"));
        var compose = new ReportPlanRegistry.Stage("compose", "Объединение", COMPOSE, inputs, null);
        inputs.clear();
        var stages = new ArrayList<>(List.of(
            new ReportPlanRegistry.Stage("first", "Источник 1", EXTRACT, List.of(), "operations"),
            new ReportPlanRegistry.Stage("second", "Источник 2", EXTRACT, List.of(), "payments"),
            compose, stage("render", RENDER, "compose"), stage("publish", PUBLISH, "render")
        ));
        var definitions = new ReportPlanRegistry(List.of(new ReportPlanRegistry.Plan(2, stages)));
        stages.clear();
        assertEquals(5, definitions.get(2).stages().size());
        assertEquals(List.of("first", "second"), definitions.get(2).stages().get(2).inputs());
        assertEquals("report-v2", definitions.get(2).jobName());
        assertFalse(definitions.supports(1));
    }
}
