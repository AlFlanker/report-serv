package dev.reportserv.batch;

import dev.reportserv.domain.ApiException;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Published versions are immutable. Add a new version instead of changing v1. */
@Component
public class ReportPlanRegistry {
    public enum Kind { EXTRACT, COMPOSE, RENDER, PUBLISH }
    public record Stage(String name, String label, Kind kind, List<String> inputs, String sourceReportId) {
        public Stage { inputs = List.copyOf(inputs); }
    }
    public record Plan(int version, List<Stage> stages) {
        public Plan { stages = List.copyOf(stages); }
        public String jobName() { return "report-v" + version; }
    }
    private final Map<Integer, Plan> plans;

    public ReportPlanRegistry() {
        this(List.of(new Plan(1, List.of(
            new Stage("extract", "Получение данных", Kind.EXTRACT, List.of(), null),
            new Stage("render", "Формирование Excel", Kind.RENDER, List.of("extract"), null),
            new Stage("publish", "Публикация результата", Kind.PUBLISH, List.of("render"), null)
        ))));
    }

    /** Supports multi-source plans: named EXTRACT stages, COMPOSE, RENDER, PUBLISH. */
    public ReportPlanRegistry(List<Plan> definitions) {
        Map<Integer, Plan> result = new LinkedHashMap<>();
        for (Plan plan : definitions) {
            if (plan.version() < 1 || plan.stages().isEmpty() || result.containsKey(plan.version())) throw new IllegalArgumentException("Invalid report definition version");
            var names = new HashSet<String>();
            var kinds = new HashMap<String, Kind>();
            int publications = 0;
            for (Stage stage : plan.stages()) {
                if (!stage.name().matches("[a-z][a-zA-Z0-9_-]{0,79}") || names.contains(stage.name()) || !names.containsAll(stage.inputs())) throw new IllegalArgumentException("Invalid report stage graph");
                if (stage.kind() == Kind.EXTRACT && !stage.inputs().isEmpty()
                    || stage.kind() == Kind.COMPOSE && stage.inputs().isEmpty()
                    || (stage.kind() == Kind.RENDER || stage.kind() == Kind.PUBLISH) && stage.inputs().size() != 1) throw new IllegalArgumentException("Invalid report stage inputs");
                if (stage.kind() == Kind.PUBLISH) {
                    publications++;
                    if (kinds.get(stage.inputs().getFirst()) != Kind.RENDER) throw new IllegalArgumentException("Only a rendered Excel can be published");
                } else if (stage.kind() == Kind.COMPOSE || stage.kind() == Kind.RENDER) {
                    if (stage.inputs().stream().anyMatch(input -> kinds.get(input) != Kind.EXTRACT && kinds.get(input) != Kind.COMPOSE)) throw new IllegalArgumentException("Data stages require JSONL inputs");
                }
                if (stage.sourceReportId() != null && (stage.kind() != Kind.EXTRACT || stage.sourceReportId().isBlank())) throw new IllegalArgumentException("Only extraction stages specify source reports");
                names.add(stage.name());
                kinds.put(stage.name(), stage.kind());
            }
            if (publications != 1 || plan.stages().getLast().kind() != Kind.PUBLISH) throw new IllegalArgumentException("Report must end with exactly one publication");
            result.put(plan.version(), new Plan(plan.version(), List.copyOf(plan.stages())));
        }
        plans = Map.copyOf(result);
    }
    public List<Plan> all() { return List.copyOf(plans.values()); }
    public boolean supports(int version) { return plans.containsKey(version); }
    public Plan get(int version) {
        Plan plan = plans.get(version);
        if (plan == null) throw new ApiException(409, "DEFINITION_UNAVAILABLE", "Версия отчета больше недоступна. Создайте новое задание.");
        return plan;
    }
}
