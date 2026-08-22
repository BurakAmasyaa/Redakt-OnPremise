import assert from "node:assert/strict";
import test from "node:test";
import { detectCustomRules, normalizeCustomRules } from "../src/custom-rules.js";
import { createReplacementMap, replaceText } from "../src/pii.js";

test("custom literal kuralları bulguya dönüşür ve kaydedilmeden doğrulanır", () => {
  const rules = normalizeCustomRules([{ find: "ABC Otomotiv", replacement: "MÜŞTERİ" }]);
  const findings = detectCustomRules([{ text: "ABC Otomotiv ile ABC Otomotiv", location: { kind: "text" } }], rules);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].count, 2);
  assert.equal(findings[0].replacementText, "MÜŞTERİ");
  assert.throws(() => normalizeCustomRules([{ find: "ABC", replacement: "" }]), /hem “Bul”/u);
});

test("custom kural deterministic pattern ve NER overlap'ini override eder", () => {
  const custom = detectCustomRules(["ABC Otomotiv demo@example.com"], [
    { find: "ABC Otomotiv", replacement: "MÜŞTERİ" },
    { find: "demo@example.com", replacement: "ÖZEL_EPOSTA" },
  ]);
  const automatic = [
    {
      id: "ner_1", source: "ner", category: "organization", value: "ABC Otomotiv",
      normalized: "abc otomotiv", placeholder: "[KURUM_1]", replacementText: "[KURUM_1]", variants: ["ABC Otomotiv"],
    },
    {
      id: "f_1", source: "pattern", category: "email", value: "demo@example.com",
      normalized: "demo@example.com", placeholder: "[EMAIL_1]", replacementText: "[EMAIL_1]",
    },
  ];
  const findings = [...custom, ...automatic];
  const replacements = createReplacementMap(findings, findings.map((finding) => finding.id));
  assert.equal(replaceText("ABC Otomotiv demo@example.com", replacements), "MÜŞTERİ ÖZEL_EPOSTA");
});
