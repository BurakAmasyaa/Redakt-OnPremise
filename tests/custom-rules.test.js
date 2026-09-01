import assert from "node:assert/strict";
import test from "node:test";
import { detectCustomRules, normalizeCustomRules, normalizeTurkishForComparison } from "../src/custom-rules.js";
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

// Kullanıcı kuralını "Kerem" diye yazar, belge adı "KEREM" diye taşır: resmî
// evrakta neredeyse her zaman öyle taşır. Birebir eşleşmede kural sessizce
// hiçbir şey yakalamıyor, kullanıcı da kuralını yazdığı için maskelendiğini
// sanıyordu.
test("kendi kuralın büyük/küçük harfe takılmaz", () => {
  const units = ["Adı : KEREM", "Sayın Kerem Bey", "kerem geldi"];
  const findings = detectCustomRules(units, [{ find: "Kerem", replacement: "[GİZLİ]" }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].count, 3);
  assert.deepEqual([...findings[0].variants].sort(), ["KEREM", "Kerem", "kerem"]);

  const map = createReplacementMap(findings, findings.map((finding) => finding.id));
  assert.deepEqual(units.map((unit) => replaceText(unit, map)), [
    "Adı : [GİZLİ]",
    "Sayın [GİZLİ] Bey",
    "[GİZLİ] geldi",
  ]);
});

// Harf duyarsız aramada sınırsız alt dize eşleşmesi tehlikelidir: "Ali"
// kuralı "kalite"nin içini yakalayıp belgeyi bozardı.
test("kural sözcüğün ortasını yakalamaz", () => {
  const units = ["Kalite raporu Ali tarafından hazırlandı.", "ALİ'nin notu"];
  const findings = detectCustomRules(units, [{ find: "Ali", replacement: "[KİŞİ]" }]);
  const map = createReplacementMap(findings, findings.map((finding) => finding.id));
  assert.deepEqual(units.map((unit) => replaceText(unit, map)), [
    "Kalite raporu [KİŞİ] tarafından hazırlandı.",
    "[KİŞİ]'nin notu",
  ]);
});

// Kendi ucu harf olmayan kurallar sınıra zorlanmaz, yoksa hiç eşleşemezlerdi.
test("harf olmayan uçlu kurallar eşleşmeyi kaybetmez", () => {
  const findings = detectCustomRules(["Adres: ahmet@ornek.com.tr"], [
    { find: "@ornek.com.tr", replacement: "@ornek.test" },
  ]);
  assert.equal(findings[0].count, 1);
  const map = createReplacementMap(findings, findings.map((finding) => finding.id));
  assert.equal(replaceText("Adres: ahmet@ornek.com.tr", map), "Adres: ahmet@ornek.test");
});

test("aynı kural farklı yazımla iki kez eklenmiş sayılmaz", () => {
  const findings = detectCustomRules(["KEREM"], [
    { find: "Kerem", replacement: "[A]" },
    { find: "KEREM", replacement: "[B]" },
  ]);
  assert.equal(findings.length, 1);
});

// Aynı kural metni, kurumsal listeden geldiğinde belgedeki diyakritiksiz
// yazımı buluyor, kullanıcının kural kutusundan geldiğinde hiç bulamıyordu.
// Kullanıcı kuralını yazdığı için maskelendiğini sanıyordu.
test("kendi kuralın ile kurumsal kural aynı normalizasyonu kullanır", () => {
  const metin = "Isil Demir raporu hazırladı. IŞIL DEMIR onayladı.";
  const kendi = detectCustomRules([metin], [{ find: "Işıl Demir", replacement: "[K]" }]);
  assert.equal(kendi.length, 1, "kendi kuralın diyakritiksiz yazımı kaçırdı");
  assert.equal(kendi[0].count, 2);
  assert.equal(
    normalizeTurkishForComparison("Işıl Demir"),
    normalizeTurkishForComparison("Isil Demir")
  );

  const map = createReplacementMap(kendi, kendi.map((finding) => finding.id));
  assert.equal(replaceText(metin, map), "[K] raporu hazırladı. [K] onayladı.");
});

// Excel'in UPPER()'ı ve İngilizce klavye "Melis"i "MELIS" yapar; Türkçe
// katlama ASCII "I"yı "ı" saydığında aynı ad bir daha yakalanmıyordu.
test("locale'siz büyük harfe çevrilmiş ad yakalanır", () => {
  const metin = "MELIS YILDIRIM ve Melis Yildirim aynı kişidir.";
  const bulgular = detectCustomRules([metin], [{ find: "Melis Yildirim", replacement: "[K]" }]);
  assert.equal(bulgular[0].count, 2);
  const map = createReplacementMap(bulgular, bulgular.map((finding) => finding.id));
  assert.ok(!/melis/iu.test(replaceText(metin, map)), "büyük harfli geçiş belgede kaldı");
});

// Word/Excel/PDF kırılmaz boşluk üretir, satır kaydırma ada satır sonu sokar,
// dosya adları boşluk yerine alt çizgi/tire/nokta kullanır. Çok kelimeli bir
// kural bunların hepsinde sessizce düşüyor, aynı kural kurumsal listeden
// geldiğinde token tabanlı olduğu için çalışıyordu.
test("çok kelimeli kural ayırıcı ne olursa olsun eşleşir", () => {
  const varyantlar = [
    ["kırılmaz boşluk", "Kerem Aydın geldi"],
    ["çift boşluk", "Kerem  Aydın geldi"],
    ["satır sonu", "Kerem\nAydın geldi"],
    ["alt çizgi", "20240115_Kerem_Aydin_dilekce"],
    ["tire", "Kerem-Aydın.pdf"],
    ["nokta", "Kerem.Aydın raporu"],
    ["normal", "Kerem Aydın geldi"],
  ];
  for (const [ad, metin] of varyantlar) {
    const bulgular = detectCustomRules([metin], [{ find: "Kerem Aydın", replacement: "[P]" }]);
    assert.equal(bulgular.length, 1, `kural düştü: ${ad}`);
    const map = createReplacementMap(bulgular, bulgular.map((finding) => finding.id));
    assert.ok(!/kerem/iu.test(replaceText(metin, map)), `sızıntı: ${ad}`);
  }
});

// Excel'den yapıştırmada kalan sondaki boşluk, eşleşmenin sağ sınırını
// kaydırıp kuralı yanlış yere uyguluyordu; kurumsal kurallar zaten kırpılıyor.
test("kural metnindeki baştaki ve sondaki boşluk kırpılır", () => {
  const bulgular = detectCustomRules(
    ["Personel: Kerem Aydın.", "İmzalayan: Kerem"],
    [{ find: "  Kerem ", replacement: "[P]" }]
  );
  assert.equal(bulgular[0].count, 2);
});
