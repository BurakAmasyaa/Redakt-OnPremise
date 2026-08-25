import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImportedRuleIndex,
  detectImportedRules,
  detectImportedRulesBatched,
  levenshteinDistance,
  normalizeImportedRules,
  normalizeTurkishForComparison,
} from "../src/custom-rules.js";

// Ters-indeksin doğruluğunu bağımsız olarak kanıtlamak için kaba-kuvvet referans.
// İndeksin ürettiği sonuç her zaman buna eşit olmalı.
function referenceDetect(units, rules, unitOffset = 0) {
  const tokensOf = (value) => [...String(value).matchAll(/[\p{L}\p{N}]+/gu)]
    .map((match) => ({ normalized: normalizeTurkishForComparison(match[0]), start: match.index, end: match.index + match[0].length }));
  const tolerance = (token, exact) => (exact || [...token].length < 5 ? 0 : ([...token].length < 8 ? 1 : 2));

  return normalizeImportedRules(rules).map((rule, ruleIndex) => {
    const ruleTokens = tokensOf(rule.comparison);
    const locations = [];
    const variants = new Set();
    for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
      const text = String(units[unitIndex]);
      const tokens = tokensOf(text);
      for (let position = 0; position <= tokens.length - ruleTokens.length; position += 1) {
        const candidate = tokens.slice(position, position + ruleTokens.length);
        const matched = ruleTokens.every((ruleToken, index) =>
          levenshteinDistance(ruleToken.normalized, candidate[index].normalized, tolerance(ruleToken.normalized, rule.exact)) <= tolerance(ruleToken.normalized, rule.exact));
        if (!matched) continue;
        const matchedText = text.slice(candidate[0].start, candidate.at(-1).end);
        variants.add(matchedText);
        locations.push({ unitIndex: unitIndex + unitOffset, start: candidate[0].start, end: candidate.at(-1).end });
        position += ruleTokens.length - 1;
      }
    }
    return { id: `imported_${rule.id || ruleIndex + 1}`, count: locations.length, variants: [...variants].sort(), locations };
  }).filter((finding) => finding.count > 0);
}

const summarize = (findings) => findings
  .map((finding) => ({
    id: finding.id,
    count: finding.count,
    variants: [...finding.variants].sort(),
    locations: finding.locations.map(({ unitIndex, start, end }) => ({ unitIndex, start, end })),
  }))
  .sort((left, right) => left.id.localeCompare(right.id));

test("indeksli motor kaba-kuvvet referansla birebir aynı sonucu verir", () => {
  const rules = [
    { id: "1", find: "Ahmet Yılmaz", replacement: "[KISI_1]" },
    { id: "2", find: "Yılmaz İnşaat Ltd. Şti.", replacement: "[SIRKET_1]" },
    { id: "3", find: "ALFA-2026", replacement: "[PROJE_1]" },
    { id: "4", find: "Kaya Hukuk Bürosu", replacement: "[SIRKET_2]" },
  ];
  const units = [
    "Sayın Ahmet Yılmaz, Yılmaz İnşaat Ltd. Şti. ile ALFA-2026 projesi hakkında.",
    "ahmet yilmaz ve AHMET YILMAZ aynı kişidir; Kaya Hukuk Burosu temsil eder.",
    "Yazım hatası: Ahmet Yilmza ve Kaya Hukk Bürosu da eşleşmeli.",
    "İlgisiz metin, hiçbir kural eşleşmemeli.",
  ];

  assert.deepEqual(summarize(detectImportedRules(units, rules)), summarize(referenceDetect(units, rules)));
});

test("çakışan eşleşmelerde referansla aynı davranır", () => {
  const rules = [{ id: "1", find: "ali ali", replacement: "[X]" }];
  const units = ["ali ali ali ali", "ali ali ali"];
  assert.deepEqual(summarize(detectImportedRules(units, rules)), summarize(referenceDetect(units, rules)));
});

test("rastgele üretilmiş kural ve metinlerde referanstan sapmaz", () => {
  const words = ["ahmet", "yilmaz", "kaya", "insaat", "danismanlik", "proje", "alfa", "sirket", "ltd", "sti", "burosu", "demir", "otomotiv"];
  // Deterministik sözde-rastgele üretici (test tekrarlanabilir olsun).
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = () => words[Math.floor(random() * words.length)];

  for (let round = 0; round < 12; round += 1) {
    const rules = Array.from({ length: 6 }, (_, index) => ({
      id: String(index + 1),
      find: Array.from({ length: 1 + Math.floor(random() * 3) }, pick).join(" "),
      replacement: `[R_${index}]`,
    }));
    const units = Array.from({ length: 5 }, () =>
      Array.from({ length: 6 + Math.floor(random() * 10) }, pick).join(" "));

    assert.deepEqual(
      summarize(detectImportedRules(units, rules)),
      summarize(referenceDetect(units, rules)),
      `tur ${round} saptı`,
    );
  }
});

test("batch işleme tek seferlik işlemeyle aynı sonucu verir", async () => {
  const rules = [
    { id: "1", find: "Ahmet Yılmaz", replacement: "[KISI_1]" },
    { id: "2", find: "Kaya Hukuk Bürosu", replacement: "[SIRKET_2]" },
  ];
  const units = Array.from({ length: 25 }, (_, index) =>
    index % 3 === 0 ? `Satır ${index}: Ahmet Yılmaz` : `Satır ${index}: Kaya Hukuk Bürosu iş yapar.`);

  const batched = await detectImportedRulesBatched(units, rules, { batchSize: 7 });
  assert.deepEqual(summarize(batched), summarize(referenceDetect(units, rules)));
});

test("indeks bir kez kurulup birden çok belgede kullanılabilir", () => {
  const rules = [{ id: "1", find: "Zeynep Şahin", replacement: "[KISI_4]" }];
  const index = buildImportedRuleIndex(rules);

  const first = detectImportedRules(["Zeynep Şahin geldi."], rules, { index });
  const second = detectImportedRules(["Bugün zeynep sahin sunum yaptı."], rules, { index });

  assert.equal(first[0].count, 1);
  assert.equal(second[0].count, 1);
  assert.equal(second[0].variants[0], "zeynep sahin");
});
