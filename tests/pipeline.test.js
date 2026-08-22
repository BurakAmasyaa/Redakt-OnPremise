import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { applyDocumentChanges, documentAdapterFor, extractDocument } from "../src/pipeline.js";

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("ortak pipeline dosya türünü doğru adapter'a yönlendirir", () => {
  assert.equal(documentAdapterFor("belge.docx")?.id, "docx");
  assert.equal(documentAdapterFor("tablo.xlsx")?.id, "xlsx");
  assert.equal(documentAdapterFor("rapor.pdf")?.id, "pdf");
  assert.equal(documentAdapterFor("arsiv.zip"), null);
});

test("ortak pipeline DOCX extract ve apply akışını korur", async () => {
  const bytes = await fs.readFile(path.join(root, "test-files", "redakt-test.docx"));
  const { context, findings } = await extractDocument(bytes, "redakt-test.docx");
  assert.equal(context.adapterId, "docx");
  assert.ok(context.units.every((unit) => unit.location.kind === "docx"));
  assert.ok(findings.every((finding) => finding.source === "pattern" && finding.locations.length));
  const output = await applyDocumentChanges(context, findings, findings.map((finding) => finding.id));
  assert.equal(output.filename, "redakt-test_redakte.docx");
  assert.ok(output.bytes.length > 0);
});
