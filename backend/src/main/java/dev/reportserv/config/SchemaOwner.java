package dev.reportserv.config;

import dev.reportserv.ReportApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.Environment;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.datasource.init.ScriptUtils;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** One owner per schema, compatible with the preceding Node service's lock. */
@Component
public class SchemaOwner implements AutoCloseable {
    private final Connection owner;
    private final String schema;
    private final ConfigurableApplicationContext context;
    private final ScheduledExecutorService monitor = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "postgres-owner-monitor"); thread.setDaemon(true); return thread;
    });
    private volatile boolean closed;
    private volatile boolean healthy = true;

    public SchemaOwner(DataSource source, Environment environment, ConfigurableApplicationContext context) throws Exception {
        this.context = context;
        this.schema = environment.getProperty("DATABASE_SCHEMA", "public");
        owner = source.getConnection();
        try {
            try (PreparedStatement lock = owner.prepareStatement("SELECT pg_try_advisory_lock(hashtext(current_database()),hashtext(?))")) {
                lock.setString(1, "report-serv-owner:" + schema);
                try (ResultSet result = lock.executeQuery()) {
                    result.next();
                    if (!result.getBoolean(1)) throw new IllegalStateException("Another report service or migration owns this PostgreSQL schema");
                }
            }
            owner.setAutoCommit(false);
            try (var statement = owner.createStatement()) { statement.execute("CREATE SCHEMA IF NOT EXISTS \"" + schema + "\""); }
            ScriptUtils.executeSqlScript(owner, new ClassPathResource("db/report-schema.sql"));
            boolean batchExists;
            try (var statement = owner.prepareStatement("SELECT to_regclass(?) IS NOT NULL")) {
                statement.setString(1, schema + ".batch_job_instance");
                try (var result = statement.executeQuery()) { result.next(); batchExists = result.getBoolean(1); }
            }
            if (!batchExists) ScriptUtils.executeSqlScript(owner, new ClassPathResource("org/springframework/batch/core/schema-postgresql.sql"));
            owner.commit();
            owner.setAutoCommit(true);
            monitor.scheduleWithFixedDelay(this::checkOwnership, 2, 2, TimeUnit.SECONDS);
        } catch (Exception exception) {
            try { owner.rollback(); } catch (Exception ignored) { }
            owner.close(); monitor.shutdownNow(); throw exception;
        }
    }

    public boolean isHealthy() { return healthy && !closed; }

    public synchronized void verify() {
        if (closed || !healthy) throw new IllegalStateException("PostgreSQL queue ownership is unavailable");
        try (var statement = owner.createStatement()) {
            statement.setQueryTimeout(3);
            statement.execute("SELECT 1");
        } catch (Exception exception) {
            healthy = false;
            System.err.println("PostgreSQL queue ownership lost; stopping report service for recovery");
            Thread shutdown = new Thread(() -> {
                context.close();
                if (ReportApplication.standalone) System.exit(1);
            }, "postgres-owner-recovery");
            shutdown.setDaemon(false); shutdown.start(); monitor.shutdown();
            throw new IllegalStateException("PostgreSQL queue ownership lost", exception);
        }
    }

    private void checkOwnership() {
        if (closed) return;
        try { verify(); } catch (IllegalStateException ignored) { }
    }

    @Override
    public synchronized void close() throws Exception {
        if (closed) return;
        closed = true;
        monitor.shutdownNow();
        try (var unlock = owner.prepareStatement("SELECT pg_advisory_unlock(hashtext(current_database()),hashtext(?))")) {
            unlock.setString(1, "report-serv-owner:" + schema); unlock.execute();
        } catch (Exception ignored) { }
        owner.close();
    }
}
