import assert from "node:assert/strict";
import test from "node:test";
import { describeError, toError } from "../src/error-message.js";

// Worker sınırını geçen hatalar Error değildir; sahada OCR "bilinmeyen hata",
// PDF "Dosya okunamadı veya bozuk olabilir" diyordu ve gerçek neden hiçbir
// yerde görünmüyordu.
test("Error olmayan fırlatmaların mesajı kaybolmaz", () => {
  assert.equal(describeError(new Error("Parola korumalı PDF")), "Parola korumalı PDF");
  assert.equal(describeError("worker yüklenemedi"), "worker yüklenemedi");
  // ErrorEvent biçimi: worker betiği hiç yüklenemediğinde gelen tek ipucu dosya adıdır.
  assert.equal(
    describeError({ message: "Failed to fetch", filename: "https://x/assets/ner-worker-abc.js", lineno: 0 }),
    "Failed to fetch (ner-worker-abc.js)"
  );
  // tesseract/pdf.js serileştirilmiş hata: düz nesne.
  assert.equal(describeError({ name: "UnknownErrorException", message: "Setting up fake worker failed" }),
    "Setting up fake worker failed");
  // İç içe: PromiseRejectionEvent.reason, ErrorEvent.error.
  assert.equal(describeError({ reason: new Error("iç neden") }), "iç neden");
  assert.equal(describeError({ error: "dize neden" }), "dize neden");
  // Mesajı olmayan adlı nesne: en azından ad.
  assert.equal(describeError({ name: "DataCloneError" }), "DataCloneError");
});

test("hiçbir ipucu yoksa yedek metin döner", () => {
  for (const value of [undefined, null, 42, {}, "", "   ", { message: "" }]) {
    assert.equal(describeError(value, "yedek"), "yedek");
  }
});

test("toError adı korur ki AbortError denetimleri sürsün", () => {
  const normalized = toError({ name: "AbortError", message: "iptal" });
  assert.ok(normalized instanceof Error);
  assert.equal(normalized.name, "AbortError");
  assert.equal(normalized.message, "iptal");
  const original = new Error("olduğu gibi");
  assert.equal(toError(original), original);
});
