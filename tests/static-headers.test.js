import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStaticHandler } from "../server/src/static.js";

async function serveOnce(root, urlPath) {
  const handler = createStaticHandler(root);
  let captured = null;
  const response = {
    writeHead(status, headers) { captured = { status, headers }; return this; },
    end() {},
  };
  await handler({ url: urlPath, headers: {}, method: "HEAD" }, response);
  return captured;
}

// Yalnız belgeye konan COEP sahada üç alt sistemi birden düşürdü: belge
// yalıtımlı olunca tarayıcı HTTP'den yüklenen HER worker betiğinde de aynı
// başlığı arar; .js/.mjs yanıtları taşımayınca NER, pdf.js ve Tesseract
// worker'ları engellenir. Kural: COEP ya her yanıtta olur ya hiçbirinde —
// belge ile worker betiği asla ayrışamaz.
test("belge ve worker betiği aynı COEP kararını taşır", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "redakt-static-"));
  await fs.writeFile(path.join(root, "index.html"), "<!doctype html><title>t</title>");
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(path.join(root, "assets", "ner-worker-abc.js"), "self.onmessage = () => {};");
  await fs.writeFile(path.join(root, "assets", "pdf.worker.min-abc.mjs"), "export {};");

  const document = await serveOnce(root, "/index.html");
  const worker = await serveOnce(root, "/assets/ner-worker-abc.js");
  const moduleWorker = await serveOnce(root, "/assets/pdf.worker.min-abc.mjs");
  assert.equal(document.status, 200);
  for (const served of [worker, moduleWorker]) {
    assert.equal(served.status, 200);
    assert.equal(
      served.headers["Cross-Origin-Embedder-Policy"],
      document.headers["Cross-Origin-Embedder-Policy"],
      "belge ile worker betiği COEP'te ayrıştı; tarayıcı worker'ı engeller"
    );
  }
  // Varlıklar başka sayfaya gömülemez; bu tek başına hiçbir yüklemeyi kırmaz.
  assert.equal(worker.headers["Cross-Origin-Resource-Policy"], "same-origin");
  await fs.rm(root, { recursive: true, force: true });
});
