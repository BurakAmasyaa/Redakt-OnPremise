import assert from "node:assert/strict";
import test from "node:test";
import { chunkText } from "../src/ner.js";
import { processingConfig, recommendedProfile } from "../src/profiles.js";

test("processing profile'ları gerçek NER ve OCR parametreleri taşır", () => {
  assert.ok(processingConfig("fast").ner.maxChunkLength > processingConfig("balanced").ner.maxChunkLength);
  assert.ok(processingConfig("thorough").ner.overlap > processingConfig("balanced").ner.overlap);
  assert.ok(processingConfig("fast").ner.maxChunkLength <= 900);
  assert.deepEqual([
    processingConfig("fast").ocr.dpi,
    processingConfig("balanced").ocr.dpi,
    processingConfig("thorough").ocr.dpi,
  ], [150, 200, 300]);
  assert.ok(chunkText("kelime ".repeat(400), 900, 180).length > chunkText("kelime ".repeat(400), 1600, 24).length);
});

test("cihaz önerisi seçim yapmadan kaba kaynak sinyallerini kullanır", () => {
  assert.equal(recommendedProfile({ hardwareConcurrency: 2, deviceMemory: 2 }), "fast");
  assert.equal(recommendedProfile({ hardwareConcurrency: 4, deviceMemory: 8 }), "balanced");
  assert.equal(recommendedProfile({ hardwareConcurrency: 12, deviceMemory: 16 }), "thorough");
  assert.equal(recommendedProfile({}), "balanced");
});
