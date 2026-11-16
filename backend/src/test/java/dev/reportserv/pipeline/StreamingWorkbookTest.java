package dev.reportserv.pipeline;

import static org.junit.jupiter.api.Assertions.*;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.ZipInputStream;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;

import org.junit.jupiter.api.Test;
import org.w3c.dom.Document;

class StreamingWorkbookTest {
    @Test
    void workbookIsValidOoxmlWithTypedCellsAndOriginalParameterPositions() throws Exception {
        var bytes = new ByteArrayOutputStream();
        var rows = List.<Map<String, Object>>of(Map.of("account", "03210001234", "amount", 42680.25), Map.of("account", "=1+2 & <demo>\u0001", "amount", 0));
        var iterator = rows.iterator();
        long count = StreamingWorkbook.write(bytes, "Обороты", Map.of("department", "6000", "account", "03210001234"),
            List.of(new StreamingWorkbook.Column("account", "Лицевой счёт", 22), new StreamingWorkbook.Column("amount", "Сумма", 22)),
            () -> iterator.hasNext() ? iterator.next() : null);
        assertEquals(2, count);
        Map<String, byte[]> entries = new HashMap<>();
        try (var zip = new ZipInputStream(new ByteArrayInputStream(bytes.toByteArray()))) {
            java.util.zip.ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) entries.put(entry.getName(), zip.readAllBytes());
        }
        assertTrue(entries.containsKey("[Content_Types].xml"));
        assertFalse(entries.containsKey("xl/sharedStrings.xml"));
        for (var xml : entries.values()) parse(xml);
        Document metadata = parse(entries.get("xl/worksheets/sheet1.xml"));
        assertEquals("03210001234", cell(metadata, "B7").getTextContent());
        Document data = parse(entries.get("xl/worksheets/sheet2.xml"));
        assertEquals("inlineStr", cell(data, "A2").getAttribute("t"));
        assertEquals("03210001234", cell(data, "A2").getTextContent());
        assertEquals("42680.25", cell(data, "B2").getTextContent());
        assertEquals("=1+2 & <demo>\uFFFD", cell(data, "A3").getTextContent());
        assertEquals(0, data.getElementsByTagName("f").getLength());
    }

    @Test
    void blockedOutputStopsLazySourceAndInterruptionTerminatesGeneration() throws Exception {
        AtomicInteger produced = new AtomicInteger();
        CountDownLatch blocked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CompletableFuture<Throwable> failure = new CompletableFuture<>();
        OutputStream consumer = new OutputStream() {
            @Override public void write(int b) throws IOException { write(new byte[] {(byte) b}, 0, 1); }
            @Override public void write(byte[] b, int off, int len) throws IOException {
                blocked.countDown();
                try { release.await(); }
                catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new InterruptedIOException("stopped consumer"); }
            }
        };
        Thread producer = Thread.ofPlatform().start(() -> {
            Random random = new Random(123);
            try {
                StreamingWorkbook.write(consumer, "Большой отчет", Map.of("department", "6000"),
                    List.of(new StreamingWorkbook.Column("number", "Номер", 12), new StreamingWorkbook.Column("value", "Значение", 24)), () -> {
                        int row = produced.incrementAndGet();
                        if (row > 50_000) return null;
                        byte[] bytes = new byte[128]; random.nextBytes(bytes);
                        return Map.of("number", row, "value", HexFormat.of().formatHex(bytes));
                    });
                failure.complete(null);
            } catch (Throwable error) { failure.complete(error); }
        });
        try {
            assertTrue(blocked.await(5, TimeUnit.SECONDS));
            int stoppedAt = produced.get();
            assertTrue(stoppedAt < 5000, "a slow consumer must prevent reading all 50,000 source rows");
            Thread.sleep(100);
            assertEquals(stoppedAt, produced.get());
            producer.interrupt();
            assertInstanceOf(IOException.class, failure.get(5, TimeUnit.SECONDS));
        } finally { release.countDown(); producer.interrupt(); producer.join(1000); }
    }

    @Test
    void writesLargeLazyWorkbookWithoutRetainingRows() throws Exception {
        AtomicInteger generated = new AtomicInteger();
        AtomicInteger bytes = new AtomicInteger();
        Random random = new Random(456);
        OutputStream counter = new OutputStream() {
            @Override public void write(int b) { bytes.incrementAndGet(); }
            @Override public void write(byte[] b, int off, int len) { bytes.addAndGet(len); }
        };
        long count = StreamingWorkbook.write(counter, "Большой отчет", Map.of("department", "6000"),
            List.of(new StreamingWorkbook.Column("number", "Номер", 12), new StreamingWorkbook.Column("value", "Значение", 24)), () -> {
                int index = generated.incrementAndGet();
                if (index > 50_000) return null;
                byte[] value = new byte[128]; random.nextBytes(value);
                return Map.of("number", index, "value", HexFormat.of().formatHex(value));
            });
        assertEquals(50_000, count);
        assertTrue(bytes.get() > 5 * 1024 * 1024, "compressible size must actually exercise multipart-sized output");
    }

    private static Document parse(byte[] content) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
        return factory.newDocumentBuilder().parse(new ByteArrayInputStream(content));
    }
    private static org.w3c.dom.Element cell(Document document, String ref) {
        var cells = document.getElementsByTagName("c");
        for (int i = 0; i < cells.getLength(); i++) {
            var cell = (org.w3c.dom.Element) cells.item(i);
            if (ref.equals(cell.getAttribute("r"))) return cell;
        }
        throw new AssertionError("Missing cell " + ref);
    }
}
