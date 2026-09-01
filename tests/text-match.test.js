import assert from "node:assert/strict";
import test from "node:test";
import { createFoldedIndex, findFoldedOccurrences, foldForMatching } from "../src/text-match.js";

// Belgede geçen yazımı önceden bilmek mümkün değil: kullanıcı "Kerem" yazar,
// belge "KEREM" der. Eşleşme harfe takılırsa sonuç doğrudan sızıntıdır.
test("büyük/küçük harf ayrımı olmadan bulur, ham metindeki aralığı verir", () => {
  const text = "KEREM, Kerem ve kerem";
  const found = findFoldedOccurrences(text, "kerem", { wholeWord: true });
  assert.deepEqual(found.map((hit) => hit.text), ["KEREM", "Kerem", "kerem"]);
  for (const hit of found) {
    assert.equal(text.slice(hit.start, hit.end), hit.text, "aralık ham metne oturmuyor");
  }
});

// Nokta ayrımı eşleştirmede kaybolur. Aksi hâlde locale'siz bir toUpperCase
// ("Melis" -> "MELIS", Excel UPPER() ve İngilizce klavye bunu üretir) aynı adı
// bir daha yakalatmıyor, model bir yerde bulduğu adı belgenin başka bir
// köşesinde maskelemeden bırakıyordu.
test("nokta ayrımı gözetmeden eşleşir (I/İ/ı/i)", () => {
  assert.deepEqual(
    findFoldedOccurrences("İSTANBUL ve istanbul", "İstanbul", { wholeWord: true }).map((hit) => hit.text),
    ["İSTANBUL", "istanbul"]
  );
  assert.deepEqual(
    findFoldedOccurrences("MELIS YILDIRIM ve Melis Yildirim", "Melis Yildirim", { wholeWord: true }).map((hit) => hit.text),
    ["MELIS YILDIRIM", "Melis Yildirim"]
  );
  assert.deepEqual(
    findFoldedOccurrences("Irmak, ırmak ve İrmak", "ırmak", { wholeWord: true }).length,
    3
  );
});

// Türkçe belgede diyakritiksiz yazım olağandır; kurumsal kural motoru zaten
// böyle davranıyordu. İki kural yolunun ayrışması, kullanıcının kuralını yazıp
// maskelendiğini sanmasına yol açıyordu.
test("diyakritiksiz yazım aynı değer sayılır", () => {
  assert.deepEqual(
    findFoldedOccurrences("Isil Demir raporu", "Işıl Demir", { wholeWord: true }).map((hit) => hit.text),
    ["Isil Demir"]
  );
  assert.equal(foldForMatching("Şeyma Güngör"), foldForMatching("Seyma Gungor"));
});

// Ayrışık (NFD) yazım: Word ve bazı PDF'ler harfi taban + birleştirici işaret
// olarak yazar. Birleşikle eşleşmezse aynı ad belgenin yarısında maskesiz kalır.
test("ayrışık (NFD) yazım birleşikle eşleşir", () => {
  const nfc = "Şeyma Eker";
  const nfd = nfc.normalize("NFD");
  assert.notEqual(nfc, nfd, "test girdisi gerçekten ayrışık değil");
  assert.equal(foldForMatching(nfc), foldForMatching(nfd));
  assert.equal(findFoldedOccurrences(`${nfc} ve ${nfd}`, nfc, { wholeWord: true }).length, 2);
});

// Sınır denetimi ham metinde yapılır ve orada birleştirici işaret hâlâ durur.
// Sınıfa alınmazsa ayrışık metinde kural sözcüğün ortasında eşleşip belgeyi
// bozuyordu: "toz şeker" -> "toz ş[SOYAD]".
test("ayrışık metinde de sözcüğün ortası yakalanmaz", () => {
  for (const text of ["toz şeker 25 kg", "toz şeker 25 kg".normalize("NFD")]) {
    assert.deepEqual(findFoldedOccurrences(text, "Eker", { wholeWord: true }), []);
  }
});

// Görünmez karakterle kaçırma klasik bir tekniktir; kopyala-yapıştır da
// istemeden üretir.
test("görünmez biçim karakterleri eşleşmeyi düşürmez", () => {
  const gizli = ["\u00AD", "\u200B", "\u200C", "\u200D", "\u200F", "\u2060"];
  for (const karakter of gizli) {
    const text = `Sayın Ah${karakter}met Yılmaz geldi`;
    const found = findFoldedOccurrences(text, "Ahmet Yılmaz", { wholeWord: true });
    assert.equal(found.length, 1, `kaçırıldı: U+${karakter.codePointAt(0).toString(16).toUpperCase()}`);
    // Aralık görünmez karakteri de kapsamalı, yoksa yarım maskeleme olur.
    assert.ok(found[0].text.includes(karakter), "görünmez karakter aralığın dışında kaldı");
  }
});

