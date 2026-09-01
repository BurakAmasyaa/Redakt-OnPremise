// Guard denetim olayının güven sınırı. İstemciden gelen nesne hiçbir zaman
// doğrudan loglanmaz; yalnız bu allowlist'in yeniden kurduğu enumlar ve sayılar
// logger'a geçer. Kullanıcı kimliği payload'dan değil request.user'dan gelir.

const MAX_BODY_BYTES = 16 * 1024;
const MAX_COUNT = 1_000_000;
const TOP_LEVEL_KEYS = new Set(["schema", "eventId", "createdAt", "guardVersion", "site", "artifact", "outcome", "summary"]);
const SUMMARY_KEYS = new Set([
  "fileCount", "formats", "selectedFindings", "maskedOccurrences", "categories", "sources", "scopes",
]);
const SITES = new Set(["chatgpt", "claude", "gemini", "copilot"]);
const ARTIFACTS = new Set(["file", "prompt-paste", "prompt-send"]);
const CATEGORIES = new Set([
  "email", "phone", "iban", "tc", "card", "person", "organization", "location", "documentNumber", "custom",
]);
const SOURCES = new Set(["pattern", "ner", "field", "imported-rule", "custom"]);
const SCOPES = new Set(["document", "filename", "prompt"]);

export class AuditInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AuditInputError";
    this.status = status;
  }
}

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuditInputError(`${label} nesne olmalı.`);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) throw new AuditInputError(`${label} bilinmeyen alan içeriyor: ${extra.join(", ")}.`);
}

function count(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_COUNT) {
    throw new AuditInputError(`${label} geçerli bir sayaç değil.`);
  }
  return number;
}

function enumValue(value, allowed, label) {
  if (!allowed.has(value)) throw new AuditInputError(`${label} geçersiz.`);
  return value;
}

function countMap(value, allowed, label) {
  exactKeys(value, allowed, label);
  const output = {};
  for (const [key, raw] of Object.entries(value)) output[key] = count(raw, `${label}.${key}`);
  return output;
}

export function normalizeMaskingAudit(input) {
  exactKeys(input, TOP_LEVEL_KEYS, "Audit olayı");
  if (input.schema !== 1) throw new AuditInputError("Audit şeması desteklenmiyor.");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(String(input.eventId || ""))) {
    throw new AuditInputError("Audit eventId geçersiz.");
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new AuditInputError("Audit zamanı geçersiz.");
  if (!/^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/iu.test(String(input.guardVersion || ""))) {
    throw new AuditInputError("Guard sürümü geçersiz.");
  }
  exactKeys(input.summary, SUMMARY_KEYS, "Audit özeti");

  const artifact = enumValue(input.artifact, ARTIFACTS, "Audit türü");
  const formats = Array.isArray(input.summary.formats)
    ? [...new Set(input.summary.formats.map(String))]
    : (() => { throw new AuditInputError("Audit formatları dizi olmalı."); })();
  if (formats.length > 16 || formats.some((value) => !/^[a-z0-9]{1,12}$/u.test(value))) {
    throw new AuditInputError("Audit dosya formatı geçersiz.");
  }

  const normalized = {
    schema: 1,
    eventId: String(input.eventId),
    createdAt: new Date(input.createdAt).toISOString(),
    guardVersion: String(input.guardVersion),
    site: enumValue(input.site, SITES, "Audit hedefi"),
    artifact,
    outcome: enumValue(input.outcome, new Set(["masked"]), "Audit sonucu"),
    summary: {
      fileCount: count(input.summary.fileCount, "dosya adedi"),
      formats,
      selectedFindings: count(input.summary.selectedFindings, "bulgu adedi"),
      maskedOccurrences: count(input.summary.maskedOccurrences, "maskeleme adedi"),
      categories: countMap(input.summary.categories, CATEGORIES, "kategoriler"),
      sources: countMap(input.summary.sources, SOURCES, "kaynaklar"),
      scopes: countMap(input.summary.scopes, SCOPES, "kapsamlar"),
    },
  };
  if (!normalized.summary.selectedFindings || !normalized.summary.maskedOccurrences) {
    throw new AuditInputError("Boş maskeleme olayı kaydedilemez.");
  }
  if (artifact === "file" && normalized.summary.fileCount < 1) throw new AuditInputError("Dosya audit kaydında dosya adedi eksik.");
  if (artifact !== "file" && (normalized.summary.fileCount || formats.length)) {
    throw new AuditInputError("Prompt audit kaydı dosya bilgisi içeremez.");
  }
  return normalized;
}

export async function readAuditJson(request, limit = MAX_BODY_BYTES) {
  const contentType = String(request.headers?.["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) throw new AuditInputError("Content-Type application/json olmalı.", 415);
  const declared = Number(request.headers?.["content-length"] || 0);
  if (declared > limit) throw new AuditInputError("Audit isteği çok büyük.", 413);

  const parts = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new AuditInputError("Audit isteği çok büyük.", 413);
    parts.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new AuditInputError("Audit JSON gövdesi okunamadı.");
  }
}

export function auditLogFields(event, { user, requestId } = {}) {
  return {
    kullanici: String(user || "-"),
    hedef: event.site,
    tur: event.artifact,
    olay_id: event.eventId,
    istemci_zamani: event.createdAt,
    guard_surumu: event.guardVersion,
    dosya_adedi: event.summary.fileCount,
    dosya_turleri: event.summary.formats.join(",") || "-",
    bulgu_adedi: event.summary.selectedFindings,
    maskeleme_adedi: event.summary.maskedOccurrences,
    kategoriler: event.summary.categories,
    kaynaklar: event.summary.sources,
    kapsamlar: event.summary.scopes,
    requestId,
  };
}
