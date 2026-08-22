import assert from "node:assert/strict";
import test from "node:test";
import {
  formatModelDownloadBytes,
  createModelDownloadAggregator,
  isMeasurableModelDownload,
  isNerModelCached,
  NER_MODEL_DOWNLOAD_MESSAGE,
  NER_MODEL_TOTAL_BYTES,
} from "../src/model-cache.js";

const MODEL_BASE = "https://redaktt.test/models/redakt-turkish-ner/";

test("ilk kullanımda model indirme mesajını ve hareketli fallback'i tetikler", async () => {
  const requested = [];
  const cached = await isNerModelCached({
    modelBaseUrl: new URL(MODEL_BASE),
    cacheStorage: {
      async match(url) {
        requested.push(url);
        return undefined;
      },
    },
  });

  assert.equal(cached, false);
  assert.equal(requested.length, 3);
  assert.match(NER_MODEL_DOWNLOAD_MESSAGE, /bir kereye mahsus/u);
  assert.match(NER_MODEL_DOWNLOAD_MESSAGE, /~147MB/u);
});

test("tüm model ağırlıkları cache'deyse sonraki ziyareti indirme olarak işaretlemez", async () => {
  const cached = await isNerModelCached({
    modelBaseUrl: new URL(MODEL_BASE),
    cacheStorage: { async match() { return new Response(); } },
  });

  assert.equal(cached, true);
});

test("model byte ilerlemesini okunabilir MB olarak gösterir", () => {
  assert.equal(formatModelDownloadBytes(27.5 * 1024 * 1024, 55 * 1024 * 1024), "28 / 55 MB indirildi");
});

test("küçük model yapılandırma dosyalarını 0 / 0 MB ilerlemesi olarak göstermez", () => {
  assert.equal(isMeasurableModelDownload({ status: "progress", loaded: 373, total: 373 }), false);
  assert.equal(isMeasurableModelDownload({ status: "progress", loaded: 8 * 1024 * 1024, total: 55 * 1024 * 1024 }), true);
});

test("model indirme ilerlemesini bütün gerekli dosyalar üzerinde birleştirir", () => {
  const aggregate = createModelDownloadAggregator();
  const firstShard = aggregate.update({
    status: "progress",
    file: "onnx/model_q4.onnx_data",
    loaded: 49_154_048,
    total: 98_308_096,
  });
  const firstShardDone = aggregate.update({ status: "done", file: "onnx/model_q4.onnx_data" });
  const secondShard = aggregate.update({
    status: "progress",
    file: "onnx/model_q4.onnx_data_1",
    loaded: 27_575_966,
    total: 55_151_932,
  });

  assert.equal(firstShard.total, NER_MODEL_TOTAL_BYTES);
  assert.equal(firstShard.loaded, 49_154_048);
  assert.equal(firstShardDone.loaded, 98_308_096);
  assert.equal(secondShard.loaded, 125_884_062);
  assert.ok(secondShard.loaded / secondShard.total < 1);
  assert.equal(aggregate.complete().loaded, NER_MODEL_TOTAL_BYTES);
});

test("model hazır olmadan yuvarlanan ilerleme yüzde 100'e ulaşmaz", () => {
  const aggregate = createModelDownloadAggregator();
  for (const file of [
    "config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "onnx/model_q4.onnx",
    "onnx/model_q4.onnx_data",
    "onnx/model_q4.onnx_data_1",
  ]) aggregate.update({ status: "done", file });

  const beforeReady = aggregate.update({ status: "done", file: "onnx/model_q4.onnx_data_1" });
  assert.equal(Math.round((beforeReady.loaded / beforeReady.total) * 100), 99);
  const ready = aggregate.complete();
  assert.equal(Math.round((ready.loaded / ready.total) * 100), 100);
});
