import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateFindings,
  collectReplacementPlan,
  countPlannedReplacements,
  countsForSelection,
  createReplacementMap,
  detectText,
  isValidPhone,
  isValidTcKimlik,
  mergeFindings,
  redactedOutputFilename,
  replaceText,
} from "../src/pii.js";

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

test("alan adında büyük harf bulunan e-postayı kesin bulur", () => {
  const findings = aggregateFindings(["Contact: iletisim@ORNEK.com"]);
  assert.deepEqual(
    findings.map(({ category, value, confidence }) => ({ category, value, confidence })),
    [{ category: "email", value: "iletisim@ORNEK.com", confidence: "exact" }]
  );
});

// Cümle sonundaki nokta adresin tamamını kaçırıyordu: sondaki bakış ileri
// "." ve "-" karakterlerini de yasaklıyordu. Belgelerde en sık görülen biçim bu.
test("cümle sonundaki ve tire ile biten e-postayı kaçırmaz", () => {
  for (const text of ["Bize ulaşın: ahmet@ornek.com.tr.", "ahmet@ornek.com.tr-", "a@x.com, b@y.com."]) {
    const found = detectText(text).filter((match) => match.category === "email");
    assert.ok(found.length > 0, `kaçırıldı: ${text}`);
    assert.ok(found.every((match) => !match.raw.endsWith(".") && !match.raw.endsWith("-")));
  }
  assert.equal(detectText("a@x.com, b@y.com.").filter((m) => m.category === "email").length, 2);
});

// ASCII sınıf Türkçe harfi dışladığı için adresin başı eşleşmenin dışında
// kalıyor, maskelemeden sonra "ş[EMAIL_1]" gibi yarım bir sonuç çıkıyordu.
test("Türkçe harf içeren e-postayı baştan sona bulur", () => {
  const cases = [
    ["şeyma@ornek.com.tr adresine yaz", "şeyma@ornek.com.tr"],
    ["ayse.gülsün@ornek.com.tr adresine yaz", "ayse.gülsün@ornek.com.tr"],
    ["kişi-ahmet@ornek.com.tr", "kişi-ahmet@ornek.com.tr"],
  ];
  for (const [text, expected] of cases) {
    const found = detectText(text).filter((match) => match.category === "email");
    assert.deepEqual(found.map((match) => match.raw), [expected]);
  }
});

test("eşleşme her zaman adresin tamamını kapsar, yarım kalmaz", () => {
  // Yarım eşleşme en sinsi hata: kullanıcıya bulgu gösterilir, maskeleme
  // yapılır, ama adresin bir parçası belgede kalır.
  const cases = [
    "ahmet@ornek.com.trx",
    "şeyma@ornek.com.tr",
    "ayse.gülsün@alt.ornek.com.tr",
    "kişi-ahmet@ornek.com.tr",
  ];
  for (const address of cases) {
    const found = detectText(`Adres ${address} olarak geçiyor.`).filter((match) => match.category === "email");
    assert.deepEqual(found.map((match) => match.raw), [address], `yarım eşleşme: ${address}`);
  }
});

// İlk düzeltme iki yeni kusur getirmişti; ikisi de gerçek Chrome'da ölçülerek
// bulundu ve buradan geri gelmemeli.
test("adresten sonraki dipnot işareti eşleşmeyi kısaltmaz", () => {
  // Sondaki bakış ileriye rakam konulursa "a@b.co.uk¹" -> "a@b.co" olur:
  // adres yarım maskelenir, "uk¹" belgede kalır.
  for (const [text, expected] of [
    ["İletişim: a@b.co.uk¹", "a@b.co.uk"],
    ["İletişim: a@b.co.uk½", "a@b.co.uk"],
    ["İletişim: a@b.co.ukx", "a@b.co.ukx"],
  ]) {
    const found = detectText(text).filter((match) => match.category === "email");
    assert.deepEqual(found.map((match) => match.raw), [expected], text);
  }
});

test("ayrışık (NFD) yazılmış Türkçe adresi de baştan sona bulur", () => {
  const nfc = "şeyma@ornek.com.tr";
  const nfd = nfc.normalize("NFD");
  assert.notEqual(nfc, nfd, "test girdisi gerçekten ayrışık değil");
  for (const address of [nfc, nfd]) {
    const found = detectText(`Adres ${address} olarak geçiyor.`).filter((m) => m.category === "email");
    assert.deepEqual(found.map((match) => match.raw), [address]);
  }
});

test("aynı adres büyük ve küçük harfle tek bulguya düşer", () => {
  // Türkçe yerelde küçültme ASCII "I"yı "ı" yapıp aynı adresi ikiye bölüyordu.
  const findings = aggregateFindings(["AHMET@ORNEK.COM.TR ve ahmet@ornek.com.tr"]);
  const emails = findings.filter((finding) => finding.category === "email");
  assert.equal(emails.length, 1, "aynı adres iki ayrı yer tutucu aldı");
  assert.equal(emails[0].count, 2);
});

