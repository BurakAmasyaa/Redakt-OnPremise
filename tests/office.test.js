import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as XLSX from "xlsx";
import { detectCustomRules } from "../src/custom-rules.js";
import { estimateXlsxRows, redactOffice, scanOffice, scanOfficeNamedEntities } from "../src/office.js";
import { countPlannedReplacements, createReplacementMap, replacementsForText } from "../src/pii.js";

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testFiles = path.join(root, "test-files");

async function embeddedImageFixture() {
  const canvas = createCanvas(720, 180);
  const context = canvas.getContext("2d");
  context.fillStyle = "#FAFAF7";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#0A0A0A";
  context.font = "42px sans-serif";
  context.fillText("E-posta: embedded@example.com", 28, 92);
  return canvas.encode("png");
}

function embeddedImageOcrOptions() {
  return {
    canvasFactory: createCanvas,
    imageFactory: (bytes) => loadImage(Buffer.from(bytes)),
    async ocrFactory() {
      return { async terminate() {} };
    },
    async recognizeOcr() {
      return {
        words: [{
          text: "embedded@example.com",
          confidence: 98,
          bbox: { x0: 205, y0: 48, x1: 680, y1: 102 },
        }],
      };
    },
  };
}

function embeddedImageRenderOptions() {
  return {
    canvasFactory: createCanvas,
    imageFactory: (bytes) => loadImage(Buffer.from(bytes)),
  };
}

async function assertImageBoxIsRedacted(bytes, mediaPath, bbox) {
  const zip = await JSZip.loadAsync(bytes);
  const imageBytes = await zip.file(mediaPath).async("uint8array");
  const image = await loadImage(Buffer.from(imageBytes));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const sampleX = Math.max(0, Math.floor(bbox.x0) - 2);
  const sampleY = Math.max(0, Math.floor(bbox.y0) - 2);
  const sampleWidth = Math.min(canvas.width - sampleX, Math.ceil(bbox.x1 - bbox.x0) + 4);
  const sampleHeight = Math.min(canvas.height - sampleY, Math.ceil(bbox.y1 - bbox.y0) + 4);
  const pixels = context.getImageData(sampleX, sampleY, sampleWidth, sampleHeight).data;
  let blackPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] < 40 && pixels[index + 1] < 40 && pixels[index + 2] < 40) blackPixels += 1;
  }
  const blackRatio = blackPixels / (pixels.length / 4);
  assert.ok(blackRatio > 0.55, `OCR kutusu medya görselinde siyaha boyanmalı (siyah oranı: ${blackRatio})`);
}

test("DOCX içindeki beş kategoriyi maskeler ve stil XML'ini korur", async () => {
  const bytes = await fs.readFile(path.join(testFiles, "redakt-test.docx"));
  const { context, findings } = await scanOffice(bytes, "redakt-test.docx");
  assert.deepEqual(new Set(findings.map((item) => item.category)), new Set(["email", "phone", "iban", "tc", "card"]));
  const originalStyles = await context.zip.file("word/styles.xml").async("uint8array");
  const result = await redactOffice(context, findings, findings.map((item) => item.id));
  const outputZip = await JSZip.loadAsync(result.bytes);
  const text = await outputZip.file("word/document.xml").async("string");
  const outputStyles = await outputZip.file("word/styles.xml").async("uint8array");
  for (const placeholder of ["[EMAIL_1]", "[TELEFON_1]", "[IBAN_1]", "[TC_KIMLIK_1]", "[KREDI_KARTI_1]"]) {
    assert.match(text, new RegExp(placeholder.replace(/[\[\]]/g, "\\$&")));
  }
  assert.deepEqual(outputStyles, originalStyles);
  await fs.mkdir(path.join(root, ".qa"), { recursive: true });
  await fs.writeFile(path.join(root, ".qa", "redakt-test-redacted.docx"), result.bytes);
});

