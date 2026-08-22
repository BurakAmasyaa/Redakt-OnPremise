import http from "node:http";
import { loadDatabaseConfig, loadEnvFile, loadServerConfig } from "./config.js";
import { checkConnection, closePool } from "./db.js";
import { createRulesRepository } from "./rules-repository.js";
import { createStaticHandler } from "./static.js";

loadEnvFile();

const serverConfig = loadServerConfig();
const dbConfig = loadDatabaseConfig();
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

async function handleHealth(request, response) {
  try {
    const info = await checkConnection(dbConfig);
    const cached = rules.peek();
    sendJson(response, 200, {
      status: "ok",
      database: {
        version: info.version,
        edition: info.edition,
        login: info.login,
        name: info.database_name,
        encryption: info.encryption,
      },
      rules: cached ? { count: cached.rules.length, etag: cached.etag, fetchedAt: cached.fetchedAt } : null,
    });
  } catch (error) {
    sendJson(response, 503, { status: "error", message: error.message });
  }
}

async function handleRules(request, response) {
  const url = new URL(request.url, "http://localhost");
  try {
    const snapshot = await rules.get({ force: url.searchParams.get("force") === "1" });
    if (request.headers["if-none-match"] === snapshot.etag && !snapshot.stale) {
      response.writeHead(304, { ETag: snapshot.etag }).end();
      return;
    }
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
    sendJson(response, 503, {
      rules: null,
      message: "Kurumsal kural listesi yüklenemedi. Bu belge eksik maskelenebilir.",
      detail: error.message,
    });
  }
}

const server = http.createServer(async (request, response) => {
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");

  const pathname = (request.url || "/").split("?")[0];

  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { message: "Yalnızca GET desteklenir." });
      return;
    }
    if (pathname === "/api/health") return await handleHealth(request, response);
    if (pathname === "/api/rules") return await handleRules(request, response);
    if (pathname.startsWith("/api/")) {
      sendJson(response, 404, { message: "Bilinmeyen uç nokta." });
      return;
    }
    if (await serveStatic(request, response)) return;
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Sayfa bulunamadı.");
  } catch (error) {
    if (response.headersSent) response.destroy();
    else sendJson(response, 500, { message: "Sunucu hatası.", detail: error.message });
  }
});

server.listen(serverConfig.port, serverConfig.host, () => {
  console.log(`Redakt On-Premise  →  http://${serverConfig.host}:${serverConfig.port}`);
  console.log(`Statik kök         : ${serverConfig.staticRoot}`);
  console.log(`Kural tablosu      : ${serverConfig.rulesTable}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}