// Rapordaki sayı ile belgedeki sonuç aynı koddan çıkmalı. `count` tespit
// sayısıydı, maskeleme ise belgenin tamamını tarıyordu: rapor "2 kullanım"
// derken indirilen belgede 8 yer tutucu çıkabiliyordu.
test("kullanım sayısı maskelemenin gerçekten yapacağı değişiklik kadardır", () => {
  const findings = [{
    id: "ner_1",
    source: "ner",
    category: "organization",
    value: "LEAF",
    variants: ["LEAF"],
    normalized: "leaf",
    placeholder: "[KURUM_1]",
    replacementText: "[KURUM_1]",
    // Model yalnızca iki yerde gördü.
    count: 2,
    locations: [{ unitIndex: 0 }, { unitIndex: 1 }],
  }];
  const units = [
    "LEAF tablosu LEAF ile eşlenir.",
    "Leaf sütunu boş.",
    "Ayrı bir birimde yine LEAF geçiyor.",
  ];

  const counts = countPlannedReplacements(units, findings);
  assert.equal(counts.get("ner_1"), 4, "sayım maskeleme ile aynı değil");

  const map = createReplacementMap(findings, ["ner_1"]);
  const masked = units.map((unit) => replaceText(unit, map));
  const applied = masked.join(" ").split("[KURUM_1]").length - 1;
  assert.equal(applied, counts.get("ner_1"));
  assert.ok(!masked.join(" ").includes("Leaf"), "yazımı farklı olan geçiş belgede kaldı");
});

// Modelin belgenin bir yerinde yakaladığı ad, başka bir yerde farklı yazımla
// geçtiğinde maskelenmeden kalıyordu.
test("varlık eşleşmesi büyük/küçük harfe takılmaz ama sözcüğü yarmaz", () => {
  const findings = [{
    id: "ner_1",
    source: "ner",
    category: "person",
    value: "Kerem",
    variants: ["Kerem"],
    normalized: "kerem",
    placeholder: "[KISI_1]",
    replacementText: "[KISI_1]",
  }];
  const map = createReplacementMap(findings, ["ner_1"]);
  assert.equal(replaceText("KEREM, kerem ve Keremoğlu", map), "[KISI_1], [KISI_1] ve Keremoğlu");
});

// Dosya adı da belgenin bir parçasıdır: içi maskelenip adı kişiyi söyleyen
// dosya paylaşıldığı anda maskeleme boşa çıkar.
test("çıktı dosyası adı da aynı yer tutucularla maskelenir", () => {
  const findings = [{
    id: "ner_1",
    source: "ner",
    category: "person",
    value: "Kerem Aydın",
    variants: ["Kerem Aydın"],
    normalized: "kerem aydın",
    placeholder: "[KISI_1]",
    replacementText: "[KISI_1]",
  }];
  const map = createReplacementMap(findings, ["ner_1"]);
  assert.equal(redactedOutputFilename("Kerem Aydın ikametgah.pdf", map), "[KISI_1] ikametgah_redakte.pdf");
  // Harita verilmediğinde davranış eskisi gibi kalır.
  assert.equal(redactedOutputFilename("rapor.docx"), "rapor_redakte.docx");
  // Yol ayıracı üreten bir kural dosya adını dizine çeviremez.
  const slash = createReplacementMap([{
    id: "custom_1", source: "custom", category: "custom", value: "gizli",
    variants: ["gizli"], normalized: "gizli", placeholder: "a/b", replacementText: "a/b",
  }], ["custom_1"]);
  assert.equal(redactedOutputFilename("gizli.txt", slash), "a_b_redakte.txt");
});

// Her katman kendi içinde 1'den saymaya başlarsa iki farklı kişi aynı
// [KISI_1] etiketini alır; eşleştirme dosyası anlamsızlaşır.
test("katmanlar birleşince yer tutucular baştan numaralanır", () => {
  const fromFields = [{
    id: "field_1", source: "field", category: "person", value: "KEREM",
    variants: ["KEREM"], normalized: "kerem", placeholder: "[KISI_1]", replacementText: "[KISI_1]",
  }];
  const fromModel = [
    {
      id: "ner_1", source: "ner", category: "person", value: "Kerem",
      variants: ["Kerem"], normalized: "kerem", placeholder: "[KISI_1]", replacementText: "[KISI_1]", score: 0.9,
    },
    {
      id: "ner_2", source: "ner", category: "person", value: "Merve Yıldız",
      variants: ["Merve Yıldız"], normalized: "merve yıldız", placeholder: "[KISI_2]", replacementText: "[KISI_2]",
    },
  ];

  const merged = mergeFindings([fromFields, fromModel]);
  assert.equal(merged.length, 2, "aynı değer iki satır olarak kaldı");
  assert.deepEqual(merged.map((finding) => finding.placeholder), ["[KISI_1]", "[KISI_2]"]);
  assert.equal(merged[0].source, "field", "öndeki katman kaybetti");
  // Modelin gördüğü yazım, alan etiketinden gelen bulguya taşınır.
  assert.deepEqual([...merged[0].variants].sort(), ["KEREM", "Kerem"]);
  assert.equal(merged[0].score, 0.9);
});