test("XLSX içindeki beş kategoriyi maskeler; formül, birleşim ve temel stili korur", async () => {
  const bytes = await fs.readFile(path.join(testFiles, "redakt-test.xlsx"));
  const before = XLSX.read(bytes, { type: "buffer", cellStyles: true, cellFormula: true });
  const { context, findings } = await scanOffice(bytes, "redakt-test.xlsx");
  assert.deepEqual(new Set(findings.map((item) => item.category)), new Set(["email", "phone", "iban", "tc", "card"]));
  const result = await redactOffice(context, findings, findings.map((item) => item.id));
  const after = XLSX.read(result.bytes, { type: "array", cellStyles: true, cellFormula: true });
  const sheet = after.Sheets["Test Verileri"];
  assert.equal(sheet.B4.v, "[EMAIL_1]");
  assert.equal(sheet.B5.v, "[TELEFON_1]");
  assert.equal(sheet.B6.v, "[IBAN_1]");
  assert.equal(sheet.B7.v, "[TC_KIMLIK_1]");
  assert.equal(sheet.B8.v, "[KREDI_KARTI_1]");
  assert.equal(sheet.D4.f, before.Sheets["Test Verileri"].D4.f);
  assert.deepEqual(sheet["!merges"], before.Sheets["Test Verileri"]["!merges"]);
  assert.deepEqual(sheet.B4.s, before.Sheets["Test Verileri"].B4.s);
  await fs.mkdir(path.join(root, ".qa"), { recursive: true });
  await fs.writeFile(path.join(root, ".qa", "redakt-test-redacted.xlsx"), result.bytes);
});

test("DOCX word/media görsellerini OCR ile tarar ve seçili kutuyu medya dosyasında maskeler", async () => {
  const source = await fs.readFile(path.join(testFiles, "redakt-test.docx"));
  const zip = await JSZip.loadAsync(source);
  zip.file("word/media/embedded-ocr.png", await embeddedImageFixture());
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const options = embeddedImageRenderOptions();
  let redactedImages = 0;
  options.onProgress = () => { redactedImages += 1; };
  const { context, findings } = await scanOffice(bytes, "embedded.docx", options);
  const finding = findings.find((item) => item.value === "embedded@example.com");

  assert.equal(context.ocrImageCount, 1);
  assert.equal(finding?.locations[0].location.kind, "office-image");
  assert.equal(finding?.locations[0].location.mediaPath, "word/media/embedded-ocr.png");
  const imageMatches = replacementsForText(context.ocrImages[0].text, createReplacementMap(findings, [finding.id]), {
      unitIndex: context.ocrImages[0].unitIndex,
    });
  assert.equal(imageMatches.length, 1);
  const matchedRecord = context.ocrImages[0].records.find((record) =>
    imageMatches[0].start < record.end && imageMatches[0].end > record.start
  );
  assert.ok(matchedRecord);

  redactedImages = 0;
  const result = await redactOffice(context, findings, [finding.id], options);
  assert.equal(redactedImages, 1);
  await assertImageBoxIsRedacted(result.bytes, "word/media/embedded-ocr.png", matchedRecord.bbox);
});

test("XLSX xl/media görsellerini OCR ile tarar ve çalışma kitabı paketinde maskeler", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Görselli kayıt"]]), "Sayfa1");
  const workbookBytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const zip = await JSZip.loadAsync(workbookBytes);
  zip.file("xl/media/embedded-ocr.png", await embeddedImageFixture());
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const options = embeddedImageOcrOptions();
  const { context, findings } = await scanOffice(bytes, "embedded.xlsx", options);
  const finding = findings.find((item) => item.value === "embedded@example.com");

  assert.equal(context.ocrImageCount, 1);
  assert.equal(finding?.locations[0].location.mediaPath, "xl/media/embedded-ocr.png");

  const result = await redactOffice(context, findings, [finding.id], options);
  await assertImageBoxIsRedacted(result.bytes, "xl/media/embedded-ocr.png", context.ocrImages[0].records[0].bbox);
});

test("büyük XLSX satır sayısını tam parse öncesi hafif preflight ile ölçer", async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(Array.from({ length: 1201 }, (_, index) => [`Kayıt ${index + 1}`]));
  XLSX.utils.book_append_sheet(workbook, sheet, "Kişiler");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  assert.equal(await estimateXlsxRows(bytes), 1201);
});

test("DOCX custom kuralını farklı biçimli Word run'ları boyunca uygular", async () => {
  const bytes = await fs.readFile(path.join(testFiles, "redakt-test.docx"));
  const { context } = await scanOffice(bytes, "redakt-test.docx");
  const custom = detectCustomRules(context.units, [
    { find: "demo@example.com", replacement: "ÖZEL_EPOSTA" },
  ]);
  assert.equal(custom[0].count, 2);

  const result = await redactOffice(context, custom, custom.map((finding) => finding.id));
  const outputZip = await JSZip.loadAsync(result.bytes);
  const documentXml = await outputZip.file("word/document.xml").async("string");
  assert.equal((documentXml.match(/ÖZEL_EPOSTA/gu) || []).length, 2);
  assert.doesNotMatch(documentXml, /demo@example\.com/u);
});

