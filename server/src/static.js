import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const MIME_TYPES = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".gz": "application/octet-stream",
  ".traineddata": "application/octet-stream",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
}));

// Model, OCR ve font varlıkları içerik bazlı adlandırıldığı için uzun süre önbelleklenebilir.
const IMMUTABLE = /\/(models|ocr|fonts|assets)\//u;

function resolveWithinRoot(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const candidate = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return candidate;
}

async function statFile(candidate) {
  try {
    const stats = await fsp.stat(candidate);
    if (stats.isDirectory()) {
      const indexFile = path.join(candidate, "index.html");
      const indexStats = await fsp.stat(indexFile);
      return { file: indexFile, stats: indexStats };
    }
    return { file: candidate, stats };
  } catch {
    return null;
  }
}

export function createStaticHandler(root) {
  return async function serveStatic(request, response) {
    const candidate = resolveWithinRoot(root, request.url || "/");
    if (!candidate) {
      response.writeHead(403).end("Forbidden");
      return true;
    }

    const found = await statFile(candidate);
    if (!found) return false;

    const etag = `"${found.stats.size}-${found.stats.mtimeMs}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304).end();
      return true;
    }

    const extension = path.extname(found.file).toLowerCase();
    response.writeHead(200, {
      "Content-Type": MIME_TYPES.get(extension) || "application/octet-stream",
      "Content-Length": found.stats.size,
      "ETag": etag,
      "Cache-Control": IMMUTABLE.test(found.file.replaceAll(path.sep, "/"))
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });

    if (request.method === "HEAD") {
      response.end();
      return true;
    }
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(found.file);
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.pipe(response);
    });
    return true;
  };
}
