import assert from "node:assert/strict";
import test from "node:test";
import { aggregateFindings, detectText, isValidPhone, isValidTcKimlik } from "../src/pii.js";

const VALID_TC = "10000000146";

test("gerçek T.C. kimlik checksum algoritmasını uygular", () => {
  assert.equal(isValidTcKimlik(VALID_TC), true);
  assert.equal(isValidTcKimlik("10000000145"), false);
  assert.equal(isValidTcKimlik("12345678901"), false);
});

test("beş Faz 1 kategorisini doğrulanmış biçimde bulur", () => {
  const text = [
    "demo@example.com",
    "+90 532 123 45 67",
    "TR33 0006 1005 1978 6457 8413 26",
    VALID_TC,
    "4242 4242 4242 4242",
  ].join(" | ");
  assert.deepEqual(detectText(text).map((item) => item.category), ["email", "phone", "iban", "tc", "card"]);
});

test("aynı değer için aynı placeholderı ve doğru kullanım sayısını üretir", () => {
  const findings = aggregateFindings(["demo@example.com", "Tekrar DEMO@example.com"]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].placeholder, "[EMAIL_1]");
  assert.equal(findings[0].count, 2);
});

test("telefon tespiti yalnız tanınan Türkiye alan kodu ve telefon yapısını kabul eder", () => {
  for (const valid of ["+90 532 123 45 67", "05321234567", "532 123 45 67", "(212) 555 12 34"]) {
    assert.equal(isValidPhone(valid), true, `geçerli telefon reddedildi: ${valid}`);
    assert.deepEqual(detectText(valid).map(({ category }) => category), ["phone"]);
  }

  for (const falsePositive of ["3026033605", "0000010478", "8280001819", "5126046888", "4503521732"]) {
    assert.equal(isValidPhone(falsePositive), false, `referans numarası telefon sayıldı: ${falsePositive}`);
    assert.equal(detectText(falsePositive).some(({ category }) => category === "phone"), false);
  }
});

test("policy PDF regresyonundaki büyük-küçük harfli e-postayı kesin bulur", () => {
  const findings = aggregateFindings(["Contact: onebehavior@JTI.com"]);
  assert.deepEqual(
    findings.map(({ category, value, confidence }) => ({ category, value, confidence })),
    [{ category: "email", value: "onebehavior@JTI.com", confidence: "exact" }]
  );
});