test("XLSX custom kuralını çoklu sayfada uygular; formül ve sayısal hücreleri değiştirmez", async () => {
  const workbook = XLSX.utils.book_new();
  const first = XLSX.utils.aoa_to_sheet([
    ["Müşteri", "ABC Otomotiv"],
    ["Tutar", 12345678901],
    ["Formül", { t: "n", f: "B2+1", v: 12345678902 }],
  ]);
  const second = XLSX.utils.aoa_to_sheet([["Tekrar", "ABC Otomotiv"]]);
  XLSX.utils.book_append_sheet(workbook, first, "Birinci");
  XLSX.utils.book_append_sheet(workbook, second, "İkinci");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const { context } = await scanOffice(bytes, "coklu.xlsx");
  const custom = detectCustomRules(context.units, [
    { find: "ABC Otomotiv", replacement: "MÜŞTERİ" },
  ]);
  assert.equal(custom[0].count, 2);

  const result = await redactOffice(context, custom, custom.map((finding) => finding.id));
  const output = XLSX.read(result.bytes, { type: "array", cellFormula: true });
  assert.equal(output.Sheets.Birinci.B1.v, "MÜŞTERİ");
  assert.equal(output.Sheets.İkinci.B1.v, "MÜŞTERİ");
  assert.equal(output.Sheets.Birinci.B2.v, 12345678901);
  assert.equal(output.Sheets.Birinci.B3.f, "B2+1");
});

test("XLSX'te sayı olarak girilmiş T.C. kimlik ve kredi kartı değerlerini bulup maskeler; checksum'suz sayılara dokunmaz", async () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["T.C. Kimlik", 10000000146],
    ["Kredi Kartı", 4242424242424242],
    ["Tutar", 12345678901],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Sayfa1");
  const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const { context, findings } = await scanOffice(bytes, "sayisal.xlsx");
  assert.deepEqual(new Set(findings.map((finding) => finding.category)), new Set(["tc", "card"]));

  const result = await redactOffice(context, findings, findings.map((finding) => finding.id));
  const output = XLSX.read(result.bytes, { type: "array" });
  assert.equal(output.Sheets.Sayfa1.B1.v, "[TC_KIMLIK_1]");
  assert.equal(output.Sheets.Sayfa1.B2.v, "[KREDI_KARTI_1]");
  assert.equal(output.Sheets.Sayfa1.B3.v, 12345678901);
});

test("Faz 2 DOCX kişi, kurum ve konumları yerel NER modeliyle bulup maskeler", async () => {
  const bytes = await fs.readFile(path.join(testFiles, "redakt-faz2-ner-test.docx"));
  const { context, findings: exactFindings } = await scanOffice(bytes, "redakt-faz2-ner-test.docx");
  const nerFindings = await scanOfficeNamedEntities(context);
  const values = new Set(nerFindings.map((finding) => finding.value));

  for (const expected of [
    "Mustafa Kemal Atatürk",
    "Koç Holding",
    "Özlem Türeci",
    "Uğur Şahin",
    "BioNTech",
    "Güler Sabancı",
    "Sabancı Holding",
    "Türkiye İş Bankası",
    "Türk Hava Yolları",
    "Fazıl Say",
    "Borusan İstanbul Filarmoni Orkestrası",
    "Arda Güler",
    "Real Madrid",
    "Selçuk Bayraktar",
    "Baykar",
    "Deniz",
  ]) {
    assert.ok(values.has(expected), `NER bulgularında eksik: ${expected}`);
  }
  assert.ok(!values.has("Sabiha Gökçen"), "bilinen model kaçırması görünür kalmalı");
  assert.equal(nerFindings.find((finding) => finding.value === "Sabiha")?.category, "location");
  assert.equal(nerFindings.find((finding) => finding.value === "Mavi")?.category, "person");
  assert.ok(nerFindings.every((finding) => finding.confidence === "probable"));

  const findings = [...exactFindings, ...nerFindings];
  const originalStyles = await context.zip.file("word/styles.xml").async("uint8array");
  const result = await redactOffice(context, findings, findings.map((finding) => finding.id));
  const outputZip = await JSZip.loadAsync(result.bytes);
  const text = await outputZip.file("word/document.xml").async("string");
  const outputStyles = await outputZip.file("word/styles.xml").async("uint8array");

  assert.match(text, /\[KISI_1\]/u);
  assert.match(text, /\[KURUM_1\]/u);
  assert.match(text, /\[KONUM_\d+\] Gökçen/u);
  assert.doesNotMatch(text, /Mustafa Kemal Atatürk/u);
  assert.deepEqual(outputStyles, originalStyles);
  await fs.mkdir(path.join(root, ".qa"), { recursive: true });
  await fs.writeFile(path.join(root, ".qa", "redakt-faz2-ner-test-redacted.docx"), result.bytes);
});

