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
