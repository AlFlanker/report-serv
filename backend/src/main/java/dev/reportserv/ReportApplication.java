package dev.reportserv;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class ReportApplication {
    /** Embedded integration contexts close without terminating their test JVM. */
    public static volatile boolean standalone;

    public static void main(String[] args) {
        // Batch stores execution timestamps as LocalDateTime; use one explicit
        // zone so API conversion and restarts are independent of the host zone.
        java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone("UTC"));
        standalone = true;
        SpringApplication.run(ReportApplication.class, args);
    }
}
