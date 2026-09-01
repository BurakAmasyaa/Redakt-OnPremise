import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  AuditInputError,
  auditLogFields,
  normalizeMaskingAudit,
  readAuditJson,
} from "../server/src/audit.js";

const EVENT_ID = "123e4567-e89b-12d3-a456-426614174000";
const CREATED_AT = "2026-09-01T08:30:00.000Z";

function sampleEvent(extra = {}) {
  return {
    schema: 1,
    eventId: EVENT_ID,
    createdAt: CREATED_AT,
    guardVersion: "1.0.1",
    site: "chatgpt",
    artifact: "file",
    outcome: "masked",
    summary: {
      fileCount: 1,
      formats: ["xlsx"],
      selectedFindings: 3,
      maskedOccurrences: 4,
      categories: { person: 2, email: 1, phone: 1 },
      sources: { ner: 2, pattern: 2 },
      scopes: { document: 4 },
    },
    ...extra,
  };
}

test("sunucu audit şemasını allowlist ile yeniden kurar", () => {
  const event = normalizeMaskingAudit(sampleEvent());
  const fields = auditLogFields(event, { user: "SIRKET\\burak", requestId: "abcd1234" });
  assert.equal(fields.kullanici, "SIRKET\\burak");
  assert.deepEqual(fields.kategoriler, { person: 2, email: 1, phone: 1 });
  assert.equal(fields.dosya_turleri, "xlsx");
  assert.doesNotMatch(JSON.stringify(fields), /Ahmet|@|0532/u);
});

test("sunucu kullanıcı, dosya adı veya ham değer eklenmiş audit olayını reddeder", () => {
  for (const extra of [
    { user: "sahte" },
    { filename: "gizli.xlsx" },
    { value: "Ahmet Yılmaz" },
    { findings: [{ value: "ahmet@sirket.local" }] },
  ]) {
    assert.throws(() => normalizeMaskingAudit(sampleEvent(extra)), AuditInputError);
  }
});

test("audit HTTP gövdesi JSON ve 16 KiB sınırıyla okunur", async () => {
  const payload = JSON.stringify(sampleEvent());
  const request = Readable.from([Buffer.from(payload)]);
  request.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) };
  assert.deepEqual(await readAuditJson(request), sampleEvent());

  const wrongType = Readable.from([Buffer.from(payload)]);
  wrongType.headers = { "content-type": "text/plain" };
  await assert.rejects(() => readAuditJson(wrongType), (error) => error.status === 415);

  const tooLarge = Readable.from([]);
  tooLarge.headers = { "content-type": "application/json", "content-length": String(20 * 1024) };
  await assert.rejects(() => readAuditJson(tooLarge), (error) => error.status === 413);
});
