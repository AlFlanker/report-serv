package dev.reportserv.config;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;

import javax.sql.DataSource;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Clock;

@Configuration
public class DatabaseConfiguration {
    @Bean
    public Clock clock() { return Clock.systemUTC(); }

    @Bean
    public HikariDataSource dataSource(Environment environment) {
        String value = environment.getProperty("DATABASE_URL");
        if (value == null || value.isBlank()) throw new IllegalStateException("DATABASE_URL is required");
        String schema = environment.getProperty("DATABASE_SCHEMA", "public");
        if (!schema.matches("[a-z_][a-z0-9_]{0,62}") || schema.startsWith("pg_") || schema.equals("information_schema")) {
            throw new IllegalArgumentException("DATABASE_SCHEMA must be a lowercase PostgreSQL identifier outside system schemas");
        }
        HikariConfig config = new HikariConfig();
        try {
            if (value.startsWith("jdbc:postgresql:")) config.setJdbcUrl(value);
            else {
                URI uri = URI.create(value);
                if (!uri.getScheme().matches("postgres(ql)?") || uri.getHost() == null) throw new IllegalArgumentException();
                String credentials = uri.getRawUserInfo();
                if (credentials != null) {
                    String[] parts = credentials.split(":", 2);
                    config.setUsername(URLDecoder.decode(parts[0], StandardCharsets.UTF_8));
                    if (parts.length == 2) config.setPassword(URLDecoder.decode(parts[1], StandardCharsets.UTF_8));
                }
                URI jdbc = new URI("postgresql", null, uri.getHost(), uri.getPort(), uri.getPath(), uri.getQuery(), null);
                config.setJdbcUrl("jdbc:" + jdbc);
            }
        } catch (Exception exception) { throw new IllegalArgumentException("DATABASE_URL must be a valid PostgreSQL connection URL"); }
        config.setMaximumPoolSize(10);
        config.setMinimumIdle(1);
        config.setConnectionTimeout(10_000);
        config.setValidationTimeout(3_000);
        config.setConnectionInitSql("SET search_path TO \"" + schema + "\"");
        config.addDataSourceProperty("ApplicationName", "report-serv-batch");
        config.addDataSourceProperty("connectTimeout", "10");
        config.addDataSourceProperty("socketTimeout", "120");
        config.addDataSourceProperty("tcpKeepAlive", "true");
        return new HikariDataSource(config);
    }

    @Bean
    public PlatformTransactionManager transactionManager(DataSource dataSource) {
        return new DataSourceTransactionManager(dataSource);
    }
}
