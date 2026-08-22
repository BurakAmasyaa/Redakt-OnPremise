import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { createBulkArchive } from "../src/bulk-export.js";

function queueItem(name, selectedFindingIds) {
  return {
    status: "done",
    file: { name, async arrayBuffer() { return new TextEncoder().encode(name).buffer; } },
    findings: [{ id: "exact_1" }, { id: "probable_1" }],
    selectedFindingIds,
  };
}

test("toplu dışa aktarma tamamlanan dosyaları sırayla ve mevcut seçimlerle ZIP'e koyar", async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const progress = [];
  const bytes = await createBulkArchive([
    queueItem("bir.docx", ["exact_1", "probable_1"]),
    queueItem("iki.docx", ["exact_1"]),
    { ...queueItem("hata.docx", []), status: "error" },
  ], {
    JSZip,
    async extractDocument(_bytes, filename) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(`extract:${filename}`);
      return { context: { filename } };
    },
    async applyDocumentChanges(context, _findings, selectedIds) {
      calls.push(`apply:${context.filename}:${selectedIds.join(",")}`);
      return { filename: "temiz.docx", bytes: new TextEncoder().encode(context.filename) };
    },
    async disposeDocument(context) {
      calls.push(`dispose:${context.filename}`);
      active -= 1;
    },
    onProgress(event) { progress.push(event); },
  });

  const archive = await JSZip.loadAsync(bytes);
  assert.deepEqual(Object.keys(archive.files), ["temiz.docx", "temiz_2.docx"]);
  assert.equal(await archive.file("temiz.docx").async("string"), "bir.docx");
  assert.equal(await archive.file("temiz_2.docx").async("string"), "iki.docx");
  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [
    "extract:bir.docx",
    "apply:bir.docx:exact_1,probable_1",
    "dispose:bir.docx",
    "extract:iki.docx",
    "apply:iki.docx:exact_1",
    "dispose:iki.docx",
  ]);
  assert.equal(progress.at(-1).phase, "archiving");
});
