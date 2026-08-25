import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath) {
  return fs.readFile(path.join(root, relativePath), "utf8");
}

test("model ve OCR varlıkları yalnızca yerel yollardan yüklenir", async () => {
  const [ner, ocr, html] = await Promise.all([
    source("src/ner.js"),
    source("src/ocr.js"),
    source("index.html"),
  ]);

  assert.match(ner, /env\.allowRemoteModels\s*=\s*false/u);
  assert.match(ner, /env\.localModelPath\s*=\s*`\$\{BASE_URL\}models\//u);
  assert.match(ocr, /ocr\/worker\.min\.js/u);
  assert.match(ocr, /ocr\/core/u);
  assert.match(ocr, /ocr\/lang/u);
  assert.match(html, /connect-src 'self' ws:\/\/127\.0\.0\.1:\* ws:\/\/localhost:\*/u);

  await Promise.all([
    "public/ocr/worker.min.js",
    "public/ocr/core/tesseract-core-lstm.wasm.js",
    "public/ocr/core/tesseract-core-simd-lstm.wasm.js",
    "public/ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js",
    "public/ocr/lang/tur.traineddata.gz",
    "public/ocr/lang/eng.traineddata.gz",
  ].map((relativePath) => fs.access(path.join(root, relativePath))));
});

// Belgeyi işleyen hiçbir modül ağa erişemez. Ağ erişimi yalnızca rule-source.js'de
// bulunur ve orada da tek yönlüdür: kural listesi okunur, hiçbir şey gönderilmez.
const DOCUMENT_MODULES = [
  "src/main.js",
  "src/pipeline.js",
  "src/office.js",
  "src/office-parts.js",
  "src/office-images.js",
  "src/pdf.js",
  "src/txt.js",
  "src/image.js",
  "src/ocr.js",
  "src/custom-rules.js",
  "src/pii.js",
  "src/ner.js",
  "src/ner-client.js",
  "src/ner-worker.js",
  "src/bulk-export.js",
];

test("belgeyi işleyen modüllerde ağ erişimi ve kalıcı depolama yoktur", async () => {
  for (const modulePath of DOCUMENT_MODULES) {
    const code = await source(modulePath);
    assert.doesNotMatch(code, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket)\s*\(/u, `${modulePath} ağ çağrısı içeriyor`);
    assert.doesNotMatch(code, /\b(localStorage|sessionStorage|indexedDB)\b/u, `${modulePath} kalıcı depolama kullanıyor`);
    assert.doesNotMatch(code, /console\.(log|info|warn|error)\s*\(/u, `${modulePath} konsola yazıyor`);
  }
});

test("ağ erişimi yalnızca rule-source.js içinde bulunur", async () => {
  const files = await fs.readdir(path.join(root, "src"));
  const offenders = [];
  for (const file of files.filter((name) => name.endsWith(".js"))) {
    if (file === "rule-source.js") continue;
    const code = await source(path.join("src", file));
    if (/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket)\s*\(/u.test(code)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `ağ erişimi rule-source.js dışına taşmış: ${offenders.join(", ")}`);
});

test("kural kaynağı yalnızca okur; sunucuya hiçbir içerik göndermez", async () => {
  const code = await source("src/rule-source.js");

  // Tek uç nokta ve tek yöntem: gövdesiz GET.
  assert.match(code, /method:\s*"GET"/u);
  assert.doesNotMatch(code, /\bbody\s*:/u, "istekte gövde var — veri gönderiliyor olabilir");
  assert.doesNotMatch(code, /method:\s*"(POST|PUT|PATCH|DELETE)"/u);

  // Adres sabit ve aynı origin; dış servise çıkış yok.
  assert.match(code, /const RULES_ENDPOINT = "\/api\/rules"/u);
  assert.doesNotMatch(code, /https?:\/\//u, "dış adrese istek var");

  // Kurallar bellekte kalır; ortak kullanılan cihazda müşteri listesi bırakmaz.
  assert.doesNotMatch(code, /\b(localStorage|sessionStorage|indexedDB)\b/u);
});