// Sınır denetimi `\b` gibi davranır: yalnızca aranan ifadenin kendi ucu
// harf/rakamsa o taraf sınıra zorlanır.
test("sınır denetimi ifadenin kendi ucuna göre uygulanır", () => {
  assert.deepEqual(findFoldedOccurrences("kalite raporu", "ali", { wholeWord: true }), []);
  assert.deepEqual(
    findFoldedOccurrences("ahmet@ornek.com.tr", "@ornek.com.tr", { wholeWord: true }).map((hit) => hit.text),
    ["@ornek.com.tr"]
  );
  // Sınır kapalıyken alt dize eşleşmesi serbesttir.
  assert.equal(findFoldedOccurrences("kalite", "ali", { wholeWord: false }).length, 1);
});

test("eşleşmeler çakışmaz ve soldan sağa sıralıdır", () => {
  const found = findFoldedOccurrences("aaaa", "aa", { wholeWord: false });
  assert.deepEqual(found.map((hit) => hit.start), [0, 2]);
});

// Katlama uzunluğu değiştirmediği sürece eşlem birimdir ve hiç dizi kurulmaz;
// uzun belgede tekrar tekrar dizi kurmak ölçülebilir bir yüktü.
test("uzunluk değişmeyen katlamada konum eşlemi kurulmaz", () => {
  const index = createFoldedIndex("Işık İÇİN");
  assert.equal(index.offsets, null, "gereksiz eşlem dizisi kuruldu");
  assert.equal(index.folded, "isik icin");
});

// Karakter düşünce (birleştirici işaret, görünmez karakter) eşlem dizisi
// kurulur ve katlanmış konum ham metne doğru geri çevrilmelidir: maskeleme
// yanlış aralığın üzerine yazarsa ya metin bozulur ya hassas veri kalır.
test("karakter düşen katlamada konum ham metne doğru geri döner", () => {
  const source = `A${"\u200B"}hmet ${"Ş".normalize("NFD")}eyma`;
  const index = createFoldedIndex(source);
  assert.ok(index.offsets, "eşlem dizisi kurulmadı");
  assert.equal(index.offsets.length, index.folded.length + 1);
  assert.equal(index.offsets.at(-1), source.length);
  assert.equal(index.folded, "ahmet seyma");
  for (const [needle, expected] of [["Ahmet", `A${"\u200B"}hmet`], ["Şeyma", `${"Ş".normalize("NFD")}eyma`]]) {
    const [hit] = findFoldedOccurrences(source, needle, { wholeWord: true });
    assert.equal(hit.text, expected, `aralık kaydı: ${needle}`);
  }
});

test("boş arama sonuç üretmez", () => {
  assert.deepEqual(findFoldedOccurrences("bir metin", ""), []);
});

// Çakışma çözümü kabul edilenlerin tamamını tarıyor, katlama da her seferinde
// konum dizisi kuruyordu: 3 MB'lık tek bir metin biriminde tarama 74 saniye
// sürüyor, ardından her onay kutusu tıklaması 3 saniye donuyordu. Bu sınır
// karesel bir davranışın geri gelmesini yakalar; ölçüm makineye göre değişse
// de büyüklük mertebesi farkı belirgindir.
test("tek büyük metin biriminde eşleşme doğrusal ölçeklenir", async () => {
  const { collectReplacementPlan, countsForSelection, mergeFindings } = await import("../src/pii.js");
  const line = "satir ahmet yilmaz ve koc holding raporu ";
  const text = line.repeat(Math.round((1024 * 1024) / line.length));
  const findings = mergeFindings([[
    {
      id: "n1", source: "ner", category: "person", value: "ahmet yilmaz",
      variants: ["ahmet yilmaz"], normalized: "ahmet yilmaz", placeholder: "[K1]", replacementText: "[K1]",
    },
    {
      id: "n2", source: "ner", category: "organization", value: "koc holding",
      variants: ["koc holding"], normalized: "koc holding", placeholder: "[K2]", replacementText: "[K2]",
    },
  ]]);

  const planStarted = performance.now();
  const plan = collectReplacementPlan([text], findings);
  const planMs = performance.now() - planStarted;
  assert.ok(plan[0].length > 40_000, "senaryo yeterince eşleşme üretmiyor");
  assert.ok(planMs < 3000, `1 MB'lık birimde plan çıkarımı ${Math.round(planMs)} ms sürdü`);

  const countStarted = performance.now();
  countsForSelection(plan, ["n1"]);
  assert.ok(performance.now() - countStarted < 500, "seçim sayımı karesel davranıyor");
});
