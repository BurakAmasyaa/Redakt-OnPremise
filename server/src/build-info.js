import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Destek çağrısında ilk sorulan şey "hangi sürüm çalışıyor?" olur.
// Paket üretilirken build-info.json yazılır; geliştirmede dosya yoktur ve
// package.json'daki sürüme düşülür.
const here = path.dirname(fileURLToPath(import.meta.url));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

let cached = null;

export function buildInfo() {
  if (cached) return cached;

  const generated = readJson(path.join(here, "build-info.json"))
    || readJson(path.resolve(here, "..", "build-info.json"));

  if (generated) {
    cached = { ...generated, kaynak: "paket" };
    return cached;
  }

  const manifest = readJson(path.resolve(here, "..", "package.json"));
  cached = {
    surum: manifest?.version || "bilinmiyor",
    derleme: null,
    commit: null,
    kaynak: "geliştirme",
  };
  return cached;
}

export function versionLine() {
  const info = buildInfo();
  const parts = [`v${info.surum}`];
  if (info.commit) parts.push(info.commit);
  if (info.derleme) parts.push(info.derleme);
  return parts.join(" · ");
}
