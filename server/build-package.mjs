// Şirket VM'inde internet erişimi yok: paket, hedef makinede hiçbir şey
// indirmeden çalışmalı. Bu betik sunucu kodunu bağımlılıklarıyla birlikte
// tek bir dosyaya derler ve Windows için taşınabilir Node çalışma zamanını
// yanına koyar. Hedefte "npm install" çalıştırılmaz.
//
// Kullanım:
//   node build-package.mjs                 (node.exe zaten indirilmişse)
//   node build-package.mjs --fetch-node    (node.exe'yi indirir; internet gerekir)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverRoot, "..");
const outputRoot = path.join(projectRoot, "package");
const NODE_VERSION = process.env.NODE_WIN_VERSION || "v22.20.0";

function log(message) {
  process.stdout.write(`${message}\n`);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

// --- 1. Sunucuyu tek dosyaya derle -----------------------------------------
// npm ve pnpm esbuild'i farklı yerlere koyar; ikisini de destekle.
//
// Windows'ta node_modules\.bin altındaki dosya bir kabuk betiğidir (uzantısız
// esbuild + esbuild.cmd); execFile onu doğrudan çalıştıramaz ve paket üretimi
// daha ilk adımda düşer. Gerçek çalıştırılabilir, platform paketinin içindeki
// esbuild.exe'dir; Windows'ta önce o aranır.
function resolveEsbuild() {
  const roots = [
    path.join(projectRoot, "node_modules"),
    path.join(projectRoot, "node_modules", ".pnpm", "node_modules"),
    path.join(serverRoot, "node_modules"),
  ];
  const candidates = process.platform === "win32"
    ? roots.map((root) => path.join(root, "@esbuild", "win32-x64", "esbuild.exe"))
    : roots.map((root) => path.join(root, ".bin", "esbuild"));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`esbuild bulunamadı. Aranan yerler:\n  ${candidates.join("\n  ")}\nProje kökünde bağımlılıkları kurun.`);
  }
  return found;
}

const BUNDLE_TARGETS = [
  ["server.js", "redakt-server.mjs"],
  ["check.js", "redakt-check.mjs"],
  ["encrypt-password.js", "redakt-encrypt-password.mjs"],
];

