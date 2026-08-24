import crypto from "node:crypto";
import http from "node:http";
import { buildInfo, versionLine } from "./build-info.js";
import { loadDatabaseConfig, loadEnvFile, loadLogConfig, loadServerConfig } from "./config.js";
import { checkConnection, closePool } from "./db.js";
import { createDiagnostics } from "./diagnostics.js";
import { createLogger } from "./logger.js";
import { createRulesRepository } from "./rules-repository.js";
import { createStaticHandler } from "./static.js";

loadEnvFile();

const logger = createLogger(loadLogConfig());
const diagnostics = createDiagnostics();

const serverConfig = loadServerConfig();
let dbConfig;
try {
  dbConfig = loadDatabaseConfig({ logger });
} catch (error) {
  logger.error("Yapılandırma okunamadı, servis başlatılamıyor", { error });
  process.exit(1);
}
const rules = createRulesRepository({
  dbConfig,
  table: serverConfig.rulesTable,
  cacheTtlMs: serverConfig.cacheTtlMs,
});
const serveStatic = createStaticHandler(serverConfig.staticRoot);

// Belge içeriği tarayıcıdan asla çıkmadığı için dış bağlantı gerekmez.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

// Denetim ve sorun giderme için istemci adresi; ileride kimlik doğrulama
// eklendiğinde bunun yerine kullanıcı adı kaydedilecek.
function clientAddress(request) {
  return request.socket?.remoteAddress || "-";
}

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(payload);
}

// Canlılık: süreç ayakta mı? İzleme sisteminin servisi yeniden başlatıp
// başlatmayacağına karar verdiği uçtur; SQL kapalıyken de 200 döner, çünkü
// SQL sorunu servisi yeniden başlatarak çözülmez.
function handleHealth(request, response) {
  const cached = rules.peek();
  sendJson(response, 200, {
    durum: "ayakta",
    surum: buildInfo(),
    ...diagnostics.anlik({
      kurallar: cached
        ? { adet: cached.rules.length, etag: cached.etag, yas_sn: Math.round((Date.now() - cached.fetchedAt) / 1000) }
        : null,
    }),
  });
}

// Hazırlık: servis gerçekten iş görebiliyor mu? SQL'e ulaşılamıyorsa 503
// döner. Yük dengeleyici ve izleme uyarıları bunu kullanmalı.
async function handleReady(request, response) {
  try {
    const info = await checkConnection(dbConfig);
    if (diagnostics.sqlBasarili()) logger.info("SQL bağlantısı yeniden kuruldu");
    const cached = rules.peek();
    sendJson(response, 200, {
      durum: "hazir",
      surum: buildInfo().surum,
      veritabani: {
        surum: info.version,
        edition: info.edition,
        login: info.login,
        ad: info.database_name,
        sifreleme: info.encryption,
      },
      kurallar: cached ? { adet: cached.rules.length, etag: cached.etag } : null,
    });
  } catch (error) {
    diagnostics.say("sqlHatasi");
    // Durum değişimini bir kez logla; her yoklamada tekrar yazmak log'u boğar.
    if (diagnostics.sqlBasarisiz(error.message)) {
      logger.error("SQL erişilemez duruma geçti", { error, requestId: request.requestId });
    }
    sendJson(response, 503, {
      durum: "hazir-degil",
      surum: buildInfo().surum,
      mesaj: error.message,
      ardisikHata: diagnostics.ardisikSqlHatasi,
    });
  }
}

