import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import {
  detectImportedRules,
  detectImportedRulesBatched,
  levenshteinDistance,
  normalizeImportedRules,
  normalizeTurkishForComparison,
} from "../src/custom-rules.js";
import { createReplacementMap, replaceText } from "../src/pii.js";
import { redactOffice, scanOffice } from "../src/office.js";

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;

// Kurallar artık şirket SQL veritabanından gelir; /api/rules bu biçimi döndürür.
function corporateRules() {
  return [
    { id: "sql_1", find: "Aslı", replacement: "KISI_ASLI" },
    { id: "sql_2", find: "Mehmet", replacement: "KISI_MEHMET" },
  ];
}

test("Türkçe karakter katlama, büyük-küçük harf ve yazım hatası toleransı kesin eşleşir", async () => {
  assert.equal(normalizeTurkishForComparison("ASLI ŞEN GÖĞÜS"), "asli sen gogus");
  assert.equal(levenshteinDistance("mehmet", "mehmt", 2), 1);

  const rules = corporateRules();
  const units = [
    { text: "Asli bugün geldi.", location: { kind: "text", line: 1 } },
    { text: "MEHMT toplantıya katıldı.", location: { kind: "text", line: 2 } },
  ];
  const findings = detectImportedRules(units, rules);
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.confidence === "exact" && finding.source === "imported-rule"));
  assert.deepEqual(findings.map((finding) => finding.value), ["Asli", "MEHMT"]);
  assert.deepEqual(findings.map((finding) => finding.variants[0]), ["Asli", "MEHMT"]);

  const batched = await detectImportedRulesBatched(units, rules, { batchSize: 1 });
  assert.deepEqual(batched.map((finding) => finding.count), [1, 1]);
  const replacements = createReplacementMap(batched, batched.map(({ id }) => id));
  assert.equal(replaceText(units[0].text, replacements), "KISI_ASLI bugün geldi.");
  assert.equal(replaceText(units[1].text, replacements), "KISI_MEHMET toplantıya katıldı.");
});

test("yarım kalmış kural sessizce yanlış maskelemeye dönüşmez", () => {
  assert.throws(() => normalizeImportedRules([{ id: "sql_1", find: "Aslı", replacement: "" }]), /hem “Bul” hem/u);
  assert.throws(() => normalizeImportedRules([{ id: "sql_2", find: "", replacement: "KISI_1" }]), /hem “Bul” hem/u);
  assert.throws(() => normalizeImportedRules([{ id: "sql_3", find: "Aslı", replacement: "Aslı" }]), /aynı olamaz/u);
});

test("Türkçe varyant ve typo gerçek XLSX çıktısında kural değerleriyle değiştirilir", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["Asli bugün geldi."],
    ["Mehmt toplantıya katıldı."],
  ]), "Belge");
  const sourceBytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });

  const { context } = await scanOffice(sourceBytes, "kural-hedefi.xlsx");
  const findings = detectImportedRules(context.units, corporateRules());
  const result = await redactOffice(context, findings, findings.map(({ id }) => id));

  const output = XLSX.read(result.bytes, { type: "array" });
  assert.equal(output.Sheets.Belge.A1.v, "KISI_ASLI bugün geldi.");
  assert.equal(output.Sheets.Belge.A2.v, "KISI_MEHMET toplantıya katıldı.");
});

// Bulanık eşleşme kısa kelimelerde alakasız sözcükleri yakalar: bir otomasyon
// belgesinde "piston" her yerde geçer ve sessizce şirket adı sanılırsa belge
// bozulur. Kullanıcı da bunu göremez — maskeleme "başarılı" görünür.
test("kısa kelimelerde bulanıklık alakasız sözcüğü maskelemez", () => {
  const rules = [
    { id: "r1", find: "Siskon", replacement: "[SIRKET_1]" },
    { id: "r2", find: "Ak", replacement: "[KISI_1]" },
  ];
  const matched = (text) => detectImportedRules([text], rules).map((finding) => finding.variants[0]);

  assert.deepEqual(matched("Piston montajı tamamlandı."), [], "piston şirket adı sanıldı");
  assert.deepEqual(matched("Ok yönü yukarı."), [], "ok kişi adı sanıldı");
  assert.deepEqual(matched("At gözlüğü."), [], "at kişi adı sanıldı");
  // Gerçek eşleşmeler kaybolmamalı.
  assert.deepEqual(matched("Siskon A.Ş. ile sözleşme."), ["Siskon"]);
  assert.deepEqual(matched("SİSKON büyük harfle yazıldı."), ["SİSKON"]);
  assert.deepEqual(matched("Ak Bey aradı."), ["Ak"]);
});

test("TamEslesme işaretli kural hiç bulanıklaşmaz", () => {
  const fuzzy = [{ id: "r1", find: "Merve", replacement: "[KISI_1]" }];
  const exact = [{ id: "r1", find: "Merve", replacement: "[KISI_1]", exact: true }];

  // Varsayılan davranış: tek harf farkı hâlâ eşleşir.
  assert.deepEqual(detectImportedRules(["Sunucu isteği serve etti."], fuzzy).map((f) => f.variants[0]), ["serve"]);
  // TamEslesme = 1: yalnızca kelimenin kendisi.
  assert.deepEqual(detectImportedRules(["Sunucu isteği serve etti."], exact), []);
  assert.deepEqual(detectImportedRules(["Merve Hanım aradı."], exact).map((f) => f.variants[0]), ["Merve"]);
  // Tam eşleşme Türkçe katlamayı ve büyük-küçük harfi korur; kaybolan yalnızca typo toleransıdır.
  assert.deepEqual(detectImportedRules(["MERVE HANIM"], exact).map((f) => f.variants[0]), ["MERVE"]);
  assert.deepEqual(detectImportedRules(["Mervenin dosyası"], exact), []);
});

test("uzun kural adlarında typo toleransı korunur", () => {
  const rules = [{ id: "r1", find: "Yılmazlar Otomotiv", replacement: "[SIRKET_1]" }];
  assert.equal(detectImportedRules(["Yilmazlar Otomotv ile görüşüldü."], rules).length, 1);
});