async function createTextPdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const lines = [
    "Redakt PDF metin katmani testi",
    "E-posta: demo@example.com",
    "Telefon: +90 532 123 45 67",
    "IBAN: TR33 0006 1005 1978 6457 8413 26",
    "T.C. Kimlik: 10000000146",
    "Kart: 4242 4242 4242 4242",
  ];
  lines.forEach((line, index) => page.drawText(line, {
    x: 54,
    y: 770 - index * 34,
    size: index ? 14 : 20,
    font,
    color: rgb(0.04, 0.04, 0.04),
  }));
  return pdf.save();
}

test("metin katmanlı PDF içindeki beş kategoriyi bulur ve güvenli düzleştirilmiş çıktı üretir", async () => {
  const bytes = await createTextPdf();
  const { context, findings } = await scanOffice(bytes, "redakt-test.pdf");
  assert.equal(context.kind, "pdf");
  assert.deepEqual(new Set(findings.map((item) => item.category)), new Set(["email", "phone", "iban", "tc", "card"]));

  const result = await redactOffice(
    context,
    findings,
    findings.map((finding) => finding.id),
    { canvasFactory: createCanvas }
  );
  assert.equal(result.mimeType, "application/pdf");
  assert.equal(result.filename, "redakt-test_redakte.pdf");
  assert.equal((await PDFDocument.load(result.bytes)).getPageCount(), 1);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: result.bytes.slice(), isEvalSupported: false });
  const outputDocument = await loadingTask.promise;
  const outputText = (await (await outputDocument.getPage(1)).getTextContent()).items.map((item) => item.str).join(" ");
  await loadingTask.destroy();
  assert.doesNotMatch(outputText, /demo@example\.com|10000000146|4242 4242/u, "kaynak hassas metin katmanı kalmamalı");

  await fs.mkdir(path.join(root, ".qa"), { recursive: true });
  await fs.writeFile(path.join(root, ".qa", "redakt-test-source.pdf"), bytes);
  await fs.writeFile(path.join(root, ".qa", "redakt-test-redacted.pdf"), result.bytes);
});

test("görselden oluşan PDF'i yerel OCR ile okuyup güvenli şekilde maskeler", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 220]);
  const canvas = createCanvas(1200, 440);
  const context = canvas.getContext("2d");
  context.fillStyle = "#FAFAF7";
  context.fillRect(0, 0, 1200, 440);
  context.fillStyle = "#0A0A0A";
  context.font = "54px sans-serif";
  context.fillText("E-posta: demo@example.com", 54, 140);
  context.fillText("Müşteri: ABC Otomotiv", 54, 250);
  const image = await pdf.embedPng(await canvas.encode("png"));
  page.drawImage(image, { x: 0, y: 0, width: 600, height: 220 });
  const bytes = await pdf.save();

  const scanned = await scanOffice(bytes, "taranmis-belge.pdf", { canvasFactory: createCanvas, profile: "balanced" });
  assert.equal(scanned.context.ocrPageCount, 1);
  assert.ok(scanned.findings.some((finding) => finding.category === "email"));
  const result = await redactOffice(
    scanned.context,
    scanned.findings,
    scanned.findings.map((finding) => finding.id),
    { canvasFactory: createCanvas }
  );
  assert.equal((await PDFDocument.load(result.bytes)).getPageCount(), 1);
  await fs.mkdir(path.join(root, ".qa"), { recursive: true });
  await fs.writeFile(path.join(root, ".qa", "redakt-ocr-source.pdf"), bytes);
  await fs.writeFile(path.join(root, ".qa", "redakt-ocr-redacted.pdf"), result.bytes);
});

