import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { MAX_DOCUMENT_FILE_SIZE, validateDocumentBytes } from "../src/file-validation.js";

async function officeBytes(kind) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types />");
  zip.file(kind === "docx" ? "word/document.xml" : "xl/workbook.xml", "<document />");
  return zip.generateAsync({ type: "uint8array" });
}

test("Office türünü uzantıdan değil paket içeriğinden doğrular", async () => {
  const docx = await officeBytes("docx");
  const xlsx = await officeBytes("xlsx");
  assert.equal((await validateDocumentBytes(docx, "belge.docx")).kind, "docx");
  assert.equal((await validateDocumentBytes(xlsx, "tablo.xlsx")).kind, "xlsx");
  await assert.rejects(() => validateDocumentBytes(docx, "sahte.xlsx"), /eşleşmiyor/u);
});

test("PDF, PNG ve JPEG magic byte/trailer imzalarını doğrular", async () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\nörnek\n%%EOF\n");
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0,
    0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0,
  ]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
  assert.equal((await validateDocumentBytes(pdf, "belge.pdf")).kind, "pdf");
  assert.equal((await validateDocumentBytes(png, "gorsel.png")).kind, "png");
  assert.equal((await validateDocumentBytes(jpeg, "gorsel.jpg")).kind, "jpeg");
  await assert.rejects(() => validateDocumentBytes(new TextEncoder().encode("not a pdf"), "sahte.pdf"), /eşleşmiyor/u);
});

test("UTF-8 TXT kabul edilir; ikili içerik, uzantı hilesi ve boyut aşımı reddedilir", async () => {
  assert.equal((await validateDocumentBytes(new TextEncoder().encode("Türkçe metin"), "not.txt")).kind, "txt");
  await assert.rejects(() => validateDocumentBytes(new Uint8Array([0, 1, 2]), "ikili.txt"), /UTF-8/u);
  await assert.rejects(() => validateDocumentBytes(new Uint8Array([1]), "zararli.exe"), /Yalnızca/u);
  await assert.rejects(
    () => validateDocumentBytes(new Uint8Array(2), "buyuk.txt", { maximumSize: 1 }),
    /boyutu/u
  );
  assert.ok(MAX_DOCUMENT_FILE_SIZE >= 10 * 1024 * 1024);
});
