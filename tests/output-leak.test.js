// Redaksiyon aracında en tehlikeli arıza sessiz olanıdır: kullanıcı belgeyi
// indirir, maskelendiğini sanır, oysa orijinal değer paketin bir köşesinde
// durmaktadır. Bu test tam olarak onu kovalar.
//
// Yöntem: her parçaya bir "nişan" değeri yerleştirilmiş belge üretilir,
// maskelenir, çıktı paketi AÇILIR ve her nişan değeri TÜM parçalarda aranır.
// Tek bir dosyada bile kalırsa test düşer. Yeni bir parça desteklendiğinde
// nişanı buraya eklemek yeterlidir — koruma kendiliğinden genişler.

import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { detectCustomRules } from "../src/custom-rules.js";
import { redactOffice, scanOffice } from "../src/office.js";

globalThis.DOMParser = DOMParser;
globalThis.XMLSerializer = XMLSerializer;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const W15 = 'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const HYPERLINK_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

function paragraph(text) {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

// Nişanlar: her biri tek bir parçayı temsil eder. "kural" olanlar regex ile
// bulunamaz; kurumsal kural listesinden gelir — o yolu da sınamak için.
const DOCX_MARKERS = {
  "word/document.xml (gövde)": "govde@firma.com.tr",
  "word/document.xml (metin kutusu)": "kutu@firma.com.tr",
  "word/document.xml (silinmiş metin)": "silinen@firma.com.tr",
  "word/document.xml (alan kodu)": "alan@firma.com.tr",
  "word/document.xml (değişiklik yazarı)": "Zeynep Ak",
  "word/header1.xml (üstbilgi)": "ustbilgi@firma.com.tr",
  "word/header2.xml (çift sayfa üstbilgisi)": "ustbilgiiki@firma.com.tr",
  "word/footer1.xml (altbilgi)": "altbilgi@firma.com.tr",
  "word/footnotes.xml (dipnot)": "dipnot@firma.com.tr",
  "word/endnotes.xml (sonnot)": "sonnot@firma.com.tr",
  "word/comments.xml (yorum metni)": "yorum@firma.com.tr",
  "word/comments.xml (yorum yazarı)": "Mehmet Kaya",
  "word/people.xml (kişi e-postası)": "kisi@firma.com.tr",
  "word/_rels/document.xml.rels (köprü hedefi)": "govdekopru@firma.com.tr",
  "word/_rels/header1.xml.rels (üstbilgi köprüsü)": "ustkopru@firma.com.tr",
  "docProps/core.xml (belge yazarı)": "Ayse Demir",
  "docProps/core.xml (başlık)": "baslik@firma.com.tr",
  "docProps/core.xml (son kaydeden)": "Fatma Oz",
  "docProps/app.xml (şirket)": "Gizli Holding",
  "docProps/custom.xml (özel alan)": "ozelalan@firma.com.tr",
};

async function docxFixture() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${REL_NS}">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
<w:document ${W}><w:body>
${paragraph("Gövde e-posta: govde@firma.com.tr")}
<w:p><w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml"><v:textbox><w:txbxContent>${paragraph("Kutu: kutu@firma.com.tr")}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>
<w:p><w:del w:id="9" w:author="Zeynep Ak"><w:r><w:delText xml:space="preserve">Silinen: silinen@firma.com.tr</w:delText></w:r></w:del></w:p>
<w:p><w:ins w:id="10" w:author="Zeynep Ak"><w:r><w:t>Eklenen satır.</w:t></w:r></w:ins></w:p>
<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "mailto:alan@firma.com.tr" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>bağlantı</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
</w:body></w:document>`);

  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${REL_NS}">
<Relationship Id="rIdH1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
<Relationship Id="rIdMail" Type="${HYPERLINK_REL}" Target="mailto:govdekopru@firma.com.tr" TargetMode="External"/>
</Relationships>`);
  zip.file("word/_rels/header1.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="${REL_NS}">
<Relationship Id="rIdMail2" Type="${HYPERLINK_REL}" Target="mailto:ustkopru@firma.com.tr" TargetMode="External"/>
</Relationships>`);

  zip.file("word/header1.xml", `<?xml version="1.0"?><w:hdr ${W}>${paragraph("Üstbilgi: ustbilgi@firma.com.tr")}</w:hdr>`);
  zip.file("word/header2.xml", `<?xml version="1.0"?><w:hdr ${W}>${paragraph("Çift sayfa: ustbilgiiki@firma.com.tr")}</w:hdr>`);
  zip.file("word/footer1.xml", `<?xml version="1.0"?><w:ftr ${W}>${paragraph("Altbilgi: altbilgi@firma.com.tr")}</w:ftr>`);
  zip.file("word/footnotes.xml", `<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:id="1">${paragraph("Dipnot: dipnot@firma.com.tr")}</w:footnote></w:footnotes>`);
  zip.file("word/endnotes.xml", `<?xml version="1.0"?><w:endnotes ${W}><w:endnote w:id="1">${paragraph("Sonnot: sonnot@firma.com.tr")}</w:endnote></w:endnotes>`);
  zip.file("word/comments.xml", `<?xml version="1.0"?><w:comments ${W}><w:comment w:id="1" w:author="Mehmet Kaya" w:initials="MK">${paragraph("Yorum: yorum@firma.com.tr")}</w:comment></w:comments>`);
  zip.file("word/people.xml", `<?xml version="1.0"?><w15:people ${W} ${W15}><w15:person w15:author="Zeynep Ak"><w15:presenceInfo w15:providerId="AD" w15:userId="kisi@firma.com.tr"/></w15:person></w15:people>`);

  zip.file("docProps/core.xml", `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Ayse Demir</dc:creator><dc:title>baslik@firma.com.tr</dc:title><cp:lastModifiedBy>Fatma Oz</cp:lastModifiedBy></cp:coreProperties>`);
  zip.file("docProps/app.xml", `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>Gizli Holding</Company><Manager>Kemal Sen</Manager></Properties>`);
  zip.file("docProps/custom.xml", `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Sorumlu"><vt:lpwstr>ozelalan@firma.com.tr</vt:lpwstr></property></Properties>`);

  return zip.generateAsync({ type: "uint8array" });
}

