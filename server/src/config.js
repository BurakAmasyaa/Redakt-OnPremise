import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePassword } from "./secret.js";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Geliştirmede server/.env, kurulum paketinde ise app/ yanındaki config/.env
// kullanılır. REDAKT_ENV_FILE ile açıkça da verilebilir.
export function loadEnvFile(file = process.env.REDAKT_ENV_FILE) {
  const candidates = file
    ? [file]
    : [path.join(serverRoot, ".env"), path.resolve(serverRoot, "..", "config", ".env")];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
  }
  return null;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Yapılandırma eksik: ${name}. server/.env dosyasını .env.example'a bakarak doldurun.`);
  return value;
}

function buildAuthentication(logger) {
  const mode = (process.env.SQL_AUTH || "sql").toLowerCase();
  const password = resolvePassword(process.env, { logger });
  if (mode === "windows" || mode === "ntlm") {
    return {
      type: "ntlm",
      options: { userName: required("SQL_USER"), password, domain: required("SQL_DOMAIN") },
    };
  }
  if (mode !== "sql") throw new Error(`Bilinmeyen SQL_AUTH değeri: ${mode}. Geçerli: sql, windows.`);
  return { type: "default", options: { userName: required("SQL_USER"), password } };
}

export function loadDatabaseConfig({ logger } = {}) {
  const host = required("SQL_HOST");
  const encrypt = process.env.SQL_ENCRYPT !== "false";
  const instanceName = process.env.SQL_INSTANCE || undefined;
  const port = process.env.SQL_PORT ? Number(process.env.SQL_PORT) : undefined;

  if (instanceName && port) {
    throw new Error("SQL_PORT ve SQL_INSTANCE aynı anda verilemez; birini seçin.");
  }
  if (encrypt && net.isIP(host)) {
    throw new Error(
      `SQL_HOST bir IP adresi (${host}) ve şifreleme açık. TLS, sunucu adının IP olmasına izin vermiyor.\n` +
      `Çözüm: SQL_HOST'a sunucunun DNS adını yazın (ör. sqlsrv.sirket.local).\n` +
      `Ad çözümlemesi yoksa hosts dosyasına kayıt ekleyin. Şifrelemeyi kapatmak yerine bu yolu tercih edin.`,
    );
  }

  return {
    server: host,
    port,
    database: required("SQL_DATABASE"),
    authentication: buildAuthentication(logger),
    options: {
      encrypt,
      instanceName,
      trustServerCertificate: process.env.SQL_TRUST_CERT === "true",
      appName: "redakt-onpremise",
    },
    pool: { max: Number(process.env.SQL_POOL_MAX || 4), min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: Number(process.env.SQL_CONNECT_TIMEOUT || 15000),
    requestTimeout: Number(process.env.SQL_REQUEST_TIMEOUT || 30000),
  };
}

function loadAuthConfig() {
  return {
    mode: (process.env.AUTH_MODE || "none").toLowerCase(),
    userHeader: (process.env.AUTH_USER_HEADER || "x-remote-user").toLowerCase(),
    trustedProxies: (process.env.AUTH_TRUSTED_PROXIES || "127.0.0.1,::1")
      .split(",").map((entry) => entry.trim()).filter(Boolean),
  };
}

function readCertificateFile(name, file) {
  const resolved = path.resolve(serverRoot, file);
  try {
    return fs.readFileSync(resolved);
  } catch (error) {
    throw new Error(`${name} okunamadı: ${resolved} (${error.code || error.message})`);
  }
}

// Sertifika verilirse servis doğrudan TLS ile dinler; verilmezse düz HTTP
// kalır ve TLS'i ters proxy üstlenir. İkisi de geçerli kurulumdur.
export function loadTlsConfig() {
  const cert = process.env.HTTPS_CERT || null;
  const key = process.env.HTTPS_KEY || null;
  if (!cert && !key) return null;
  if (!cert || !key) {
    throw new Error("HTTPS için hem HTTPS_CERT hem HTTPS_KEY verilmeli; yalnızca biri verilmiş.");
  }
  const options = {
    cert: readCertificateFile("HTTPS_CERT", cert),
    key: readCertificateFile("HTTPS_KEY", key),
  };
  if (process.env.HTTPS_CA) options.ca = readCertificateFile("HTTPS_CA", process.env.HTTPS_CA);
  return options;
}

export function loadServerConfig() {
  const auth = loadAuthConfig();
  return {
    // Kimlik doğrulaması ters proxy'de yapılıyorsa servisin kendisi dışarıya
    // açık olmamalı: doğrudan erişilebilen bir port o kontrolü atlatma denemesi
    // için ilk hedeftir. Bu yüzden proxy modunda varsayılan yalnızca yereldir.
    host: process.env.HTTP_HOST || (auth.mode === "proxy" ? "127.0.0.1" : "0.0.0.0"),
    port: Number(process.env.HTTP_PORT || 8080),
    staticRoot: path.resolve(serverRoot, process.env.STATIC_ROOT || "../dist"),
    rulesTable: process.env.SQL_RULES_TABLE || "dbo.RedaktKurallari",
    cacheTtlMs: Number(process.env.RULES_CACHE_TTL_MS || 60000),
    auth,
  };
}

export function loadLogConfig() {
  return {
    directory: path.resolve(serverRoot, process.env.LOG_DIR || "../logs"),
    level: (process.env.LOG_LEVEL || "info").toLowerCase(),
    retentionDays: Number(process.env.LOG_RETENTION_DAYS || 30),
    // Hata döngüsü diski doldurmasın: tek dosya ve toplam klasör sınırı.
    maxFileBytes: Number(process.env.LOG_MAX_FILE_MB || 32) * 1024 * 1024,
    maxTotalBytes: Number(process.env.LOG_MAX_TOTAL_MB || 512) * 1024 * 1024,
  };
}
