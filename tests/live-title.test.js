import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DOCUMENT_TITLE, scanDocumentTitle } from "../src/live-title.js";

test("tarama başlığı ölçülemeyen ve yüzdeli ilerlemeyi açıkça gösterir", () => {
  assert.equal(scanDocumentTitle(), "Taranıyor · Redakt");
  assert.equal(scanDocumentTitle({ progress: 0.451, totalUnits: 100 }), "%45 · Redakt");
  assert.equal(scanDocumentTitle({ progress: 2, totalUnits: 100 }), "%100 · Redakt");
  assert.equal(DEFAULT_DOCUMENT_TITLE, "Redakt — Belgen paylaşılmaya hazır.");
});