const XLSX_MARKERS = {
  "xl/sharedStrings.xml (hücre metni)": "hucre@firma.com.tr",
  "xl/worksheets/sheet1.xml (formül metni)": "formul@firma.com.tr",
  "xl/worksheets/sheet1.xml (formül önbellek değeri)": "onbellek@firma.com.tr",
  "xl/workbook.xml (sayfa adı)": "sayfaadi@firma.com.tr",
  "xl/comments1.xml (hücre notu)": "not@firma.com.tr",
  "xl/comments1.xml (not yazarı)": "Zeynep Ak",
  "xl/drawings/drawing1.xml (çizim kutusu)": "cizim@firma.com.tr",
  "xl/worksheets/_rels/sheet1.xml.rels (köprü hedefi)": "xlkopru@firma.com.tr",
  "docProps/core.xml (belge yazarı)": "Ayse Demir",
  "docProps/app.xml (şirket)": "Gizli Holding",
};

async function xlsxFixture() {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Ad", "E-posta"],
    ["Ali Veli", "hucre@firma.com.tr"],
  ]);
  sheet.C2 = { t: "s", f: 'CONCATENATE("formul@firma.com.tr")', v: "formul@firma.com.tr" };
  sheet.D2 = { t: "s", f: "B2", v: "onbellek@firma.com.tr" };
  sheet["!ref"] = "A1:D2";
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Rapor sayfaadi@firma.com.tr");
  workbook.Props = { Author: "Ayse Demir", Company: "Gizli Holding", Title: "Yillik" };
  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array", bookSST: true, cellFormula: true, Props: workbook.Props });

  const zip = await JSZip.loadAsync(bytes);
  zip.file("xl/comments1.xml", `<?xml version="1.0"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Zeynep Ak</author></authors><commentList><comment ref="B2" authorId="0"><text><r><t xml:space="preserve">Not: </t></r><r><t>not@firma.com.tr</t></r></text></comment></commentList></comments>`);
  zip.file("xl/drawings/drawing1.xml", `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:sp><xdr:txBody><a:p><a:r><a:t>Çizim: cizim@firma.com.tr</a:t></a:r></a:p></xdr:txBody></xdr:sp></xdr:wsDr>`);
  zip.file("xl/worksheets/_rels/sheet1.xml.rels", `<?xml version="1.0"?><Relationships xmlns="${REL_NS}"><Relationship Id="rIdX" Type="${HYPERLINK_REL}" Target="mailto:xlkopru@firma.com.tr" TargetMode="External"/></Relationships>`);
  return zip.generateAsync({ type: "uint8array" });
}

