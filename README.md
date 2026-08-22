# Redakt

Redakt, `.docx`, `.xlsx`, `.pdf` ve UTF-8 `.txt` belgelerindeki hassas bilgileri tamamen tarayıcı içinde
bulup maskeleyen statik bir web uygulamasıdır. Dosya hiçbir API'ye veya sunucuya
gönderilmez; regex, doğrulama algoritmaları ve NER modeli yerel olarak çalışır.

Kapsam:

- E-posta
- Telefon
- IBAN (mod-97 doğrulaması)
- T.C. Kimlik No (10. ve 11. hane checksum doğrulaması)
- Kredi kartı (Luhn doğrulaması)
- Kişi ve kurum/şirket adı (Transformers.js + yerel ONNX NER)

DOCX dosyaları JSZip ile açılır; metin değişimleri `word/document.xml` içindeki `w:t`
düğümlerinde yapılır. XLSX dosyaları SheetJS ile işlenir. DOCX `word/media` ve XLSX
`xl/media` altındaki PNG/JPEG/WebP görseller yerel OCR ile taranır; seçilen bulguların
OCR kutuları doğrudan ilgili medya görselinde maskelenir. Kişi ve kurum
adları, q4 nicemlenmiş `akdeniz27/bert-base-turkish-cased-ner` modeliyle bağlamsal
olarak bulunur; statik isim/kurum sözlüğü kullanılmaz. NER bulguları model güven
puanıyla birlikte **muhtemel** olarak gösterilir ve kullanıcı onayı bekler.

Model dosyaları `public/`, ONNX Runtime Web varlıkları `src/vendor/` altında
paketlenmiştir. `env.allowRemoteModels = false` olduğu için çalışma anında Hugging
Face'e veya başka bir dış servise istek atılmaz.

PDF dosyaları PDF.js ile önce yerel metin katmanından okunur. Metin katmanı olmayan
taranmış/görsel sayfalarda yalnızca o sayfa Tesseract.js ile yerel OCR'a alınır.
Türkçe ve İngilizce dil dosyaları uygulamanın statik asset'leri arasındadır; aynı
worker sayfalar arasında yeniden kullanılır ve sayfalar sırayla işlenir. PDF çıktısı,
hassas kaynak metnin veya pikselin geri çıkarılamaması için sayfa sayfa düzleştirilip
yeni bir PDF olarak oluşturulur; bu nedenle çıktıdaki metin seçilebilir değildir.

TXT dosyaları ortak detection pipeline'ında işlenir; UTF-8 BOM ve orijinal LF/CRLF
satır sonları export sırasında korunur. Desteklenmeyen legacy encoding'ler açık bir
hata mesajıyla reddedilir.

Büyük tablolarda NER tokenizasyonu ve ONNX inference ana thread dışında özel bir
Web Worker'da çalışır. Kayıtlar profile göre 100-200 satırlık gruplar halinde
işlenir ve ilerleme kayıt sayısıyla gösterilir. 1.000 satır üzerindeki dosyalarda
önceden uyarı gösterilir; binlerce bulgu ise sabit sayıda DOM düğümü kullanan
windowed liste ile sunulur.

Dosya seçici çoklu seçimi ve klasör yüklemeyi destekler. Dosyalar kaynak kullanımını
sınırlamak için kuyrukta yalnızca birer birer işlenir; her satır sırada, işleniyor,
tamamlandı veya hata durumunu gösterir. Büyük dosya ilerlemesi tahmini faz
ağırlıklarından değil doğrudan worker batch sayacından hesaplanır. Kalan süre,
son beş batch'in ölçülen hızına göre güncellenir.

Özel kural listeleri başlıksız bir Excel dosyasının ilk sayfasından içe aktarılır:
A sütunu aranacak ifadeyi, B sütunu birebir kullanılacak yeni değeri taşır. Bu
kurallar kullanıcı isteğiyle `localStorage` içinde yalnızca ilgili tarayıcıda
saklanır. Eşleştirme büyük/küçük harfe duyarsızdır; Türkçe karakter varyantlarını
eşdeğer sayar ve kısa ifadelerde 1, uzun ifadelerde 2 karakterlik yazım hatasını
tolere eder. Sonuçlar NER'den bağımsız olarak **kesin** grubunda gösterilir.

## Çalıştırma

```bash
npm install
npm run dev
```

Üretim için tamamen statik çıktı:

```bash
npm run build
```

Çıktı `dist/` klasörüne yazılır ve herhangi bir statik dosya sunucusunda çalışır.

## Test

```bash
npm test
```

Faz 2 tarayıcı/doğruluk testi için gerçek kişi ve kurum örneklerini içeren
`test-files/redakt-faz2-ner-test.docx` kullanılır. Aday model karşılaştırması ve
bilinen kaçırmalar `docs/faz2-model-degerlendirme.md` dosyasında kayıtlıdır.
