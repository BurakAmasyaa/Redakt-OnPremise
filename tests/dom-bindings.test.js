import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (relativePath) => fs.readFile(path.join(root, relativePath), "utf8");

// main.js bütün DOM düğümlerini açılışta tek seferde toplar ve hiçbirini
// kontrol etmez. Listedeki bir kimlik HTML'de yoksa karşılığı `null` olur,
// hata da o düğüme ilk dokunulduğu anda — genellikle kullanıcı bir şeye
// tıkladığında — ortaya çıkar. Eşleşme burada, çalıştırmadan denetlenir.
test("main.js'in beklediği her düğüm index.html'de var", async () => {
  const [main, html] = await Promise.all([source("src/main.js"), source("index.html")]);

  const listStart = main.indexOf("const elements = Object.fromEntries(");
  assert.ok(listStart > 0, "elements listesi bulunamadı");
  const listEnd = main.indexOf("].map((id)", listStart);
  assert.ok(listEnd > listStart, "elements listesinin sonu bulunamadı");
  const wanted = [...main.slice(listStart, listEnd).matchAll(/"([a-z0-9-]+)"/gu)].map((match) => match[1]);
  assert.ok(wanted.length > 40, `beklenenden az kimlik okundu: ${wanted.length}`);

  const present = new Set([...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]));
  const missing = wanted.filter((id) => !present.has(id));
  assert.deepEqual(missing, [], `HTML'de karşılığı olmayan kimlikler: ${missing.join(", ")}`);
});

// Bu üçü rapor edilen arızaların doğrudan karşılığı; sessizce düşerlerse
// kullanıcı yine "model nerede" ve "klasörde ne oldu" sorularıyla kalır.
test("bulguların karşılığı olan arayüz parçaları yerinde", async () => {
  const html = await source("index.html");
  for (const id of ["model-storage-badge", "model-storage-detail", "model-storage-clear", "folder-hint"]) {
    assert.match(html, new RegExp(`id="${id}"`, "u"), `${id} arayüzden düşmüş`);
  }
});
