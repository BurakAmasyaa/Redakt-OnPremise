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
function resolveEsbuild() {
  const candidates = [
    path.join(projectRoot, "node_modules", ".bin", "esbuild"),
    path.join(projectRoot, "node_modules", ".pnpm", "node_modules", ".bin", "esbuild"),
    path.join(serverRoot, "node_modules", ".bin", "esbuild"),
  ];
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
function writeSupportFiles() {
  fs.mkdirSync(path.join(outputRoot, "config"), { recursive: true });
  // Paket düzeninde yollar app/ klasörüne göredir: web ve logs onun kardeşi.
  const example = fs.readFileSync(path.join(serverRoot, ".env.example"), "utf8")
    .replace("STATIC_ROOT=../dist", "STATIC_ROOT=../web")
    .replace("LOG_DIR=../logs", "LOG_DIR=../logs");
  fs.writeFileSync(path.join(outputRoot, "config", ".env.example"), example);

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
