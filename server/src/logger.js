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
  console: useConsole = true,
  now = () => new Date(),
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  let streamDay = null;

  if (directory) fs.mkdirSync(directory, { recursive: true });

  function pruneOldFiles() {
    if (!directory || !Number.isFinite(retentionDays) || retentionDays <= 0) return;
    const cutoff = now().getTime() - retentionDays * 86_400_000;
    for (const name of fs.readdirSync(directory)) {
      if (!/^redakt-\d{4}-\d{2}-\d{2}\.log$/u.test(name)) continue;
      const file = path.join(directory, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch { /* dosya elde değilse atlanır */ }
    }
  }

  function streamFor(date) {
    if (!directory) return null;
    const day = dayStamp(date);
    if (stream && streamDay === day) return stream;
    stream?.end();
    streamDay = day;
    stream = fs.createWriteStream(path.join(directory, `redakt-${day}.log`), { flags: "a" });
    stream.on("error", (error) => {
      // Log yazılamıyorsa servis durmaz; sorun stderr'e düşer.
      process.stderr.write(`[redakt] log dosyasina yazilamadi: ${error.message}\n`);
    });
    pruneOldFiles();
    return stream;
  }

  function write(levelName, message, fields) {
    if (LEVELS[levelName] < threshold) return;
    const date = now();
    const line = `${timestamp(date)} ${levelName.toUpperCase().padEnd(5)} ${message}${formatFields(fields)}`;
    streamFor(date)?.write(`${line}\n`);
    // Windows servisi ve Docker stdout'u yakaladığı için konsola da yazılır.
    if (useConsole) process.stdout.write(`${line}\n`);
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
      streamDay = null;
    },
  };
}
