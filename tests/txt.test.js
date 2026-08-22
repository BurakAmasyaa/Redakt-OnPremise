import assert from "node:assert/strict";
import test from "node:test";
import { applyDocumentChanges, documentAdapterFor, extractDocument } from "../src/pipeline.js";
import { detectCustomRules } from "../src/custom-rules.js";

const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

test("TXT adapter UTF-8 BOM, CRLF ve Türkçe karakterleri korur", async () => {
  const text = "Muvaffak Amasya\r\nABC Otomotiv\r\ndemo@example.com\r\nTürkçe: ğüşiöç";
  const encoded = new TextEncoder().encode(text);
  const bytes = new Uint8Array(BOM.length + encoded.length);
  bytes.set(BOM);
  bytes.set(encoded, BOM.length);

  const extracted = await extractDocument(bytes, "ornek.txt");
  assert.equal(documentAdapterFor("ornek.txt")?.id, "txt");
  assert.equal(extracted.context.bom, true);
  assert.equal(extracted.context.lineEnding, "crlf");
  assert.match(extracted.context.text, /Türkçe: ğüşiöç/u);

  const custom = detectCustomRules(extracted.context.units, [{ find: "ABC Otomotiv", replacement: "MÜŞTERİ" }]);
  const findings = [...custom, ...extracted.findings];
  const output = await applyDocumentChanges(extracted.context, findings, findings.map((finding) => finding.id));
  assert.deepEqual(output.bytes.slice(0, 3), BOM);
  const decoded = new TextDecoder().decode(output.bytes.slice(3));
  assert.match(decoded, /MÜŞTERİ/u);
  assert.match(decoded, /\r\n/u);
  assert.match(decoded, /Türkçe: ğüşiöç/u);
  assert.doesNotMatch(decoded, /demo@example\.com/u);
});

test("TXT adapter geçersiz UTF-8 içeriği reddeder", async () => {
  await assert.rejects(
    () => extractDocument(new Uint8Array([0xc3, 0x28]), "bozuk.txt"),
    /UTF-8 olarak okunamadı/u
  );
});
