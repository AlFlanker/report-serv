package dev.reportserv.pipeline;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import javax.xml.stream.XMLOutputFactory;
import javax.xml.stream.XMLStreamException;
import javax.xml.stream.XMLStreamWriter;

import dev.reportserv.storage.ReportStorage;

/** Incremental OOXML writer: inline strings, no workbook model or disk spool. */
public final class StreamingWorkbook {
    private static final String NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    private static final long MAX_ROWS = 1_048_575;
    public record Column(String key, String title, int width) {}
    @FunctionalInterface public interface RowSource { Map<String, Object> next() throws IOException; }

    private StreamingWorkbook() {}

    public static long write(OutputStream output, String reportName, Map<String, Object> parameters,
                             List<Column> columns, RowSource rows) throws IOException {
        if (columns.isEmpty() || columns.size() > 16_384) throw new IOException("Invalid Excel column count");
        try (var zip = new ZipOutputStream(new BufferedOutputStream(output, 64 * 1024), StandardCharsets.UTF_8)) {
            zip.setLevel(1);
            entry(zip, "[Content_Types].xml", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
                <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
                <Default Extension="xml" ContentType="application/xml"/>
                <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
                <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
                <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
                <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
                </Types>""");
            entry(zip, "_rels/.rels", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>""");
            entry(zip, "xl/workbook.xml", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="Параметры" sheetId="1" r:id="rId1"/><sheet name="Данные" sheetId="2" r:id="rId2"/></sheets></workbook>""");
            entry(zip, "xl/_rels/workbook.xml.rels", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>""");
            entry(zip, "xl/styles.xml", """
                <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
                <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1677D2"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>""");
            var metadataColumns = List.of(new Column("key", "Параметр", 28), new Column("value", "Значение", 72));
            XMLStreamWriter xml = sheet(zip, "xl/worksheets/sheet1.xml", metadataColumns, false);
            header(xml, metadataColumns);
            Object[][] metadata = {
                {"Отчет", reportName}, {"Подразделение", parameters.get("department")},
                {"Дата начала", parameters.get("startDate")}, {"Дата окончания", parameters.get("endDate")},
                {"На дату", parameters.get("asOfDate")}, {"Лицевой счет", parameters.get("account")},
                {"Источник", "Подготовленные демонстрационные ответы целевой системы"}
            };
            int row = 2;
            for (Object[] cells : metadata) row(xml, row++, List.of(cells[0], cells[1] == null ? "" : cells[1]), false);
            endSheet(xml, zip, 0);
            xml = sheet(zip, "xl/worksheets/sheet2.xml", columns, true);
            header(xml, columns);
            long count = 0;
            Map<String, Object> record;
            while ((record = rows.next()) != null) {
                ReportStorage.interrupted();
                if (count == MAX_ROWS) throw new IOException("Превышено максимальное число строк листа Excel.");
                Map<String, Object> current = record;
                row(xml, ++count + 1, columns.stream().map(c -> recordValue(current, c.key())).toList(), false);
            }
            endSheet(xml, zip, columns.size());
            return count;
        } catch (XMLStreamException e) { throw new IOException("Failed to write Excel XML", e); }
    }

    private static Object recordValue(Map<String, Object> record, String key) { return record.getOrDefault(key, ""); }
    private static void entry(ZipOutputStream zip, String name, String content) throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(content.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }
    private static XMLStreamWriter sheet(ZipOutputStream zip, String path, List<Column> columns, boolean freeze) throws IOException, XMLStreamException {
        zip.putNextEntry(new ZipEntry(path));
        XMLStreamWriter xml = XMLOutputFactory.newFactory().createXMLStreamWriter(zip, StandardCharsets.UTF_8.name());
        xml.writeStartDocument("UTF-8", "1.0");
        xml.writeStartElement("worksheet"); xml.writeDefaultNamespace(NS);
        if (freeze) {
            xml.writeStartElement("sheetViews"); xml.writeStartElement("sheetView"); xml.writeAttribute("workbookViewId", "0");
            xml.writeEmptyElement("pane"); xml.writeAttribute("ySplit", "1"); xml.writeAttribute("topLeftCell", "A2"); xml.writeAttribute("activePane", "bottomLeft"); xml.writeAttribute("state", "frozen");
            xml.writeEndElement(); xml.writeEndElement();
        }
        xml.writeStartElement("cols");
        for (int i = 0; i < columns.size(); i++) {
            xml.writeEmptyElement("col"); xml.writeAttribute("min", Integer.toString(i + 1)); xml.writeAttribute("max", Integer.toString(i + 1));
            xml.writeAttribute("width", Integer.toString(Math.clamp(columns.get(i).width(), 1, 255))); xml.writeAttribute("customWidth", "1");
        }
        xml.writeEndElement(); xml.writeStartElement("sheetData");
        return xml;
    }
    private static void header(XMLStreamWriter xml, List<Column> columns) throws XMLStreamException, IOException {
        row(xml, 1, columns.stream().map(Column::title).toList(), true);
    }
    private static void row(XMLStreamWriter xml, long number, List<?> values, boolean header) throws XMLStreamException, IOException {
        xml.writeStartElement("row"); xml.writeAttribute("r", Long.toString(number));
        for (int i = 0; i < values.size(); i++) {
            xml.writeStartElement("c"); xml.writeAttribute("r", columnName(i + 1) + number);
            if (header) xml.writeAttribute("s", "1");
            Object value = values.get(i);
            if (value instanceof Number numeric) {
                if (!Double.isFinite(numeric.doubleValue())) throw new IOException("Excel contains a non-finite number");
                xml.writeStartElement("v"); xml.writeCharacters(numeric instanceof BigDecimal decimal ? decimal.toPlainString() : numeric.toString()); xml.writeEndElement();
            } else if (value == null || value instanceof String) {
                String text = value == null ? "" : (String) value;
                if (text.length() > 32767) throw new IOException("Excel cell exceeds 32767 characters");
                xml.writeAttribute("t", "inlineStr"); xml.writeStartElement("is"); xml.writeStartElement("t"); xml.writeAttribute("xml", "http://www.w3.org/XML/1998/namespace", "space", "preserve");
                xml.writeCharacters(xmlText(text)); xml.writeEndElement(); xml.writeEndElement();
            } else throw new IOException("Excel cells must be strings or numbers");
            xml.writeEndElement();
        }
        xml.writeEndElement();
    }
    private static String xmlText(String text) {
        StringBuilder result = new StringBuilder(text.length());
        text.codePoints().forEach(c -> result.appendCodePoint(c == 9 || c == 10 || c == 13 || (c >= 32 && c <= 0xD7FF)
            || (c >= 0xE000 && c <= 0xFFFD) || (c >= 0x10000 && c <= 0x10FFFF) ? c : 0xFFFD));
        return result.toString();
    }
    private static String columnName(int number) {
        StringBuilder name = new StringBuilder(3);
        while (number > 0) { number--; name.append((char) ('A' + number % 26)); number /= 26; }
        return name.reverse().toString();
    }
    private static void endSheet(XMLStreamWriter xml, ZipOutputStream zip, int filterColumns) throws XMLStreamException, IOException {
        xml.writeEndElement();
        if (filterColumns > 0) { xml.writeEmptyElement("autoFilter"); xml.writeAttribute("ref", "A1:" + columnName(filterColumns) + "1"); }
        xml.writeEndElement(); xml.writeEndDocument(); xml.flush();
        zip.closeEntry();
    }
}