async function handleRules(request, response) {
  const url = new URL(request.url, "http://localhost");
  try {
    const snapshot = await rules.get({ force: url.searchParams.get("force") === "1" });
    if (snapshot.stale) {
      logger.warn("Kurallar veritabanından yenilenemedi, önbellekteki kopya sunuluyor", {
        yas_sn: Math.round((Date.now() - snapshot.fetchedAt) / 1000),
        error: snapshot.error,
      });
    }
    if (snapshot.duplicates?.length) {
      logger.warn("Kural tablosunda çakışan kayıtlar var", { adet: snapshot.duplicates.length });
    }
    if (request.headers["if-none-match"] === snapshot.etag && !snapshot.stale) {
      diagnostics.say("kuralDegismedi");
      response.writeHead(304, { ETag: snapshot.etag }).end();
      return;
    }
    diagnostics.say("kuralIstegi");
    if (diagnostics.sqlBasarili()) logger.info("SQL bağlantısı yeniden kuruldu");
    logger.info("Kural listesi sunuldu", { adet: snapshot.rules.length, etag: snapshot.etag, bayat: snapshot.stale, requestId: request.requestId });
    sendJson(response, 200, {
      rules: snapshot.rules,
      count: snapshot.rules.length,
      total: snapshot.total,
      duplicates: snapshot.duplicates,
      fetchedAt: snapshot.fetchedAt,
      stale: snapshot.stale,
      warning: snapshot.stale
        ? `Kurallar veritabanından yenilenemedi, ${new Date(snapshot.fetchedAt).toLocaleString("tr-TR")} tarihli kopya kullanılıyor.`
        : null,
    }, { ETag: snapshot.etag });
  } catch (error) {
    // Kural listesi hiç yüklenemediyse sessizce devam etmek eksik maskelemeye yol açar.
    diagnostics.say("sqlHatasi");
    if (diagnostics.sqlBasarisiz(error.message)) logger.error("SQL erişilemez duruma geçti", { error, requestId: request.requestId });
    logger.error("Kural listesi okunamadı", { error, requestId: request.requestId });
    sendJson(response, 503, {
      rules: null,
      message: "Kurumsal kural listesi yüklenemedi. Bu belge eksik maskelenebilir.",
      detail: error.message,
      requestId: request.requestId,
    });
  }
}

const server = http.createServer(async (request, response) => {
  // Her isteğe kimlik: kullanıcı "hata aldım" dediğinde ilgili kaydı
  // log'da bulmanın tek pratik yolu budur. Yanıt başlığında da döner.
  request.requestId = crypto.randomUUID().slice(0, 8);
  response.setHeader("X-Request-Id", request.requestId);
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");

  const pathname = (request.url || "/").split("?")[0];
  diagnostics.say("istek");
  response.on("finish", () => {
    if (response.statusCode >= 500) diagnostics.say("hata5xx");
    else if (response.statusCode >= 400) diagnostics.say("hata4xx");
  });

  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { message: "Yalnızca GET desteklenir." });
      return;
    }
    if (pathname === "/api/health") return handleHealth(request, response);
    if (pathname === "/api/ready") return await handleReady(request, response);
    if (pathname === "/api/rules") return await handleRules(request, response);
    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { message: "Bilinmeyen uç nokta." });
      return;
    }
    if (await serveStatic(request, response)) {
      // Statik varlıklar sayfa başına yüzlerce istek üretir; yalnızca
      // reddedilen istekler kaydedilir, başarılı olanlar log'u boğmaz.
      if (response.statusCode === 403) logger.warn("Statik istek reddedildi", { yol: pathname, istemci: clientAddress(request), requestId: request.requestId });
      return;
    }
    logger.warn("Bulunamayan yol istendi", { yol: pathname, istemci: clientAddress(request), requestId: request.requestId });
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Sayfa bulunamadı.");
  } catch (error) {
    logger.error("İstek işlenirken hata", { yol: pathname, error, requestId: request.requestId });
    if (response.headersSent) response.destroy();
    else sendJson(response, 500, { message: "Sunucu hatası.", detail: error.message, requestId: request.requestId });
  }
});

server.listen(serverConfig.port, serverConfig.host, () => {
  logger.info("Redakt On-Premise başladı", {
    surum: versionLine(),
    adres: `http://${serverConfig.host}:${serverConfig.port}`,
    statik_kok: serverConfig.staticRoot,
    kural_tablosu: serverConfig.rulesTable,
    sql: `${dbConfig.server}${dbConfig.port ? `:${dbConfig.port}` : ""}`,
    kimlik: dbConfig.authentication.type,
    log_dizini: logger.directory,
  });
});

server.on("error", (error) => {
  logger.error("HTTP sunucusu başlatılamadı", { port: serverConfig.port, error });
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.error("Yakalanmamış hata", { error });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Karşılanmamış promise reddi", { error: reason instanceof Error ? reason : String(reason) });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    logger.info("Kapatma sinyali alındı", { sinyal: signal });
    server.close(async () => {
      await closePool();
      logger.info("Servis durdu");
      logger.close();
      process.exit(0);
    });
  });
}