test("karma PDF'te yalnız taranmış sayfaları tek worker ile sırayla OCR'a gönderir", async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const textPage = pdf.addPage([600, 220]);
  textPage.drawText("Metin katmani: text@example.com", { x: 40, y: 150, size: 18, font });

  const canvas = createCanvas(600, 220);
  const canvasContext = canvas.getContext("2d");
  canvasContext.fillStyle = "#FAFAF7";
  canvasContext.fillRect(0, 0, 600, 220);
  canvasContext.fillStyle = "#0A0A0A";
  canvasContext.font = "28px sans-serif";
  canvasContext.fillText("Taranmis sayfa", 40, 100);
  const image = await pdf.embedPng(await canvas.encode("png"));
  for (let index = 0; index < 10; index += 1) {
    const page = pdf.addPage([600, 220]);
    page.drawImage(image, { x: 0, y: 0, width: 600, height: 220 });
  }

  let workersCreated = 0;
  let terminated = 0;
  let activeRecognitions = 0;
  let maxActiveRecognitions = 0;
  const scanned = await scanOffice(await pdf.save(), "karma.pdf", {
    canvasFactory: createCanvas,
    profile: "fast",
    async ocrFactory() {
      workersCreated += 1;
      return { async terminate() { terminated += 1; } };
    },
    async recognizeOcr(_worker, _image, { pageNumber }) {
      activeRecognitions += 1;
      maxActiveRecognitions = Math.max(maxActiveRecognitions, activeRecognitions);
      await Promise.resolve();
      activeRecognitions -= 1;
      return {
        words: [{
          text: `scan${pageNumber}@example.com`,
          confidence: 96,
          bbox: { x0: 40, y0: 60, x1: 260, y1: 100 },
        }],
      };
    },
  });

  assert.equal(scanned.context.pages.length, 11);
  assert.equal(scanned.context.pages[0].source, "text");
  assert.equal(scanned.context.ocrPageCount, 10);
  assert.equal(workersCreated, 1);
  assert.equal(terminated, 1);
  assert.equal(maxActiveRecognitions, 1);
  assert.equal(scanned.findings.find((finding) => finding.value === "text@example.com")?.count, 1);
});

// Varlık bulguları eskiden yalnızca modelin onları GÖRDÜĞÜ birime
// uygulanıyordu. XLSX her hücreyi ayrı birim olarak maskelediği için A1'de
// bulunan ad B3'te maskesiz kalıyor, sayım ise bütün hücreleri saydığından
// rapor "3 kullanım" derken çalışma kitabında 1 değişiklik oluyordu.
test("XLSX: bir hücrede bulunan ad bütün çalışma kitabında maskelenir", async () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Ad", "Melis Demir"],
    ["Onay", "Melis Demir onayladı"],
    ["Not", "melis demir ayrıca ekledi"],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Sayfa1");
  const { context } = await scanOffice(XLSX.write(book, { type: "array", bookType: "xlsx" }), "liste.xlsx");

  const finding = {
    id: "ner_1", source: "ner", category: "person", label: "Kişi adı", value: "Melis Demir",
    variants: ["Melis Demir"], normalized: "melis demir",
    placeholder: "[KISI_1]", replacementText: "[KISI_1]", confidence: "probable",
    // Model adı yalnızca tek bir hücrede gördü.
    count: 1, locations: [{ unitIndex: 0 }],
  };
  const beklenen = countPlannedReplacements(context.units, [finding]).get("ner_1");
  const bytes = await redactOffice(context, [finding], ["ner_1"]);
  const geri = XLSX.read(bytes.bytes, { type: "array" }).Sheets.Sayfa1;
  const hucreler = ["B1", "B2", "B3"].map((address) => String(geri[address]?.v ?? ""));
  const uygulanan = hucreler.filter((value) => value.includes("[KISI_1]")).length;

  assert.equal(uygulanan, 3, `ad maskelenmemiş hücre kaldı: ${JSON.stringify(hucreler)}`);
  assert.equal(uygulanan, beklenen, "rapor ile çalışma kitabı tutmuyor");
  assert.ok(!hucreler.join(" ").match(/melis/iu), "ad çalışma kitabında kaldı");
});
