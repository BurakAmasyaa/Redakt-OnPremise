import assert from "node:assert/strict";
import test from "node:test";
import { detectLabelledFields } from "../src/field-labels.js";
import { createReplacementMap, replaceText } from "../src/pii.js";

const maskAll = (units, findings) => {
  const map = createReplacementMap(findings, findings.map((finding) => finding.id));
  return units.map((unit) => replaceText(typeof unit === "string" ? unit : unit.text, map));
};

// Resmî evrakta ad cümle içinde değil, etiketin karşısında ve büyük harfle
// durur. Dil modeli bu biçimi kötü okuduğu için bir ikametgâh belgesinde
// T.C. kimlik numarası maskelenirken ad, soyad ve kayıt numarası belgede
// kalıyordu. Etiketi belgenin kendisi söylüyor.
test("etiketli alanlar aynı satırda okunur", () => {
  const page = [
    "KİMLİK BİLGİLERİ",
    "Adı : KEREM",
    "Soyadı : AYDIN",
    "Baba Adı : MEHMET",
    "Doğum Yeri : ANKARA",
    "Adres No : 1234567890",
  ].join("\n");

  const findings = detectLabelledFields([page]);
  assert.deepEqual(
    findings.map((finding) => [finding.category, finding.value]),
    [
      ["person", "KEREM"],
      ["person", "AYDIN"],
      ["person", "MEHMET"],
      ["location", "ANKARA"],
      ["documentNumber", "1234567890"],
    ]
  );

  const [masked] = maskAll([page], findings);
  for (const secret of ["KEREM", "AYDIN", "MEHMET", "ANKARA", "1234567890"]) {
    assert.ok(!masked.includes(secret), `belgede kaldı: ${secret}`);
  }
});

// Word tablosunda etiket, iki nokta ve değer üç ayrı hücredir; etiketle değer
// aynı metinde hiç bulunmaz.
test("etiket ve değer ayrı hücrelerdeyken de eşleşir", () => {
  const cells = ["Adı", ":", "KEREM", "Soyadı", ":", "AYDIN"].map((text) => ({
    text,
    location: { kind: "docx", part: "word/document.xml" },
  }));
  const findings = detectLabelledFields(cells);
  assert.deepEqual(findings.map((finding) => finding.value), ["KEREM", "AYDIN"]);
});

// Excel'de etiket satırda değil, sütunun tepesindedir.
test("Excel sütun başlığı bütün sütunu o alan yapar", () => {
  const cell = (address, text) => ({ text, location: { kind: "xlsx", sheetName: "Sayfa1", address } });
  const findings = detectLabelledFields([
    cell("A1", "Adı"), cell("B1", "Adres No"), cell("C1", "Tutar"),
    cell("A2", "Kerem"), cell("B2", "1234567890"), cell("C2", "1250"),
    cell("A3", "Merve"), cell("B3", "1234567891"), cell("C3", "990"),
  ]);
  assert.deepEqual(
    findings.map((finding) => [finding.category, finding.value]),
    [
      ["person", "Kerem"],
      ["person", "Merve"],
      ["documentNumber", "1234567890"],
      ["documentNumber", "1234567891"],
    ]
  );
  // Etiket olmayan sütun ("Tutar") maskelenmez: aşırı maskeleme de bir arızadır.
  assert.ok(!findings.some((finding) => ["1250", "990"].includes(finding.value)));
});

// Aynı değer hem desenle hem etiketle bulunursa iki ayrı yer tutucu çıkar;
// desen katmanı daha kesindir, alan orada bırakılır.
test("desenle zaten bulunan değer ikinci kez bulguya dönüşmez", () => {
  const findings = detectLabelledFields(["Kimlik No : 10000000146\nE-posta : ahmet@ornek.com.tr"]);
  assert.deepEqual(findings, []);
});

test("etiketten sonra anlamsız değer alınmaz", () => {
  const findings = detectLabelledFields([[
    "Adı :",
    "Adı : 12",
    "Adres No : yok",
    "Soyadı : -",
  ].join("\n")]);
  assert.deepEqual(findings, []);
});

// Word tablosunda etiket sütunun tepesinde olabilir. Hücre koordinatı
// office-parts.js tarafından ata düğümlerden çıkarılır; onsuz "Adres No"
// başlığının altındaki numara etiketle eşlenemiyordu.
test("Word tablosunda sütun başlığı bütün sütunu alan yapar", () => {
  const cell = (table, row, column, text) => ({
    text,
    location: { kind: "docx", part: "word/document.xml", cell: { table, row, column } },
  });
  const findings = detectLabelledFields([
    cell(0, 0, 0, "Adres Tipi"), cell(0, 0, 1, "Adres Türü"), cell(0, 0, 2, "Adres No"), cell(0, 0, 3, "Adres"),
    cell(0, 1, 0, "Yerleşim Yeri Adresi"), cell(0, 1, 1, "Yurtiçi"),
    cell(0, 1, 2, "1234567890"), cell(0, 1, 3, "ÖRNEK MAH 413 SK. NO: 10"),
  ]);
  assert.deepEqual(
    findings.map((finding) => [finding.category, finding.value]),
    [["documentNumber", "1234567890"], ["location", "ÖRNEK MAH 413 SK. NO: 10"]]
  );
});

