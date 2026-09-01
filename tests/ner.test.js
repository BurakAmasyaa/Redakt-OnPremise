import assert from "node:assert/strict";
import test from "node:test";
import { detectNamedEntities, groupNerTokens, nerCoverage, resolveEntityOverlaps } from "../src/ner.js";
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

// Model bir sözcüğün yalnız bir parçasını etiketleyebiliyor: "Agent" WordPiece
// olarak bölününce varlık "Ag" olarak bitiyor, maskelemeden sonra "ent"
// belgede kalıyordu.
test("varlık sözcüğün ortasında bitmez, sınıra taşınır", () => {
  const text = "SQL Server Agent servisini kontrol et";
  const entities = groupNerTokens(text, [
    { entity: "B-ORG", score: 0.95, word: "SQL" },
    { entity: "I-ORG", score: 0.94, word: "Server" },
    { entity: "I-ORG", score: 0.93, word: "Ag" },
  ]);
  assert.equal(entities.length, 0, "teknik terim zaten elenmeli");

  const names = groupNerTokens("Ahmetler geldi.", [{ entity: "B-PER", score: 0.97, word: "Ahmet" }]);
  assert.deepEqual(names.map((entity) => entity.raw), ["Ahmetler"]);
});

// T-SQL dokümanında kolon adları, veri tipleri ve anahtar kelimeler kişi/kurum
// olarak işaretleniyordu; maskelenirlerse betik çalışmaz hâle gelir.
test("teknik terimler ve kod satırları kişi/kurum sayılmaz", () => {
  const cases = [
    ["RETURN", "RETURN"],
    ["nvarchar", "nvarchar"],
    ["Effort", "SELECT Effort FROM dbo.Tasks"],
    ["STG", "INSERT INTO [STG].[Leaf] SELECT * FROM x"],
  ];
  for (const [word, line] of cases) {
    const start = line.indexOf(word);
    const tokens = [];
    if (start > 0) tokens.push({ entity: "O", score: 1, word: line.slice(0, start).trim().split(/\s+/u)[0] });
    tokens.push({ entity: "B-ORG", score: 0.96, word });
    assert.deepEqual(
      groupNerTokens(line, tokens).map((entity) => entity.raw),
      [],
      `elenmedi: ${word}`
    );
  }
});

test("gerçek adlar teknik elemeden geçer", () => {
  assert.deepEqual(
    groupNerTokens("Sayın Mehmet Demir, toplantı yarın.", [
      { entity: "O", score: 1, word: "Sayın" },
      { entity: "B-PER", score: 0.97, word: "Mehmet" },
      { entity: "I-PER", score: 0.96, word: "Demir" },
    ]).map((entity) => entity.raw),
    ["Mehmet Demir"]
  );
});

// Parçalar üst üste biner; sınıra denk gelen varlık bir parçada kesik,
// diğerinde bütün çıkıyordu. Kesik olan listede ayrı bir öge olarak görünüp
// maskelemeden sonra sözcüğün kalanını belgede bırakıyordu.
test("çakışan varlıklarda uzun olan kazanır", () => {
  const resolved = resolveEntityOverlaps([
    { textIndex: 0, start: 10, end: 13, score: 0.9, category: "organization", raw: "SISPR" },
    { textIndex: 0, start: 10, end: 14, score: 0.88, category: "organization", raw: "SISPRO" },
    { textIndex: 0, start: 40, end: 46, score: 0.91, category: "person", raw: "Ahmet" },
    { textIndex: 1, start: 0, end: 4, score: 0.95, category: "organization", raw: "LEAF" },
  ]);
  assert.deepEqual(resolved.map((entity) => entity.raw), ["SISPRO", "Ahmet", "LEAF"]);
});

// Model 512 token ile sınırlıdır ve fazlasını sessizce kırpar: parçanın
// kuyruğu hiç taranmamış olur.
test("kapsam ölçümü modelin gerçekten okuduğu son karakteri verir", () => {
  const text = "Ahmet Yılmaz geldi ve gitti";
  const full = nerCoverage(text, [
    { entity: "B-PER", score: 0.9, word: "Ahmet" },
    { entity: "I-PER", score: 0.9, word: "Yılmaz" },
    { entity: "O", score: 1, word: "geldi" },
    { entity: "O", score: 1, word: "ve" },
    { entity: "O", score: 1, word: "gitti" },
  ]);
  assert.equal(full, text.length);

  const truncated = nerCoverage(text, [
    { entity: "B-PER", score: 0.9, word: "Ahmet" },
    { entity: "I-PER", score: 0.9, word: "Yılmaz" },
  ]);
  assert.ok(truncated < text.length, "kırpılma fark edilmedi");
  assert.equal(text.slice(truncated).trim(), "geldi ve gitti");
});

