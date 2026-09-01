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

// Durum makinesi tarayıcı olmadan koşturulamıyor; bu üç arıza kaynakta
// bıraktıkları izle korunuyor. Hepsi kullanıcıyı çıkışsız bir ekranda bırakan
// ya da uyarıyı hiç ulaştırmayan yollardı.
test("çıkmaza götüren üç yol kaynakta kapalı", async () => {
  const main = await source("src/main.js");

  // İnceleme/bitiş/toplu sahnedeyken pencereye dosya bırakmak kuyruğu
  // değiştiriyor ama sahne değişmiyordu.
  assert.match(main, /async function returnToUploadStage\(\)/u, "sahneye dönüş yolu yok");
  const drop = main.slice(main.indexOf('window.addEventListener("drop"'));
  assert.match(drop.slice(0, 400), /returnToUploadStage\(\)\.then\(\(\) => selectFiles\(/u,
    "bırakılan dosya yükleme sahnesine dönmeden işleniyor");

  // Dosya DOĞRULAMASI sırasında iptal edildiğinde advanceQueue hiç koşmadığı
  // için bayrak açık kalıyor, bir sonraki başarılı tarama çöpe atılıyordu.
  assert.match(main, /state\.cancelledScan = Boolean\(state\.currentQueueItem\)/u,
    "iptal bayrağı koşulsuz kaldırılıyor");

  // Toplu taramada inceleme paneli hiç açılmadığı için uyarı kayboluyordu.
  assert.match(main, /state\.currentQueueItem\.scanWarning = nerWarning/u,
    "uyarı dosyaya iliştirilmiyor");
  assert.match(main, /showScanWarning\(item\.scanWarning \|\| null\)/u,
    "dosya açılırken uyarı gösterilmiyor");
});
