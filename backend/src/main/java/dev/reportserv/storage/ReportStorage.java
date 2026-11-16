package dev.reportserv.storage;

import java.io.ByteArrayInputStream;
import java.io.Closeable;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.net.URI;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Service;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.ResponseInputStream;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.apache.ApacheHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.*;

/** Streaming multipart upload. Only a bounded number of immutable part buffers exist. */
@Service
public class ReportStorage implements AutoCloseable {
    public static final String XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    public static final String JSONL_CONTENT_TYPE = "application/x-ndjson";
    private static final int MIB = 1024 * 1024;
    private final S3Client client;
    private final String bucket;
    private final String prefix;
    private final int partSize;
    private final int concurrency;
    private final ExecutorService executor;
    private final Object lifecycle = new Object();
    private final Set<Thread> producers = new HashSet<>();
    private boolean closing;

    @FunctionalInterface
    public interface IOConsumer<T> { void accept(T value) throws IOException; }
    public record StoredObject(String key, String bucket, long sizeBytes, String etag) {}
    public record Download(InputStream body, long contentLength, String contentType, String etag) implements Closeable {
        @Override public void close() throws IOException { body.close(); }
    }

    @Autowired
    public ReportStorage(Environment environment) {
        this(configureClient(environment), value(environment, "S3_BUCKET", "reports"),
            value(environment, "S3_PREFIX", "reports/"),
            integer(environment, "S3_PART_SIZE_MIB", 8, 5, 64) * MIB,
            integer(environment, "S3_UPLOAD_CONCURRENCY", 2, 1, 8));
    }

    public ReportStorage(S3Client client, String bucket, String prefix, int partSize, int concurrency) {
        if (bucket == null || bucket.isBlank()) throw new IllegalArgumentException("S3_BUCKET is required");
        if (prefix == null || prefix.startsWith("/") || prefix.contains("..")) throw new IllegalArgumentException("Invalid S3_PREFIX");
        if (partSize < 5 * MIB || partSize > 64 * MIB || concurrency < 1 || concurrency > 8) throw new IllegalArgumentException("Invalid S3 multipart configuration");
        this.client = client;
        this.bucket = bucket;
        this.prefix = prefix;
        this.partSize = partSize;
        this.concurrency = concurrency;
        this.executor = Executors.newFixedThreadPool(concurrency, Thread.ofPlatform().name("s3-part-", 0).daemon().factory());
    }

