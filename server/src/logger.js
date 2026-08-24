import fs from "node:fs";
import path from "node:path";

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const MAX_FIELD_LENGTH = 500;

// Belge içeriği hiçbir koşulda log'a yazılmaz. Bu alan adları, bir çağrı
// yanlışlıkla içerik geçirirse erken yakalansın diye reddedilir.
const FORBIDDEN_FIELDS = new Set(["text", "content", "units", "document", "body", "finding", "findings", "value"]);

function timestamp(date) {
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function dayStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatValue(value) {
  if (value === null || value === undefined) return "-";
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  const flattened = text.replaceAll(/[\r\n\t]+/gu, " ");
  return flattened.length > MAX_FIELD_LENGTH ? `${flattened.slice(0, MAX_FIELD_LENGTH)}…` : flattened;
}

function formatFields(fields) {
  const parts = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (FORBIDDEN_FIELDS.has(key)) {
      parts.push(`${key}=<REDDEDILDI:belge-icerigi-loglanmaz>`);
      continue;
    }
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function createLogger({
  directory,
  level = "info",
  retentionDays = 30,
  maxFileBytes = 32 * 1024 * 1024,
  maxTotalBytes = 512 * 1024 * 1024,
  console: useConsole = true,
  now = () => new Date(),
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  let streamKey = null;
  let writtenToStream = 0;
  let rollIndex = 0;

  if (directory) fs.mkdirSync(directory, { recursive: true });

  const LOG_FILE = /^redakt-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/u;

  function logFiles() {
    if (!directory) return [];
    return fs.readdirSync(directory)
      .filter((name) => LOG_FILE.test(name))
      .map((name) => {
        const file = path.join(directory, name);
        try {
          const stats = fs.statSync(file);
          return { name, file, mtimeMs: stats.mtimeMs, size: stats.size };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => left.mtimeMs - right.mtimeMs);
  }

  // Süre ve toplam boyut sınırı birlikte uygulanır. Süre sınırı normal
  // işletimi, boyut sınırı ise hata döngüsünün diski doldurmasını engeller.
  function pruneOldFiles() {
    if (!directory) return;
    let files = logFiles();

    if (Number.isFinite(retentionDays) && retentionDays > 0) {
      const cutoff = now().getTime() - retentionDays * 86_400_000;
      for (const entry of files) {
        if (entry.mtimeMs >= cutoff) continue;
        try { fs.unlinkSync(entry.file); } catch { /* elde değilse atla */ }
      }
      files = logFiles();
    }

    if (Number.isFinite(maxTotalBytes) && maxTotalBytes > 0) {
      let total = files.reduce((sum, entry) => sum + entry.size, 0);
      // En eskiden başlayarak sil; yazılmakta olan dosyaya dokunma.
      for (const entry of files) {
        if (total <= maxTotalBytes) break;
        if (streamKey && entry.name === streamKey) continue;
        try {
          fs.unlinkSync(entry.file);
          total -= entry.size;
        } catch { /* elde değilse atla */ }
      }
    }
  }

  function openStream(name) {
    stream?.end();
    streamKey = name;
    const file = path.join(directory, name);
    let existing = 0;
    try { existing = fs.statSync(file).size; } catch { /* yeni dosya */ }
    writtenToStream = existing;
    stream = fs.createWriteStream(file, { flags: "a" });
    stream.on("error", (error) => {
      // Log yazılamıyorsa servis durmaz; sorun stderr'e düşer.
      process.stderr.write(`[redakt] log dosyasina yazilamadi: ${error.message}\n`);
    });
    pruneOldFiles();
    return stream;
  }

  function streamFor(date, incomingBytes) {
    if (!directory) return null;
    const day = dayStamp(date);
    const base = `redakt-${day}`;

    if (!stream || !streamKey?.startsWith(base)) {
      rollIndex = 0;
      return openStream(`${base}.log`);
    }
    // Dosya boyut sınırını aşacaksa aynı gün içinde sıradaki parçaya geç.
    if (Number.isFinite(maxFileBytes) && maxFileBytes > 0 && writtenToStream + incomingBytes > maxFileBytes) {
      rollIndex += 1;
      return openStream(`${base}.${rollIndex}.log`);
    }
    return stream;
  }

  function write(levelName, message, fields) {
    if (LEVELS[levelName] < threshold) return;
    const date = now();
    const line = `${timestamp(date)} ${levelName.toUpperCase().padEnd(5)} ${message}${formatFields(fields)}\n`;
    const bytes = Buffer.byteLength(line);
    const target = streamFor(date, bytes);
    if (target) {
      target.write(line);
      writtenToStream += bytes;
    }
    // Windows servisi ve Docker stdout'u yakaladığı için konsola da yazılır.
    if (useConsole) process.stdout.write(line);
  }

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    directory,
    close() {
      stream?.end();
      stream = null;
      streamKey = null;
      writtenToStream = 0;
    },
  };
}
