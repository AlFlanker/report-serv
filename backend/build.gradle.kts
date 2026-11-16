import org.springframework.boot.gradle.tasks.bundling.BootJar
import org.gradle.api.tasks.wrapper.Wrapper

plugins {
    java
    id("org.springframework.boot") version "3.5.16"
}

group = "com.reportserv"
version = "1.0.0"
description = "Report Service"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}

repositories {
    mavenCentral()
}

dependencies {
    // Maven's parent dependencyManagement previously overrode versions from
    // transitive POMs. Enforce the same Boot BOM, including Mockito/Byte Buddy.
    implementation(enforcedPlatform("org.springframework.boot:spring-boot-dependencies:3.5.16"))
    implementation(platform("software.amazon.awssdk:bom:2.59.1"))
    implementation("org.springframework.boot:spring-boot-starter-web")
    implementation("org.springframework.boot:spring-boot-starter-batch")
    implementation("org.springframework.boot:spring-boot-starter-jdbc")
    implementation("org.springframework.boot:spring-boot-starter-validation")
    implementation("software.amazon.awssdk:s3")
    implementation("software.amazon.awssdk:apache-client")
    runtimeOnly("org.postgresql:postgresql")

    testImplementation("org.springframework.boot:spring-boot-starter-test")
    testImplementation("org.springframework.batch:spring-batch-test")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(25)
    options.encoding = "UTF-8"
    options.compilerArgs.add("-parameters")
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    maxParallelForks = 1
    maxHeapSize = "1g"
    systemProperty("user.timezone", "UTC")
    // These tests exercise PostgreSQL and S3 outside Gradle's input snapshot.
    outputs.upToDateWhen { false }
    outputs.cacheIf { false }
    testLogging {
        events("failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

springBoot {
    mainClass.set("dev.reportserv.ReportApplication")
}

tasks.named<BootJar>("bootJar") {
    archiveFileName.set("report-serv.jar")
}

tasks.jar {
    enabled = false
}

val dependencyConfigurations = listOf(
    "compileClasspath", "runtimeClasspath", "testCompileClasspath",
    "testRuntimeClasspath", "annotationProcessor", "testAnnotationProcessor"
).map { configurations.named(it) }

tasks.register("resolveDependencies") {
    group = "build setup"
    description = "Resolve application and test dependencies before copying sources into the Docker build."
    doLast {
        dependencyConfigurations.forEach { it.get().resolve() }
    }
}

tasks.wrapper {
    gradleVersion = "9.9.1"
    distributionType = Wrapper.DistributionType.BIN
    distributionSha256Sum = "d8a18a7a841dd5df825d35a685fad6f2d7f12ac0c280e57b67c27b4a520ba228"
    networkTimeout = 60_000
}