    private static S3Client configureClient(Environment env) {
        var builder = S3Client.builder().region(Region.of(value(env, "S3_REGION", "us-east-1")))
            .httpClientBuilder(ApacheHttpClient.builder().connectionTimeout(Duration.ofSeconds(10))
                .socketTimeout(Duration.ofSeconds(120)).connectionAcquisitionTimeout(Duration.ofSeconds(10)))
            .overrideConfiguration(c -> c.apiCallTimeout(Duration.ofMinutes(3)).apiCallAttemptTimeout(Duration.ofMinutes(2)));
        var endpoint = value(env, "S3_ENDPOINT", "");
        if (!endpoint.isBlank()) {
            var uri = URI.create(endpoint);
            if (!List.of("http", "https").contains(uri.getScheme())) throw new IllegalArgumentException("Invalid S3_ENDPOINT");
            builder.endpointOverride(uri);
        }
        var pathStyle = value(env, "S3_FORCE_PATH_STYLE", endpoint.isBlank() ? "false" : "true");
        if (!List.of("true", "false").contains(pathStyle)) throw new IllegalArgumentException("S3_FORCE_PATH_STYLE must be true or false");
        builder.serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(Boolean.parseBoolean(pathStyle)).build());
        var access = value(env, "S3_ACCESS_KEY_ID", "");
        var secret = value(env, "S3_SECRET_ACCESS_KEY", "");
        if (access.isBlank() != secret.isBlank()) throw new IllegalArgumentException("Both S3 credential variables must be supplied together");
        builder.credentialsProvider(access.isBlank() ? DefaultCredentialsProvider.create()
            : StaticCredentialsProvider.create(AwsBasicCredentials.create(access, secret)));
        return builder.build();
    }

    private static String value(Environment env, String name, String fallback) { return env.getProperty(name, fallback); }
    private static int integer(Environment env, String name, int fallback, int minimum, int maximum) {
        int result;
        try { result = Integer.parseInt(value(env, name, Integer.toString(fallback))); }
        catch (NumberFormatException e) { throw new IllegalArgumentException(name + " must be an integer"); }
        if (result < minimum || result > maximum) throw new IllegalArgumentException(name + " is outside the supported range");
        return result;
    }

    public String bucket() { return bucket; }
    public String prefix() { return prefix; }
    public void check() { client.headBucket(b -> b.bucket(bucket)); }
    public void delete(String key) { client.deleteObject(b -> b.bucket(bucket).key(key)); }

    public Download open(String key) {
        ResponseInputStream<GetObjectResponse> response = client.getObject(b -> b.bucket(bucket).key(key));
        // SDK close() can drain an unread object to reuse a connection. Aborting
        // instead ensures a disconnected HTTP caller stops S3 reads immediately.
        InputStream body = new FilterInputStream(response) {
            @Override public void close() { response.abort(); }
        };
        return new Download(body, response.response().contentLength(), response.response().contentType(), response.response().eTag());
    }

    public StoredObject upload(String key, String contentType, IOConsumer<OutputStream> producer) throws IOException {
        interrupted();
        synchronized (lifecycle) {
            if (closing) throw new IOException("S3 storage is closing");
            producers.add(Thread.currentThread());
        }
        try {
            var stream = new MultipartStream(key, contentType);
            try {
                producer.accept(stream);
                interrupted();
                return stream.finish();
            } catch (Exception error) {
                stream.abort(error);
                if (error instanceof IOException io) throw io;
                if (error instanceof RuntimeException runtime) throw runtime;
                throw new IOException(error);
            }
        } finally {
            synchronized (lifecycle) { producers.remove(Thread.currentThread()); lifecycle.notifyAll(); }
        }
    }

    public static void interrupted() throws InterruptedIOException {
        if (Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Report processing was interrupted");
    }

    @PreDestroy
    @Override public void close() {
        boolean interrupted = Thread.interrupted();
        synchronized (lifecycle) {
            closing = true;
            producers.forEach(Thread::interrupt);
            // Upload abort owns the final remote cleanup. Keep the client alive
            // until those producers have awaited all in-flight requests.
            while (!producers.isEmpty()) {
                try { lifecycle.wait(); } catch (InterruptedException e) { interrupted = true; }
            }
        }
        executor.shutdown();
        while (!executor.isTerminated()) {
            try { executor.awaitTermination(1, TimeUnit.SECONDS); } catch (InterruptedException e) { interrupted = true; }
        }
        client.close();
        if (interrupted) Thread.currentThread().interrupt();
    }

    private final class MultipartStream extends OutputStream {
        private final String key;
        private final String uploadId;
        private final ArrayDeque<Future<CompletedPart>> pending = new ArrayDeque<>();
        private final List<CompletedPart> parts = new ArrayList<>();
        private byte[] buffer;
        private int used;
        private int number;
        private long length;
        private boolean finished;
        private boolean committed;
        private Future<CompleteMultipartUploadResponse> completion;

        MultipartStream(String key, String contentType) {
            this.key = key;
            this.uploadId = client.createMultipartUpload(b -> b.bucket(bucket).key(key).contentType(contentType)).uploadId();
            this.buffer = new byte[partSize];
        }

        @Override public void write(int value) throws IOException {
            interrupted();
            if (finished) throw new IOException("Upload stream is closed");
            if (buffer == null) buffer = new byte[partSize];
            buffer[used++] = (byte) value; length++;
            if (used == partSize) sendPart();
        }
        @Override public void write(byte[] bytes, int offset, int count) throws IOException {
            if (offset < 0 || count < 0 || count > bytes.length - offset) throw new IndexOutOfBoundsException();
            if (finished) throw new IOException("Upload stream is closed");
            while (count > 0) {
                interrupted();
                if (buffer == null) buffer = new byte[partSize];
                int copied = Math.min(count, partSize - used);
                System.arraycopy(bytes, offset, buffer, used, copied);
                used += copied; offset += copied; count -= copied; length += copied;
                if (used == partSize) sendPart();
            }
        }

        // Producer close is intentionally not completion: a valid remote object
        // is published only after the producer itself returns successfully.
        @Override public void close() {}

        private void sendPart() throws IOException {
            interrupted();
            if (++number > 10000) throw new IOException("S3 multipart upload exceeds 10000 parts");
            final byte[] bytes = buffer;
            final int size = used;
            final int partNumber = number;
            buffer = null;
            used = 0;
            pending.add(executor.submit(() -> {
                var response = client.uploadPart(b -> b.bucket(bucket).key(key).uploadId(uploadId).partNumber(partNumber).contentLength((long) size),
                    RequestBody.fromContentProvider(() -> new ByteArrayInputStream(bytes, 0, size), size, "application/octet-stream"));
                return CompletedPart.builder().partNumber(partNumber).eTag(response.eTag())
                    .checksumCRC32(response.checksumCRC32()).checksumCRC32C(response.checksumCRC32C())
                    .checksumSHA1(response.checksumSHA1()).checksumSHA256(response.checksumSHA256())
                    .checksumCRC64NVME(response.checksumCRC64NVME()).build();
            }));
            if (pending.size() >= concurrency) collect();
        }

        private void collect() throws IOException {
            Future<CompletedPart> next = pending.peek();
            try { parts.add(next.get()); pending.remove(); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new InterruptedIOException("S3 upload interrupted"); }
            catch (ExecutionException e) { throw new IOException("S3 part upload failed", e.getCause()); }
        }

        StoredObject finish() throws IOException {
            if (used > 0 || number == 0) sendPart();
            while (!pending.isEmpty()) collect();
            interrupted();
            completion = executor.submit(() -> client.completeMultipartUpload(b -> b.bucket(bucket).key(key).uploadId(uploadId)
                .multipartUpload(CompletedMultipartUpload.builder().parts(parts).build())));
            try {
                var response = completion.get();
                committed = true;
                interrupted();
                finished = true;
                return new StoredObject(key, bucket, length, response.eTag());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new InterruptedIOException("S3 completion interrupted");
            } catch (ExecutionException e) { throw new IOException("S3 completion failed", e.getCause()); }
        }

        void abort(Exception original) {
            finished = true;
            buffer = null;
            boolean interrupted = Thread.interrupted();
            // Do not cancel futures or interrupt their sockets: wait for remote
            // writes to settle before aborting/deleting, avoiding late PUT races.
            for (Future<?> future : pending) interrupted |= awaitSettled(future);
            if (completion != null) {
                interrupted |= awaitSettled(completion);
                try { completion.get(); committed = true; }
                catch (Exception ignored) { /* Ambiguous remote failure: delete unique key below as well. */ }
            }
            try { client.abortMultipartUpload(b -> b.bucket(bucket).key(key).uploadId(uploadId)); }
            catch (Exception error) { if (!committed) original.addSuppressed(error); }
            if (completion != null) {
                try { delete(key); } catch (Exception error) { original.addSuppressed(error); }
            }
            if (interrupted) Thread.currentThread().interrupt();
        }

        private boolean awaitSettled(Future<?> future) {
            boolean interrupted = false;
            while (true) {
                try { future.get(); return interrupted; }
                catch (InterruptedException e) { interrupted = true; }
                catch (ExecutionException e) { return interrupted; }
            }
        }
    }
}
