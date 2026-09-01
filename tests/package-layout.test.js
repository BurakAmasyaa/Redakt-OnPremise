import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { envFileCandidates } from "../server/src/config.js";

// Bu dosyadaki testler kurulum paketinin düzenini korur. Buradaki hatalar
// geliştirmede hiç görünmez, yalnızca sunucuda kurulum sırasında ortaya çıkar;
// 1.0.1 kurulumunda dört ayrı dosya elle yamanmıştı.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverRoot = path.join(root, "server");

test("paket düzenindeki config/.env aday listesinde", () => {
  const previous = process.env.REDAKT_ENV_FILE;
  delete process.env.REDAKT_ENV_FILE;
  try {
    const relatives = envFileCandidates().map((candidate) => path.relative(serverRoot, candidate));
    // Pakette sunucu <kok>/app/ altından çalışır: serverRoot paketin kökü olur
    // ve yapılandırma <kok>/config/.env'dir.
    assert.ok(relatives.includes(path.join("config", ".env")), relatives.join(", "));
    assert.ok(relatives.includes(".env"), relatives.join(", "));
  } finally {
    if (previous !== undefined) process.env.REDAKT_ENV_FILE = previous;
  }
});

test("sürüm iki manifest'te de aynı", () => {
  // /api/health sürümü server/package.json'dan okur; ikisi ayrışırsa kurulumda
  // hangi sürümün çalıştığı yanlış raporlanır.
  const app = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const server = JSON.parse(fs.readFileSync(path.join(serverRoot, "package.json"), "utf8"));
  assert.equal(server.version, app.version);
});

test("paketlenen .env.example paket köküne göre yol taşır", () => {
  const source = fs.readFileSync(path.join(serverRoot, "build-package.mjs"), "utf8");
  const block = source.match(/const PACKAGE_ENV_PATHS = \[(.*?)\];/su);
  assert.ok(block, "PACKAGE_ENV_PATHS bulunamadı");

  let example = fs.readFileSync(path.join(serverRoot, ".env.example"), "utf8");
  for (const [, from, to] of block[1].matchAll(/\["([^"]+)", "([^"]+)"\]/gu)) {
    assert.ok(example.includes(from), `.env.example içinde yok: ${from}`);
    example = example.replace(from, to);
  }

  assert.match(example, /^STATIC_ROOT=web$/mu);
  assert.match(example, /^LOG_DIR=logs$/mu);
  // Pakette "../" bir seviye paket dışını gösterir; hiçbir yol öyle kalmamalı.
  assert.doesNotMatch(example, /^[A-Z_]+=\.\.[\\/]/mu);
});

test("IIS erişim kontrolü şablonu pakete girecek hâlde duruyor", () => {
  const iis = path.join(root, "deploy", "iis");
  const webConfig = fs.readFileSync(path.join(iis, "web.config"), "utf8");
  assert.ok(fs.existsSync(path.join(iis, "App_Code", "HeaderInjectorModule.cs")));
  assert.match(fs.readFileSync(path.join(serverRoot, "build-package.mjs"), "utf8"), /"deploy", "iis"/u);

  // IIS, yorum içinde ardışık tire gördüğünde dosyayı geçersiz XML sayıp 500 verir.
  for (const comment of webConfig.matchAll(/<!--(.*?)-->/gsu)) {
    assert.doesNotMatch(comment[1], /--/u, "web.config yorumunda ardışık tire var");
  }

  assert.match(webConfig, /HeaderInjectorModule/u);
  // {LOGON_USER} kural çalıştığında boştur; kimlik başlığı modülle yazılır.
  assert.doesNotMatch(webConfig, /LOGON_USER" *\/>|value="\{LOGON_USER\}"/u);
});
