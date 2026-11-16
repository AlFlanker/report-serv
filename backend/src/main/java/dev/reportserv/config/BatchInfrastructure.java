package dev.reportserv.config;

import org.springframework.batch.core.configuration.support.DefaultBatchConfiguration;
import org.springframework.context.annotation.Configuration;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Isolation;

import javax.sql.DataSource;

@Configuration
public class BatchInfrastructure extends DefaultBatchConfiguration {
    private final DataSource source;
    private final PlatformTransactionManager transactions;
    public BatchInfrastructure(DataSource source, PlatformTransactionManager transactions, SchemaOwner initializedSchema) {
        this.source = source; this.transactions = transactions;
    }
    @Override protected DataSource getDataSource() { return source; }
    @Override protected PlatformTransactionManager getTransactionManager() { return transactions; }
    @Override protected Isolation getIsolationLevelForCreate() { return Isolation.READ_COMMITTED; }
}
