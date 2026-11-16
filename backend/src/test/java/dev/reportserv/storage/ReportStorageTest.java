package dev.reportserv.storage;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.io.IOException;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

import org.junit.jupiter.api.Test;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.*;

class ReportStorageTest {
    private static final int PART = 5 * 1024 * 1024;

    private S3Client client() {
        S3Client client = mock(S3Client.class);
        when(client.createMultipartUpload(org.mockito.ArgumentMatchers.<Consumer<CreateMultipartUploadRequest.Builder>>any()))
            .thenReturn(CreateMultipartUploadResponse.builder().uploadId("upload-1").build());
        when(client.completeMultipartUpload(org.mockito.ArgumentMatchers.<Consumer<CompleteMultipartUploadRequest.Builder>>any()))
            .thenReturn(CompleteMultipartUploadResponse.builder().eTag("complete").build());
        when(client.uploadPart(org.mockito.ArgumentMatchers.<Consumer<UploadPartRequest.Builder>>any(), any(RequestBody.class)))
            .thenReturn(UploadPartResponse.builder().eTag("part").build());
        return client;
    }

    @Test
    void stalledNetworkBackpressuresProducerAtConfiguredPartBudget() throws Exception {
        S3Client client = client();
        CountDownLatch partsStarted = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        AtomicLong remotelyRead = new AtomicLong();
        when(client.uploadPart(org.mockito.ArgumentMatchers.<Consumer<UploadPartRequest.Builder>>any(), any(RequestBody.class))).thenAnswer(call -> {
            partsStarted.countDown();
            assertTrue(release.await(10, TimeUnit.SECONDS));
            RequestBody body = call.getArgument(1);
            try (var input = body.contentStreamProvider().newStream()) { remotelyRead.addAndGet(input.transferTo(java.io.OutputStream.nullOutputStream())); }
            return UploadPartResponse.builder().eTag("part").build();
        });
        try (var storage = new ReportStorage(client, "bucket", "reports/", PART, 2); var worker = Executors.newSingleThreadExecutor()) {
            AtomicLong produced = new AtomicLong();
            Future<ReportStorage.StoredObject> result = worker.submit(() -> storage.upload("large.xlsx", ReportStorage.XLSX_CONTENT_TYPE, output -> {
                byte[] row = new byte[64 * 1024];
                while (produced.get() < 4L * PART) { output.write(row); produced.addAndGet(row.length); }
            }));
            try {
                assertTrue(partsStarted.await(5, TimeUnit.SECONDS));
                long stoppedAt = produced.get();
                assertTrue(stoppedAt <= 2L * PART, "producer cannot fill the whole report while S3 is stalled");
                Thread.sleep(100);
                assertEquals(stoppedAt, produced.get());
                assertFalse(result.isDone());
            } finally { release.countDown(); }
            assertEquals(4L * PART, result.get(10, TimeUnit.SECONDS).sizeBytes());
            assertEquals(4L * PART, remotelyRead.get());
            verify(client, times(4)).uploadPart(org.mockito.ArgumentMatchers.<Consumer<UploadPartRequest.Builder>>any(), any(RequestBody.class));
            verify(client, times(1)).completeMultipartUpload(org.mockito.ArgumentMatchers.<Consumer<CompleteMultipartUploadRequest.Builder>>any());
        }
    }

    @Test
    void interruptedCompletionWaitsForRemoteCommitBeforeDeletingObject() throws Exception {
        S3Client client = client();
        CountDownLatch completing = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicBoolean remotelyCommitted = new AtomicBoolean();
        AtomicBoolean deleted = new AtomicBoolean();
        when(client.completeMultipartUpload(org.mockito.ArgumentMatchers.<Consumer<CompleteMultipartUploadRequest.Builder>>any())).thenAnswer(call -> {
            completing.countDown(); assertTrue(release.await(10, TimeUnit.SECONDS)); remotelyCommitted.set(true);
            return CompleteMultipartUploadResponse.builder().eTag("late").build();
        });
        when(client.deleteObject(org.mockito.ArgumentMatchers.<Consumer<DeleteObjectRequest.Builder>>any())).thenAnswer(call -> {
            assertTrue(remotelyCommitted.get()); deleted.set(true); return DeleteObjectResponse.builder().build();
        });
        try (var storage = new ReportStorage(client, "bucket", "reports/", PART, 2)) {
            CompletableFuture<Throwable> error = new CompletableFuture<>();
            Thread producer = Thread.ofPlatform().start(() -> {
                try { storage.upload("attempt-unique.xlsx", ReportStorage.XLSX_CONTENT_TYPE, output -> output.write(new byte[1024])); error.complete(null); }
                catch (Throwable failure) { error.complete(failure); }
            });
            try {
                assertTrue(completing.await(5, TimeUnit.SECONDS)); producer.interrupt();
                Thread.sleep(100);
                assertFalse(error.isDone(), "interruption must await an already transmitted COMPLETE");
                assertFalse(deleted.get());
            } finally { release.countDown(); }
            assertInstanceOf(IOException.class, error.get(10, TimeUnit.SECONDS));
            assertTrue(deleted.get()); producer.join(1000);
        }
    }

    @Test
    void producerFailureAbortsMultipartAndNeverPublishes() throws Exception {
        S3Client client = client();
        try (var storage = new ReportStorage(client, "bucket", "reports/", PART, 2)) {
            IOException error = assertThrows(IOException.class, () -> storage.upload("failed.xlsx", ReportStorage.XLSX_CONTENT_TYPE, output -> {
                output.write(new byte[PART + 100]); throw new IOException("source failed");
            }));
            assertEquals("source failed", error.getMessage());
            verify(client).abortMultipartUpload(org.mockito.ArgumentMatchers.<Consumer<AbortMultipartUploadRequest.Builder>>any());
            verify(client, never()).completeMultipartUpload(org.mockito.ArgumentMatchers.<Consumer<CompleteMultipartUploadRequest.Builder>>any());
        }
    }
}