// Tabloda aynı değer onlarca hücrede geçer. Model aynı girdiye hep aynı çıktıyı
// verdiği için çıkarıma yalnız benzersiz metin girmeli.
test("yinelenen metin modele bir kez gider", async () => {
  const cell = "Özlem Türeci Ankara'da Koç Holding'i ziyaret etti.";
  let chunks = 0;
  await detectNamedEntities(Array.from({ length: 20 }, () => cell), {
    onProgress(progress) {
      if (progress.phase === "inference") chunks = progress.total;
    },
  });
  assert.equal(chunks, 1, "20 aynı hücre için tek parça çıkarıma girmeli");
});

// Bulgu benzersiz metinde bulunur ama maskeleme birim birim yapılır: bulgunun
// o metnin geçtiği HER birimi göstermesi gerekir, yoksa kopyalar maskelenmez.
// Boş birimler de indeksi kaydırmamalı — eskiden süzülüp indeks kaymasına ve
// adın yanlış birimde aranmasına yol açıyorlardı.
test("bulgu, metnin geçtiği bütün birimlere yazılır ve boş birim indeksi kaydırmaz", async () => {
  const cell = "Özlem Türeci, Koç Holding'de çalışıyor.";
  const units = ["", cell, "12.450,00", cell, "   ", cell];
  const findings = await detectNamedEntities(units);

  const person = findings.find((finding) => finding.category === "person");
  assert.ok(person, "kişi bulunamadı");
  assert.deepEqual(
    person.locations.map((location) => location.unitIndex).sort((left, right) => left - right),
    [1, 3, 5],
    "bulgu yanlış birimlere yazıldı"
  );
  assert.equal(person.count, 3, "yineleme sayısı kayboldu");
});

// Kod satırının tamamını elemek, veri taşıyan satırlardaki GERÇEK adları da
// düşürüyordu. Bir SQL yorumundaki ya da INSERT değerindeki ad maskelenmeden
// kalıyorsa bu, teknik gürültüyü elemek için ödenecek bedelden çok daha ağır
// bir arızadır — doğrudan sızıntıdır.
test("kod satırındaki yorum ve tırnak içi ad elenmez", () => {
  const kalmali = [
    ["-- Ahmet Yılmaz tarafından güncellendi", "Ahmet Yılmaz"],
    ["/* Hazırlayan: Mehmet Demir */", "Mehmet Demir"],
    ["-- TODO: Ayşe ile teyit et", "Ayşe"],
    ["SET @musteri = 'Ahmet Yılmaz'", "Ahmet Yılmaz"],
    ["INSERT INTO Musteri VALUES ('Ahmet Yılmaz', 1)", "Ahmet Yılmaz"],
  ];
  for (const [satir, ad] of kalmali) {
    assert.deepEqual(entitiesIn(satir, ad), [ad], `elendi: ${satir}`);
  }

  // Kod bağlamındaki çıplak tanımlayıcılar elenmeye devam eder.
  for (const [satir, ad] of [
    ["SELECT Effort, nvarchar FROM dbo.Tasks WHERE x = 1", "Effort"],
    ["INSERT INTO [STG].[Leaf] SELECT * FROM x", "STG"],
  ]) {
    assert.deepEqual(entitiesIn(satir, ad), [], `elenmedi: ${ad}`);
  }
});

function entitiesIn(line, value) {
  const start = line.indexOf(value);
  const words = value.split(" ");
  const tokens = [];
  if (start > 0) tokens.push({ entity: "O", score: 1, word: line.slice(0, start).trim().split(/\s+/u)[0] });
  tokens.push({ entity: "B-PER", score: 0.97, word: words[0] });
  for (const word of words.slice(1)) tokens.push({ entity: "I-PER", score: 0.96, word });
  return groupNerTokens(line, tokens).map((entity) => entity.raw);
}

// hasPostalStructure yurt dışı posta kodu biçimini arıyordu ama `/i` bayrağı ve
// boşluklu biçim yüzünden "tutar TL 15000" ya da "Fatura No 12345" geçen HER
// satırı adres sayıp o satırdaki bütün kişi ve kurum adlarını eliyordu.
test("tutar ve belge numarası içeren satır adres sayılmaz", () => {
  for (const satir of [
    "Tutar TL 15000 · Ahmet Yılmaz onayladı",
    "Fatura No 12345 Ahmet Yılmaz",
    "Ek 1234 sayılı yazı Ahmet Yılmaz imzalı",
  ]) {
    assert.deepEqual(entitiesIn(satir, "Ahmet Yılmaz"), ["Ahmet Yılmaz"], `elendi: ${satir}`);
  }
  // Gerçek posta kodu biçimi hâlâ adres bağlamı sayılır.
  assert.deepEqual(entitiesIn("Dogus St TR-35390 BUCA Ahmet Yılmaz", "Ahmet Yılmaz"), []);
});

