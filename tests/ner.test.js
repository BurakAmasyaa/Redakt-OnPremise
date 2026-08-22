import assert from "node:assert/strict";
import test from "node:test";
import { detectNamedEntities, groupNerTokens } from "../src/ner.js";
import { createReplacementMap, replaceText } from "../src/pii.js";

test("WordPiece parçalarını bağlamsal PERSON ve ORG varlıklarına birleştirir", () => {
  const text = "Özlem Türeci, BioNTech'i kurdu.";
  const tokens = [
    { entity: "B-PER", score: 0.99, word: "Özlem" },
    { entity: "I-PER", score: 0.98, word: "Tür" },
    { entity: "I-PER", score: 0.97, word: "##eci" },
    { entity: "O", score: 1, word: "," },
    { entity: "B-ORG", score: 0.96, word: "Bi" },
    { entity: "B-ORG", score: 0.95, word: "##o" },
    { entity: "B-ORG", score: 0.94, word: "##N" },
    { entity: "B-ORG", score: 0.93, word: "##T" },
    { entity: "B-ORG", score: 0.92, word: "##ech" },
    { entity: "O", score: 1, word: "'" },
    { entity: "O", score: 1, word: "i" },
    { entity: "O", score: 1, word: "kurdu" },
    { entity: "O", score: 1, word: "." },
  ];

  assert.deepEqual(
    groupNerTokens(text, tokens).map(({ category, raw }) => ({ category, raw })),
    [
      { category: "person", raw: "Özlem Türeci" },
      { category: "organization", raw: "BioNTech" },
    ]
  );
});

test("modelin LOC etiketini Adres/Konum bulgusuna dönüştürür", () => {
  const text = "Toplantı Ankara'da yapılacak.";
  const tokens = [
    { entity: "O", score: 0.99, word: "Toplantı" },
    { entity: "B-LOC", score: 0.97, word: "Ankara" },
    { entity: "O", score: 0.99, word: "'" },
    { entity: "O", score: 0.99, word: "da" },
  ];

  assert.deepEqual(
    groupNerTokens(text, tokens).map(({ category, raw }) => ({ category, raw })),
    [{ category: "location", raw: "Ankara" }]
  );
});

test("tek harfleri ve adres bağlamındaki yanlış PER/ORG parçalarını eler", () => {
  assert.deepEqual(groupNerTokens("D", [{ entity: "B-ORG", score: 0.99, word: "D" }]), []);

  const adatepeText = "D.E.U. Depark Beta Adatepe Dogus St\nTR-35390 BUCA-IZMIR";
  assert.deepEqual(
    groupNerTokens(adatepeText, [{ entity: "B-ORG", score: 0.95, word: "Adatepe" }]),
    []
  );

  const gostkowText = "Gostków Stary 42, 99-220 Wartkowice";
  assert.deepEqual(
    groupNerTokens(gostkowText, [
      { entity: "B-PER", score: 0.94, word: "Gostków" },
      { entity: "I-PER", score: 0.93, word: "Stary" },
    ]),
    []
  );
});

test("yerel ONNX modeli konum etiketini gerçekten üretir", async () => {
  const findings = await detectNamedEntities(["Özlem Türeci Ankara'da Koç Holding'i ziyaret etti."]);
  assert.ok(findings.some(({ category, value }) => category === "location" && value === "Ankara"));
});

test("seçili yerel ONNX modeli Türkçe kişi ve kurumu gerçekten bulur", async () => {
  const findings = await detectNamedEntities(["Özlem Türeci, Koç Holding'de çalışıyor."]);
  assert.deepEqual(
    findings.map(({ category, value, confidence }) => ({ category, value, confidence })),
    [
      { category: "person", value: "Özlem Türeci", confidence: "probable" },
      { category: "organization", value: "Koç Holding", confidence: "probable" },
    ]
  );
});

test("özel senaryodaki Türkçe kişi ve şirketi bağlamsal olarak ayırır", async () => {
  const findings = await detectNamedEntities(["Muvaffak Amasya, ABC Otomotiv ile görüştü."]);
  assert.deepEqual(
    findings.map(({ category, value }) => ({ category, value })),
    [
      { category: "person", value: "Muvaffak Amasya" },
      { category: "organization", value: "ABC Otomotiv" },
    ]
  );
});

test("NER bulgularını aynı bağlamsal değerlerle maskeler", () => {
  const findings = [
    {
      id: "ner_1",
      category: "person",
      value: "Özlem Türeci",
      variants: ["Özlem Türeci"],
      normalized: "özlem türeci",
      placeholder: "[KISI_1]",
    },
    {
      id: "ner_2",
      category: "organization",
      value: "Koç Holding",
      variants: ["Koç Holding"],
      normalized: "koç holding",
      placeholder: "[KURUM_1]",
    },
  ];
  const map = createReplacementMap(findings, findings.map(({ id }) => id));
  assert.equal(
    replaceText("Özlem Türeci, Koç Holding'de çalışıyor.", map),
    "[KISI_1], [KURUM_1]'de çalışıyor."
  );
});
