import assert from "node:assert/strict";
import test from "node:test";
import { mergeNerBatches, nerBatchDelayMs } from "../src/ner-batching.js";

test("yalnız büyük NER işlerinde inference grupları arasına kısa termal boşluk ekler", () => {
  assert.equal(nerBatchDelayMs(Array.from({ length: 49 }, () => "kısa kayıt")), 0);
  assert.equal(nerBatchDelayMs(Array.from({ length: 50 }, () => "kısa kayıt")), 2);
  assert.equal(nerBatchDelayMs(["x".repeat(20_000)]), 2);
});

test("ayrı batch bulgularını global konum ve placeholderlarla birleştirir", () => {
  const base = {
    source: "ner",
    category: "person",
    label: "Kişi adı",
    value: "Ayşe Yılmaz",
    originalText: "Ayşe Yılmaz",
    variants: ["Ayşe Yılmaz"],
    normalized: "ayşe yılmaz",
    count: 1,
    score: 0.92,
    confidence: "probable",
    locations: [{ unitIndex: 0, start: 0, end: 11 }],
  };
  const merged = mergeNerBatches([
    { offset: 0, findings: [base] },
    { offset: 150, findings: [{ ...base, score: 0.96 }] },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, 2);
  assert.equal(merged[0].score, 0.96);
  assert.equal(merged[0].placeholder, "[KISI_1]");
  assert.deepEqual(merged[0].locations.map(({ unitIndex }) => unitIndex), [0, 150]);
});