// Gürültü filtresinin en pahalı hatası gerçek bir adı elemektir. Aşağıdakilerin
// hepsi gerçek belgelerde görülen biçimler; hiçbiri kod değildir.
test("imza bloğu, kaynakça ve küçük harfli metinde ad elenmez", () => {
  const korunmali = [
    ["Talep sahibi Ayşe · iletisim@ornek.com.tr", "Ayşe"],
    ["Kaynak https://ornek.com.tr — hazırlayan Ayşe", "Ayşe"],
    ["Onay: @ayse tarafından verildi, Ayşe imzaladı", "Ayşe"],
    ["talep sahibi ahmet demir", "ahmet demir"],
  ];
  for (const [line, value] of korunmali) {
    assert.deepEqual(entitiesIn(line, value), [value], `elendi: ${line}`);
  }

  // Alt çizgiyle birleşmiş ad elenmiyor; aralık sözcüğün tamamına taşınıyor,
  // yani maskeleme "Kerem_Aydin_dilekce" parçasının hiçbir yerini açıkta bırakmaz.
  const birlesik = entitiesIn("Dosya Kerem_Aydin_dilekce olarak kaydedildi", "Kerem_Aydin");
  assert.equal(birlesik.length, 1, "alt çizgili ad elendi");
  assert.ok(birlesik[0].includes("Kerem_Aydin"), birlesik[0]);

  // Kod bağlamındaki çıplak tanımlayıcılar elenmeye devam eder.
  for (const [line, value] of [
    ["SELECT Effort, nvarchar FROM dbo.Tasks WHERE x = 1", "Effort"],
    ["INSERT INTO [STG].[Leaf] SELECT * FROM x", "STG"],
    ["DECLARE @encryptedpwd nvarchar(50)", "encryptedpwd"],
  ]) {
    assert.deepEqual(entitiesIn(line, value), [], `elenmedi: ${value}`);
  }
});

// "elif" Python anahtar kelimesi ama Türkiye'nin en yaygın kadın adlarından
// biri; kesin terim listesinde durması onu hiçbir bağlamda maskeletmiyordu.
test("yaygın Türkçe adlar teknik terim listesinde değildir", () => {
  for (const name of ["Elif", "Can", "Ada", "Deniz", "Ege", "Bora", "Efe", "Doğa"]) {
    assert.deepEqual(entitiesIn(`Sayın ${name} geldi.`, name), [name], `teknik sayıldı: ${name}`);
  }
});

// Eşik token ORTALAMASINA uygulanıyordu: iki parçalı bir adda tek zayıf token
// bütün kişiyi düşürüyor, aynı ad tek başına geçtiğinde bulunuyordu.
test("tek zayıf token bütün adı düşürmez", () => {
  const tokens = (scores) => [
    { entity: "O", score: 1, word: "Sayın" },
    { entity: "B-PER", score: scores[0], word: "Kerem" },
    { entity: "I-PER", score: scores[1], word: "Aydın" },
  ];
  assert.deepEqual(
    groupNerTokens("Sayın Kerem Aydın geldi", tokens([0.95, 0.70])).map((entity) => entity.raw),
    ["Kerem Aydın"]
  );
  // Hiçbir parçası eşiği geçmeyen aday yine elenir.
  assert.deepEqual(groupNerTokens("Sayın Kerem Aydın geldi", tokens([0.50, 0.60])), []);
});

// Alt alta yazılmış ad listesinde model parçaları birleştirdiğinde tek bir çok
// satırlı varlık oluşuyor, o da listedeki bütün adları tek ögeye eritiyordu.
test("varlık satır sonunu aşmaz", () => {
  const entities = groupNerTokens("Katılımcılar\nKerem Aydın\nMerve Yıldız\nAhmet Can", [
    { entity: "O", score: 1, word: "Katılımcılar" },
    { entity: "B-PER", score: 0.97, word: "Kerem" }, { entity: "I-PER", score: 0.96, word: "Aydın" },
    { entity: "I-PER", score: 0.95, word: "Merve" }, { entity: "I-PER", score: 0.94, word: "Yıldız" },
    { entity: "I-PER", score: 0.93, word: "Ahmet" }, { entity: "I-PER", score: 0.92, word: "Can" },
  ]);
  assert.ok(entities.length >= 2, "liste tek varlığa eridi");
  for (const entity of entities) {
    assert.ok(!entity.raw.includes("\n"), `varlık satır sonunu aştı: ${JSON.stringify(entity.raw)}`);
  }
});