// Destek çağrısında "hangi sürüm çalışıyor?" sorusunun cevabı buradan gelir.
function writeBuildInfo() {
  const manifest = JSON.parse(fs.readFileSync(path.join(serverRoot, "package.json"), "utf8"));
  let commit = null;
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch {
    // Git yoksa sürüm yine de yazılır.
  }
  const info = {
    surum: manifest.version,
    derleme: new Date().toISOString().slice(0, 19).replace("T", " "),
    commit,
  };
  fs.mkdirSync(path.join(outputRoot, "app"), { recursive: true });
  fs.writeFileSync(path.join(outputRoot, "app", "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

function bundleServer() {
  const esbuild = resolveEsbuild();
  fs.mkdirSync(path.join(outputRoot, "app"), { recursive: true });
  for (const [entry, output] of BUNDLE_TARGETS) {
    execFileSync(esbuild, [
      path.join(serverRoot, "src", entry),
      "--bundle",
      "--platform=node",
      "--target=node22",
      "--format=esm",
      "--legal-comments=none",
      // mssql/tedious içeride require() kullanıyor. ESM bundle'da require
      // tanımsız olduğu için createRequire ile geri kazandırılır.
      "--banner:js=import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      `--outfile=${path.join(outputRoot, "app", output)}`,
    ], { stdio: "inherit" });
  }
}

// --- 2. Uygulamanın statik çıktısını kopyala --------------------------------
function copyWebAssets() {
  const dist = path.join(projectRoot, "dist");
  if (!fs.existsSync(dist)) {
    throw new Error("dist/ bulunamadı. Önce proje kökünde 'npm run build' çalıştırın.");
  }
  fs.cpSync(dist, path.join(outputRoot, "web"), { recursive: true });
}

// --- 3. Windows için Node çalışma zamanı -----------------------------------
async function fetchWindowsNode() {
  const target = path.join(outputRoot, "node.exe");
  if (fs.existsSync(target)) {
    log(`node.exe zaten var, atlanıyor (${NODE_VERSION})`);
    return;
  }
  const url = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`;
  log(`Windows Node indiriliyor: ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`node.exe indirilemedi: HTTP ${response.status}`);
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  log(`node.exe yazıldı (${(fs.statSync(target).size / 1048576).toFixed(0)} MB)`);
}

// --- 4. Yapılandırma ve betikler -------------------------------------------
// Pakette sunucu <kok>\app\redakt-server.mjs olarak çalışır ve yolları çözerken
// kullandığı kök bir üstü, yani paketin kendisidir: web, logs ve config onun
// altındadır. Geliştirmedeki "../" ile başlayan yollar pakette bir seviye
// dışarıyı gösterir; 1.0.1 kurulumunda .env bu yüzden elle düzeltilmişti.
const PACKAGE_ENV_PATHS = [
  ["STATIC_ROOT=../dist", "STATIC_ROOT=web"],
  ["LOG_DIR=../logs", "LOG_DIR=logs"],
  ["# Yollar server/ klasörüne görelidir.", "# Yollar paket köküne görelidir."],
  ["#HTTPS_CERT=../config/redakt.crt", "#HTTPS_CERT=config/redakt.crt"],
  ["#HTTPS_KEY=../config/redakt.key", "#HTTPS_KEY=config/redakt.key"],
  ["#HTTPS_CA=../config/kurum-ca.crt", "#HTTPS_CA=config/kurum-ca.crt"],
];

function packageEnvExample() {
  let example = fs.readFileSync(path.join(serverRoot, ".env.example"), "utf8");
  for (const [from, to] of PACKAGE_ENV_PATHS) {
    // Sessizce atlanırsa paket yanlış yolla çıkar ve hata kurulumda görülür.
    if (!example.includes(from)) {
      throw new Error(`.env.example içinde beklenen satır yok: "${from}". Paket yolları PACKAGE_ENV_PATHS içinde güncellenmeli.`);
    }
    example = example.replace(from, to);
  }
  return example;
}

// IIS ters proxy + Windows kimlik doğrulama şablonu pakete girer: erişim
// kontrolü (AUTH_MODE=proxy) bu iki dosya olmadan kurulamıyor, kurulumu yapan
// kişi de bunları elle yazmak zorunda kalıyordu.
function copyIisTemplates() {
  const source = path.join(projectRoot, "deploy", "iis");
  if (!fs.existsSync(source)) {
    throw new Error(`IIS şablonları bulunamadı: ${source}`);
  }
  fs.cpSync(source, path.join(outputRoot, "iis"), { recursive: true });
}

function writeSupportFiles() {
  fs.mkdirSync(path.join(outputRoot, "config"), { recursive: true });
  fs.writeFileSync(path.join(outputRoot, "config", ".env.example"), packageEnvExample());
  copyIisTemplates();

  fs.writeFileSync(path.join(outputRoot, "redakt-check.cmd"),
    "@echo off\r\n" +
    "rem Kurulum dogrulama: ag, port, TLS, SQL baglantisi ve kural tablosu\r\n" +
    "\"%~dp0node.exe\" \"%~dp0app\\redakt-check.mjs\" %*\r\n" +
    "pause\r\n");

  fs.writeFileSync(path.join(outputRoot, "redakt-encrypt-password.cmd"),
    "@echo off\r\n" +
    "rem SQL parolasini DPAPI ile sifreler. Servis hesabiyla calistirin.\r\n" +
    "\"%~dp0node.exe\" \"%~dp0app\\redakt-encrypt-password.mjs\"\r\n" +
    "pause\r\n");

  fs.writeFileSync(path.join(outputRoot, "redakt-start.cmd"),
    "@echo off\r\n" +
    "rem Servisi on planda calistirir (sorun giderme icin).\r\n" +
    "\"%~dp0node.exe\" \"%~dp0app\\redakt-server.mjs\"\r\n");

  fs.copyFileSync(path.join(serverRoot, "scripts", "kurulum.ps1"), path.join(outputRoot, "kurulum.ps1"));
  fs.copyFileSync(path.join(serverRoot, "scripts", "KURULUM.md"), path.join(outputRoot, "KURULUM.md"));
}

// --- Çalıştır ---------------------------------------------------------------
const shouldFetchNode = process.argv.includes("--fetch-node");

log("Redakt On-Premise paketi hazırlanıyor…\n");
rmrf(path.join(outputRoot, "app"));
rmrf(path.join(outputRoot, "web"));
rmrf(path.join(outputRoot, "iis"));

log("1/4 · Sunucu kodu derleniyor");
bundleServer();
const info = writeBuildInfo();
log(`  sürüm: v${info.surum}${info.commit ? ` · ${info.commit}` : ""} · ${info.derleme}`);

log("2/4 · Web varlıkları kopyalanıyor");
copyWebAssets();

log("3/4 · Windows çalışma zamanı");
if (shouldFetchNode) await fetchWindowsNode();
else log("  (--fetch-node verilmedi, atlandı)");

log("4/4 · Yapılandırma ve betikler");
writeSupportFiles();

function directorySize(target) {
  let total = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
}

log(`\nPaket hazır: ${outputRoot}`);
log(`Toplam boyut: ${(directorySize(outputRoot) / 1048576).toFixed(0)} MB`);