test("kendi kurallarının karşılığı yeniden numaralandırmadan etkilenmez", () => {
  const merged = mergeFindings([
    [{
      id: "custom_1", source: "custom", category: "custom", value: "ABC",
      variants: ["ABC"], normalized: "ABC", placeholder: "MÜŞTERİ", replacementText: "MÜŞTERİ",
    }],
    [{
      id: "ner_1", source: "ner", category: "organization", value: "Koç Holding",
      variants: ["Koç Holding"], normalized: "koç holding", placeholder: "[KURUM_1]", replacementText: "[KURUM_1]",
    }],
  ]);
  assert.deepEqual(merged.map((finding) => finding.replacementText), ["MÜŞTERİ", "[KURUM_1]"]);
});

// Kısa bir kurumsal kural geniş bir desenin ortasına denk geldiğinde, elenen
// desenin metni çıktıda AÇIK kalıyordu: panel "IBAN -> [IBAN_1]" diyor ama
// çıktı "TR02 0006 [SUBE_1] 4793 5326 41" oluyordu.
test("çakışan bulguda seçili hiçbir değerin metni çıktıda kalmaz", async () => {
  const { normalizeImportedRules, detectImportedRules } = await import("../src/custom-rules.js");
  const iban = "TR02 0006 1005 9786 4793 5326 41";
  const text = `Hesap: ${iban} numarasına gönderin.`;
  const rules = normalizeImportedRules([{ id: "1", find: "1005 9786", replacement: "[SUBE_1]", exact: true }]);
  const findings = [...detectImportedRules([text], rules), ...aggregateFindings([text])];
  const map = createReplacementMap(findings, findings.map((finding) => finding.id));
  const output = replaceText(text, map, { unitIndex: 0 });

  for (const fragment of ["TR02", "0006", "1005", "9786", "4793", "5326"]) {
    assert.ok(!output.includes(fragment), `çıktıda "${fragment}" kaldı: ${output}`);
  }
  assert.ok(output.startsWith("Hesap: ") && output.endsWith(" numarasına gönderin."));
});

// Word, Excel ve web'den kopyalanan metin ayırıcı olarak kırılmaz boşluk
// üretir. ASCII sınıf bunu görmediği için gözle normal görünen — hatta
// "Telefon:" etiketiyle yazılmış — numaralar taramaya hiç girmiyordu.
test("Unicode boşluk ve tire ile yazılmış telefon ve kart bulunur", () => {
  const ayiricilar = [" ", " ", " ", "‑", "–"];
  for (const ayirici of ayiricilar) {
    const telefon = detectText(`Telefon: 0532${ayirici}111${ayirici}22${ayirici}33`)
      .filter((match) => match.category === "phone");
    assert.equal(telefon.length, 1, `telefon kaçırıldı: U+${ayirici.codePointAt(0).toString(16).toUpperCase()}`);
  }
  for (const ayirici of [" ", " "]) {
    const kart = detectText(`Kart: 4111${ayirici}1111${ayirici}1111${ayirici}1111`)
      .filter((match) => match.category === "card");
    assert.equal(kart.length, 1, "kart kaçırıldı");
  }
  // Binlik ayraçlı tutar kart sanılmamalı: kartta nokta ayırıcı değildir.
  assert.deepEqual(detectText("Tutar: 4.111.111.111.111.1").filter((m) => m.category === "card"), []);
});

// Görünmez karakter deseni ortasından kesiyordu: adresin yalnızca bir bölümü
// maskeleniyor, başı belgede kalıyor ve kullanıcıya var olmayan bir adres
// gösteriliyordu. T.C. kimlik numarası ise hiç bulunamıyordu.
test("görünmez karakter deseni bölmez, aralık onu da kapsar", () => {
  for (const gizli of ["­", "​", "‌", "‍", "⁠"]) {
    const metin = `İletişim: ah${gizli}met@ornek.com.tr`;
    const [eposta] = detectText(metin).filter((match) => match.category === "email");
    assert.ok(eposta, "e-posta bulunamadı");
    assert.equal(eposta.raw, "ahmet@ornek.com.tr", "kullanıcıya yarım adres gösteriliyor");
    assert.ok(metin.slice(eposta.start, eposta.end).includes(gizli), "görünmez karakter aralığın dışında");

    const tc = detectText(`Kimlik: 1000${gizli}0000146`).filter((match) => match.category === "tc");
    assert.equal(tc.length, 1, "T.C. kimlik kaçırıldı");
  }
});