// Etiket-değer tablosu ile veri tablosunu GENİŞLİK ayırır. Geniş bir veri
// tablosunda etikete benzeyen bir DEĞER hücresi ("Yerleşim Yeri Adresi")
// yanındaki sıradan hücreyi ("Yurtiçi") maskeletmemeli; orada etiket satırda
// değil sütunun tepesindedir.
test("geniş veri tablosunda değer hücresi etiket sayılmaz", () => {
  const cell = (row, column, text) => ({
    text,
    location: { kind: "docx", part: "word/document.xml", cell: { table: 0, row, column } },
  });
  const findings = detectLabelledFields([
    cell(0, 0, "Adres Tipi"), cell(0, 1, "Adres Türü"), cell(0, 2, "Adres No"), cell(0, 3, "Adres"),
    cell(1, 0, "Yerleşim Yeri Adresi"), cell(1, 1, "Yurtiçi"),
    cell(1, 2, "1234567890"), cell(1, 3, "ÖRNEK MAH 413 SK"),
  ]);
  assert.deepEqual(
    findings.map((finding) => finding.value),
    ["1234567890", "ÖRNEK MAH 413 SK"],
    "sıradan hücre maskelendi ya da adres kaçtı"
  );
});

// PDF'te hücre yoktur, yalnızca konum vardır. Sütun aralığı çoğu PDF'te
// geometrik boşluk değil, kendi genişliği olan ayrı bir boşluk kaydıdır.
test("PDF sayfasında sütun başlığı konumdan çıkarılır", () => {
  const text = "Adres No Adres\n1234567890 ÖRNEK MAH 413 SK";
  const record = (start, end, x, width, str) => ({ start, end, str, width, height: 11, transform: [11, 0, 0, 11, x, 0] });
  const findings = detectLabelledFields([{
    text,
    location: { kind: "pdf", pageNumber: 1 },
    layout: [
      record(0, 8, 300, 45, "Adres No"),
      record(8, 9, 345, 55, " "),
      record(9, 14, 400, 29, "Adres"),
      record(15, 25, 300, 61, "1234567890"),
      record(25, 26, 361, 39, " "),
      record(26, 42, 400, 100, "ÖRNEK MAH 413 SK"),
    ],
  }]);
  assert.deepEqual(
    findings.map((finding) => [finding.category, finding.value]),
    [["documentNumber", "1234567890"], ["location", "ÖRNEK MAH 413 SK"]]
  );
});

test("tablodan sonraki düz metin satırı sütun değeri sayılmaz", () => {
  const text = "Adres Mahalle\nAtatürk Cad No 5 Caferağa\nŞube listesi aşağıdadır.";
  const record = (start, end, x, width, str) => ({ start, end, str, width, height: 11, transform: [11, 0, 0, 11, x, 0] });
  const findings = detectLabelledFields([{
    text,
    location: { kind: "pdf", pageNumber: 1 },
    layout: [
      record(0, 5, 40, 29, "Adres"), record(5, 6, 69, 230, " "), record(6, 13, 300, 40, "Mahalle"),
      record(14, 30, 40, 90, "Atatürk Cad No 5"), record(30, 31, 130, 169, " "), record(31, 39, 300, 45, "Caferağa"),
      record(40, 63, 40, 130, "Şube listesi aşağıdadır."),
    ],
  }]);
  assert.deepEqual(findings.map((finding) => finding.value), ["Atatürk Cad No 5", "Caferağa"]);
});

// "Web adresi" bir yer değildir; niteleme görmezden gelindiğinde sıradan bir
// imza bloğu konum diye maskeleniyordu.
test("web/e-posta/IP adresi konum sayılmaz", () => {
  for (const line of ["Web adresi: https://www.ornek.com.tr", "E-posta adresi: ahmet@ornek.com.tr", "IP adresi: 192.168.1.10"]) {
    assert.deepEqual(detectLabelledFields([line]), [], line);
  }
  // Gerçek adres etiketleri etkilenmez.
  assert.equal(detectLabelledFields(["Posta adresi: Cumhuriyet Mah. 12. Sokak No 3"]).length, 1);
});

// Resmî evrak neredeyse her zaman BÜYÜK HARF yazılır. Etiketler tr-TR ile
// küçültülüp ham satırda `iu` bayrağıyla aranıyordu; JS'in basit katlaması
// "İ" ile "i"yi eş saymadığı için "KİMLİK NO :" hiç eşleşmiyor, ikametgâh ve
// nüfus belgelerinin tamamı maskesiz kalıyordu.
test("BÜYÜK HARF Türkçe etiketler de okunur", () => {
  const sayfa = ["KİMLİK NO : 10000000146", "ADI : KEREM", "SOYADI : AYDIN", "DOĞUM YERİ : ANKARA", "ADRES NO : 1234567890"].join("\n");
  assert.deepEqual(
    detectLabelledFields([sayfa]).map((finding) => [finding.category, finding.value]),
    [["person", "KEREM"], ["person", "AYDIN"], ["location", "ANKARA"], ["documentNumber", "1234567890"]]
  );
  // Diyakritiksiz ve karışık yazım da aynı sonucu verir.
  for (const varyant of ["DOGUM YERI : ANKARA", "Doğum Yeri : ANKARA", "doğum yeri : ANKARA"]) {
    assert.equal(detectLabelledFields([varyant]).length, 1, varyant);
  }
});