// Kurumsal kural listesinden gelen, regex'in bulamayacağı isimler.
const CORPORATE_RULES = [
  { id: "r1", find: "Zeynep Ak", replacement: "[KISI_A]" },
  { id: "r2", find: "Mehmet Kaya", replacement: "[KISI_B]" },
  { id: "r3", find: "Ayse Demir", replacement: "[KISI_C]" },
  { id: "r4", find: "Fatma Oz", replacement: "[KISI_D]" },
  { id: "r5", find: "Kemal Sen", replacement: "[KISI_E]" },
  { id: "r6", find: "Gizli Holding", replacement: "[SIRKET_A]" },
];

async function redactAll(bytes, filename) {
  const { context, findings } = await scanOffice(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), filename);
  const ruleFindings = detectCustomRules(context.units || [], CORPORATE_RULES);
  const all = [...findings, ...ruleFindings];
  const result = await redactOffice(context, all, all.map((finding) => finding.id));
  return { bytes: result.bytes, findings: all };
}

async function leakedParts(outputBytes, needle) {
  const zip = await JSZip.loadAsync(outputBytes);
  const hits = [];
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const text = await entry.async("string").catch(() => "");
    if (text.includes(needle)) hits.push(name);
  }
  return hits;
}

test("DOCX çıktısında hiçbir parçada orijinal değer kalmaz", async () => {
  const { bytes, findings } = await redactAll(await docxFixture(), "sizinti.docx");
  const leaks = [];
  const invisible = [];
  for (const [label, needle] of Object.entries(DOCX_MARKERS)) {
    const hits = await leakedParts(bytes, needle);
    if (hits.length) leaks.push(`${label} → ${needle} hâlâ ${hits.join(", ")} içinde`);
    // Bulunamayan bir değer maskelenemez; kullanıcı da eksikliği fark edemez.
    if (!findings.some((finding) => (finding.variants || []).some((variant) => variant.includes(needle)) || finding.value === needle)) {
      invisible.push(`${label} → ${needle} bulgu listesinde yok`);
    }
  }
  assert.deepEqual(invisible, [], `\n${invisible.join("\n")}`);
  assert.deepEqual(leaks, [], `\n${leaks.join("\n")}`);
});

test("XLSX çıktısında hiçbir parçada orijinal değer kalmaz", async () => {
  const { bytes, findings } = await redactAll(await xlsxFixture(), "sizinti.xlsx");
  const leaks = [];
  const invisible = [];
  for (const [label, needle] of Object.entries(XLSX_MARKERS)) {
    const hits = await leakedParts(bytes, needle);
    if (hits.length) leaks.push(`${label} → ${needle} hâlâ ${hits.join(", ")} içinde`);
    if (!findings.some((finding) => (finding.variants || []).some((variant) => variant.includes(needle)) || finding.value === needle)) {
      invisible.push(`${label} → ${needle} bulgu listesinde yok`);
    }
  }
  assert.deepEqual(invisible, [], `\n${invisible.join("\n")}`);
  assert.deepEqual(leaks, [], `\n${leaks.join("\n")}`);
});

test("maskelenen DOCX hâlâ geçerli bir pakettir", async () => {
  const { bytes } = await redactAll(await docxFixture(), "sizinti.docx");
  const zip = await JSZip.loadAsync(bytes);
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/\.(xml|rels)$/u.test(name)) continue;
    const parsed = new DOMParser().parseFromString(await entry.async("string"), "application/xml");
    assert.equal(parsed.getElementsByTagName("parsererror").length, 0, `${name} bozuldu`);
  }
  const body = await zip.file("word/document.xml").async("string");
  assert.match(body, /\[EMAIL_\d+\]/u, "gövde maskelenmemiş");
});

test("maskelenen XLSX Excel tarafından okunabilir kalır", async () => {
  const { bytes } = await redactAll(await xlsxFixture(), "sizinti.xlsx");
  const workbook = XLSX.read(bytes, { type: "array", cellFormula: true });
  const [sheetName] = workbook.SheetNames;
  // Sayfa adı Excel'in yasakladığı karakterleri içeremez, 31 karakteri aşamaz.
  assert.doesNotMatch(sheetName, /[[\]:*?/\\]/u, `sayfa adı geçersiz: ${sheetName}`);
  assert.ok(sheetName.length <= 31, `sayfa adı 31 karakteri aşıyor: ${sheetName}`);
  const sheet = workbook.Sheets[sheetName];
  assert.equal(sheet.B2.v, "[EMAIL_1]");
});