test("aynı e-postanın ayrışık ve birleşik yazımı tek yer tutucu alır", () => {
  const nfc = "şeyma@ornek.com.tr";
  const bulgular = aggregateFindings([`${nfc} ve ${nfc.normalize("NFD")}`])
    .filter((finding) => finding.category === "email");
  assert.equal(bulgular.length, 1, "aynı adres iki bulguya bölündü");
  assert.equal(bulgular[0].count, 2);
});

// Kullanıcı bir kuralın karşılığını "[KISI_1]" yazdığında otomatik
// numaralandırma da aynı etiketi üretebiliyor, iki farklı kişi maskelenmiş
// belgede tek kişi gibi görünüyordu.
test("otomatik yer tutucu kullanıcının yazdığı karşılıkla çakışmaz", () => {
  const merged = mergeFindings([
    [{ id: "custom_1", source: "custom", category: "custom", value: "Kerem Aydın",
       variants: ["Kerem Aydın"], normalized: "kerem aydın", placeholder: "[KISI_1]", replacementText: "[KISI_1]" }],
    [{ id: "ner_1", source: "ner", category: "person", value: "Merve Yıldız",
       variants: ["Merve Yıldız"], normalized: "merve yıldız", placeholder: "[KISI_1]", replacementText: "[KISI_1]" }],
  ]);
  const etiketler = merged.map((finding) => finding.replacementText);
  assert.equal(new Set(etiketler).size, etiketler.length, "iki farklı kişi aynı etiketi aldı");
  assert.deepEqual(etiketler, ["[KISI_1]", "[KISI_2]"]);
});

// Sayı "tarama sırasında kaç yer bulundu" değil, "bu seçimle kaç yer
// değişecek" olmalı. Öncelikli kuralın seçimi kaldırıldığında onun kapsadığı
// bulgu yeniden devreye giriyor; sabit sayı "0 kullanım" derken belgede iki
// değişiklik oluyordu.
test("kullanım sayısı seçim değişince yeniden hesaplanır", () => {
  const units = ["Adı : KEREM", "Sayın Kerem Aydın ile görüşüldü."];
  const findings = mergeFindings([
    [{ id: "custom_1", source: "custom", category: "custom", value: "Kerem",
       variants: ["Kerem", "KEREM"], normalized: "Kerem", placeholder: "[MÜŞTERİ]", replacementText: "[MÜŞTERİ]" }],
    [{ id: "field_1", source: "field", category: "person", value: "KEREM",
       variants: ["KEREM"], normalized: "kerem", placeholder: "[KISI_1]", replacementText: "[KISI_1]" }],
  ]);
  const plan = collectReplacementPlan(units, findings);

  const hepsi = countsForSelection(plan, ["custom_1", "field_1"]);
  assert.equal(hepsi.get("custom_1"), 2);
  assert.equal(hepsi.get("field_1") || 0, 0, "öncelikli kural kapsıyor");

  const yalnizAlan = countsForSelection(plan, ["field_1"]);
  assert.equal(yalnizAlan.get("field_1"), 2, "kural çıkınca alan bulgusu devreye girmedi");

  // Sayım, maskelemenin gerçekten yaptığı değişiklikle bire bir olmalı.
  const map = createReplacementMap(findings, ["field_1"]);
  const uygulanan = units
    .map((unit) => replaceText(unit, map))
    .join(" ")
    .split("[KISI_1]").length - 1;
  assert.equal(uygulanan, yalnizAlan.get("field_1"));
});

// Desenler açgözlüdür: reddedilen bir aday, hemen ardındaki GERÇEK numarayı da
// yutuyordu. `matchAll` lastIndex'i elenen adayın ARDINA taşıdığı için gerçek
// kart hiç taranmıyor, panel "maskelendi" derken numara çıktıda kalıyordu.
test("reddedilen aday ardındaki gerçek numarayı yutmaz", () => {
  const kart = detectText("Sipariş 12345 4111 1111 1111 1111").filter((match) => match.category === "card");
  assert.deepEqual(kart.map((match) => match.raw), ["4111 1111 1111 1111"]);

  const ikisi = detectText("TCKN 10000000146 kart 4111111111111111");
  assert.deepEqual(
    ikisi.map((match) => match.category).sort(),
    ["card", "tc"],
    "kart adayı komşu T.C. numarasını yuttu"
  );
});