// Form tablolarının ilk satırında çoğu zaman bir başlık durur. Yalnız en
// üstteki hücreye bakan eleme, o başlık alan adı olmadığı için altındaki
// "Adı"/"Soyadı" hücrelerini veri sanıp komşu hücre eşleşmesini tamamen
// kapatıyordu.
test("form tablosunda üstte başlık olsa da etiket-değer eşleşir", () => {
  const hucre = (table, row, column, text) =>
    ({ text, location: { kind: "docx", part: "word/document.xml", cell: { table, row, column } } });

  assert.deepEqual(
    detectLabelledFields([
      hucre(0, 0, 0, "KİMLİK BİLGİLERİ"), hucre(0, 0, 1, ""),
      hucre(0, 1, 0, "Adı"), hucre(0, 1, 1, "KEREM"),
      hucre(0, 2, 0, "Soyadı"), hucre(0, 2, 1, "AYDIN"),
    ]).map((finding) => finding.value),
    ["KEREM", "AYDIN"]
  );

  // Üç sütunlu "Adı | : | KEREM" biçimi de dar bir formdur.
  assert.deepEqual(
    detectLabelledFields([
      hucre(1, 0, 0, "Adı"), hucre(1, 0, 1, ":"), hucre(1, 0, 2, "KEREM"),
      hucre(1, 1, 0, "Soyadı"), hucre(1, 1, 1, ":"), hucre(1, 1, 2, "AYDIN"),
    ]).map((finding) => finding.value),
    ["KEREM", "AYDIN"]
  );
});

// Listede olmayan bir etiket satırda değerin ardından geldiğinde değer ona
// kadar uzuyordu: "KEREM Uyruğu : T.C" tek bir kişi adı sayılıyor, asıl ad
// başka yerlerde bu varyantla eşleşmediği için maskesiz kalıyordu.
test("değer, listede olmayan bir sonraki etikete taşmaz", () => {
  for (const [line, expected] of [
    ["Adı : KEREM Uyruğu : T.C.", "KEREM"],
    ["Adı : KEREM  Medeni Hâli : Bekâr", "KEREM"],
    ["Soyadı : AYDIN Cinsiyet : E", "AYDIN"],
  ]) {
    assert.deepEqual(detectLabelledFields([line]).map((finding) => finding.value), [expected], line);
  }
  // Adreste kesme yapılmaz: gerçek adresler iki nokta taşır.
  assert.deepEqual(
    detectLabelledFields(["Adres : ÖRNEK MAH 413 SK. NO: 10"]).map((finding) => finding.value),
    ["ÖRNEK MAH 413 SK. NO: 10"]
  );
});

// Başlığın kapsamı tablo bitince biter. Sıfırlanmadığında aynı sütundaki
// toplam satırı ve dipnot da kişi adı sayılıp maskeleniyordu.
test("Excel sütun başlığının kapsamı tablo bitince biter", () => {
  const cell = (address, text) => ({ text, location: { kind: "xlsx", sheetName: "S1", address } });
  assert.deepEqual(
    detectLabelledFields([
      cell("A1", "Adı"), cell("A2", "Kerem"), cell("A3", "Merve"),
      cell("A4", ""), cell("A5", "TOPLAM"), cell("A6", "Not: rapor 2024 yılına aittir"),
    ]).map((finding) => finding.value),
    ["Kerem", "Merve"]
  );
});

// Altında veri bulunan hücre bir SÜTUN BAŞLIĞIDIR, satır etiketi değil:
// "Adı | Tutar" başlığının ikinci hücresi kişi adı sanılıp maskeleniyordu.
test("başlık satırının yanındaki başlık değer sayılmaz", () => {
  const word = (row, column, text) =>
    ({ text, location: { kind: "docx", part: "d", cell: { table: 0, row, column } } });
  assert.deepEqual(
    detectLabelledFields([word(0, 0, "Adı"), word(0, 1, "Tutar"), word(1, 0, "Kerem"), word(1, 1, "1250")])
      .map((finding) => finding.value),
    ["Kerem"]
  );
  // Form tablosunda "Adı"nın altında yine etiket durur; orada komşu eşleşmesi sürer.
  assert.deepEqual(
    detectLabelledFields([
      word(0, 0, "Adı"), word(0, 1, "KEREM"),
      word(1, 0, "Soyadı"), word(1, 1, "AYDIN"),
    ]).map((finding) => finding.value),
    ["KEREM", "AYDIN"]
  );
});
