import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLogger } from "../server/src/logger.js";

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "redakt-log-"));
}

function readLog(directory) {
  const [file] = fs.readdirSync(directory).filter((name) => name.endsWith(".log"));
  return file ? fs.readFileSync(path.join(directory, file), "utf8") : "";
}

test("günlük dosyaya yazar ve seviyeyi metne katar", async () => {
  const directory = tempDirectory();
  const logger = createLogger({ directory, console: false });
  logger.info("servis basladi", { port: 8080 });
  logger.error("baglanti koptu", { code: "ETIMEOUT" });
  logger.close();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const contents = readLog(directory);
  assert.match(contents, /INFO\s+servis basladi port=8080/u);
  assert.match(contents, /ERROR\s+baglanti koptu code=ETIMEOUT/u);
});

test("eşiğin altındaki seviyeler yazılmaz", async () => {
  const directory = tempDirectory();
  const logger = createLogger({ directory, level: "warn", console: false });
  logger.info("gorunmemeli");
  logger.warn("gorunmeli");
  logger.close();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const contents = readLog(directory);
  assert.doesNotMatch(contents, /gorunmemeli/u);
  assert.match(contents, /gorunmeli/u);
});

test("belge içeriği taşıyabilecek alan adları reddedilir", async () => {
  const directory = tempDirectory();
  const logger = createLogger({ directory, console: false });
  logger.info("tarama bitti", { file: "sozlesme.docx", text: "Ahmet Yılmaz TCKN 10000000146", count: 3 });
  logger.close();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const contents = readLog(directory);
  assert.match(contents, /file=sozlesme\.docx/u);
  assert.match(contents, /count=3/u);
  assert.doesNotMatch(contents, /Ahmet Yılmaz/u, "belge içeriği log'a sızdı");
  assert.doesNotMatch(contents, /10000000146/u);
  assert.match(contents, /text=<REDDEDILDI/u);
});

test("uzun değerler kırpılır ve satır sonları tek satıra indirilir", async () => {
  const directory = tempDirectory();
  const logger = createLogger({ directory, console: false });
  logger.warn("uzun alan", { detail: `${"x".repeat(900)}\nikinci satir` });
  logger.close();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const contents = readLog(directory);
  assert.equal(contents.trimEnd().split("\n").length, 1, "log tek satırda kalmalı");
  assert.match(contents, /…/u);
  assert.ok(contents.length < 800, "değer kırpılmadı");
});

test("gün değişince yeni dosyaya geçer", async () => {
  const directory = tempDirectory();
  let current = new Date("2026-08-22T23:59:59");
  const logger = createLogger({ directory, console: false, now: () => current });
  logger.info("dun");
  current = new Date("2026-08-23T00:00:01");
  logger.info("bugun");
  logger.close();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const files = fs.readdirSync(directory).sort();
  assert.deepEqual(files, ["redakt-2026-08-22.log", "redakt-2026-08-23.log"]);
});

test("saklama süresini aşan dosyalar silinir", async () => {
  const directory = tempDirectory();
  const stale = path.join(directory, "redakt-2020-01-01.log");
  fs.writeFileSync(stale, "eski kayit\n");
  fs.utimesSync(stale, new Date("2020-01-01"), new Date("2020-01-01"));

  const logger = createLogger({ directory, console: false, retentionDays: 30 });
  logger.info("yeni kayit");
  logger.close();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(fs.existsSync(stale), false, "eski log dosyası silinmedi");
});

test("hata nesnesi okunabilir biçimde yazılır", async () => {
  const directory = tempDirectory();
  const logger = createLogger({ directory, console: false });
  logger.error("sql hatasi", { error: new TypeError("baglanti reddedildi") });
  logger.close();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.match(readLog(directory), /error=TypeError: baglanti reddedildi/u);
});

test("dosya boyut sınırı aşılınca aynı gün içinde yeni parçaya geçer", async () => {
  const directory = tempDirectory();
  const logger = createLogger({ directory, console: false, maxFileBytes: 400 });
  for (let index = 0; index < 20; index += 1) logger.info(`kayit ${index}`, { dolgu: "y".repeat(60) });
  logger.close();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const files = fs.readdirSync(directory).sort();
  assert.ok(files.length > 1, `parçalanma olmadı: ${files.join(", ")}`);
  assert.ok(
    files.some((name) => /^redakt-\d{4}-\d{2}-\d{2}\.1\.log$/u.test(name)),
    `sıralı parça üretilmedi: ${files.join(", ")}`,
  );
  // Hiçbir parça sınırı belirgin biçimde aşmamalı.
  for (const name of files) {
    assert.ok(fs.statSync(path.join(directory, name)).size <= 600, `${name} sınırı aştı`);
  }
});

test("toplam boyut sınırı aşılınca en eski dosyalar silinir", async () => {
  const directory = tempDirectory();
  // Yazılmakta olan dosya dışında iki eski parça bırak.
  for (const [name, age] of [["redakt-2026-08-01.log", 3], ["redakt-2026-08-02.log", 2]]) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, "z".repeat(5000));
    const when = new Date(Date.now() - age * 86_400_000);
    fs.utimesSync(file, when, when);
  }

  const logger = createLogger({ directory, console: false, retentionDays: 0, maxTotalBytes: 6000 });
  logger.info("yeni kayit");
  logger.close();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const kalan = fs.readdirSync(directory).sort();
  assert.equal(kalan.includes("redakt-2026-08-01.log"), false, "en eski dosya silinmedi");
  assert.ok(kalan.length >= 1, "hiç dosya kalmadı");
});

test("yazılmakta olan dosya boyut temizliğinde silinmez", async () => {
  const directory = tempDirectory();
  const logger = createLogger({ directory, console: false, retentionDays: 0, maxTotalBytes: 10 });
  logger.info("bu kayit kalmali");
  logger.close();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const files = fs.readdirSync(directory);
  assert.equal(files.length, 1);
  assert.match(fs.readFileSync(path.join(directory, files[0]), "utf8"), /bu kayit kalmali/u);
});
