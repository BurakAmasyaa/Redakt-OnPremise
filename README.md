# Redakt On-Premise

Belgelerdeki hassas bilgileri bulup maskeleyen, **şirket ağı içinde çalışan** bir uygulama.
Maskeleme kurallarını şirketin kendi SQL Server veritabanından okur.

Amaç, çalışanların belgeleri dış yapay zekâ servislerine göndermek zorunda kalmadan
temizleyebilmesidir. **Belge hiçbir zaman kullanıcının tarayıcısından çıkmaz.**

Bu depo, kamuya açık [Redakt](https://redakt.com.tr)'ın şirket içi türevidir.
Farkı: kurallar Excel yerine SQL'den gelir, pazarlama sayfaları yoktur ve tek bir
Windows sunucuya kurulacak biçimde paketlenir.

---

## En önemli şey: veri nereye gidiyor

Bunu yanlış anlamak ürünün varlık sebebini ortadan kaldırır.

```
Kullanıcının tarayıcısı                    Şirket sunucusu           Şirket SQL
─────────────────────────                  ───────────────           ──────────
  Belge açılır          ─────── hayır ───▶  (belge asla gelmez)
  Metin çıkarılır
  Regex + NER çalışır
  Kurallar uygulanır    ◀────── kural listesi ──── /api/rules ◀───── SELECT
  Maskelenmiş dosya
  indirilir
```

Sunucu iki iş yapar: **uygulamayı sunmak** ve **kural listesini okumak**.
Belge içeriği ne sunucuya gider, ne SQL'e yazılır, ne log'a düşer.

Bu sınır kodda gevşetilmemesi gereken bir kuraldır ve testle korunur
([tests/privacy.test.js](tests/privacy.test.js)): belgeyi işleyen 15 modülde ağ
erişimi ve kalıcı depolama yasaktır, ağ erişimi yalnızca
[src/rule-source.js](src/rule-source.js) içinde bulunabilir ve orada da tek
yönlüdür — gövdesiz `GET`, yalnızca `/api/rules`.

---

## Ne bulur

Üç bağımsız katman çalışır:

| Katman | Bulduğu | Nasıl |
|---|---|---|
| **Kesin** | E-posta, IBAN, T.C. Kimlik No, kredi kartı | Regex + doğrulama (IBAN mod-97, TCKN 10./11. hane, kart Luhn) |
| **Muhtemel** | Kişi adı, kurum/şirket, adres-konum, telefon | Yerel Türkçe BERT NER modeli, güven puanıyla |
| **Kurumsal** | Şirkete özel isimler, proje kodları, müşteri unvanları | SQL'deki kural tablosu |

Bulguların tamamı seçili gelir. NER bulguları ayrı bir **"Muhtemel"** grubunda
model güven puanıyla listelenir — model yanılabildiği için kullanıcı bunları
gözden geçirip seçimini kaldırabilir.

Desteklenen dosyalar: `.docx`, `.xlsx`, `.pdf`, `.txt`, `.jpg`, `.png`.
Taranmış PDF sayfaları ve Office içine gömülü görseller yerel OCR ile
(Türkçe + İngilizce) okunur.

### Belgenin neresi taranır

Bir Office dosyası tek bir XML değildir; metin paketin içine dağılır. Kapsam
dışında kalan her parça sessiz sızıntı demektir, o yüzden liste açıkça verilir:

| DOCX | XLSX |
|---|---|
| Gövde, metin kutuları | Hücreler (metin ve sayı) |
| Üstbilgi, altbilgi (hepsi) | **Formüller ve formülün önbellek değeri** |
| Dipnot, sonnot | Sayfa adları |
| Yorum metni ve **yorum yazarı** | Hücre notları ve not yazarı |
| Değişiklik izleme: silinen metin, revizyon yazarı | Çizim/grafik kutuları, grafiğin önbelleklediği değerler |
| Alan kodları (`HYPERLINK` vb.) | Tanımlı ad formülleri |
| Dış köprü hedefleri (`mailto:`) | Dış köprü hedefleri |
| Gömülü görseller (OCR) | Gömülü görseller (OCR) |
| Belge özellikleri: yazar, başlık, son kaydeden, şirket, özel alanlar | Belge özellikleri (aynı) |

Bunların hepsi bulgu listesinde de görünür — kullanıcı neyin maskeleneceğini
görmeden onaylamaz. Kapsamı [tests/output-leak.test.js](tests/output-leak.test.js)
korur: çıktı paketi açılıp her nişan değeri **tüm** parçalarda aranır.

Sayfa adı maskelenirken Excel'in ad kurallarına uydurulur (yasak karakterler,
31 karakter sınırı) ve ona yapılan formül başvuruları birlikte güncellenir.
Önbellek değeri maskelenip formül el değmeden kalırsa Excel dosyayı açtığında
orijinali geri hesaplar; bu durumda formül düşürülür.

Üç tarama seviyesi var — Hızlı, Dengeli, Kapsamlı — hız ve kapsam arasında denge kurar.

---

## Kurulum

Adım adım anlatım: **[server/scripts/KURULUM.md](server/scripts/KURULUM.md)**

Özet: paket kendi kendine yeter (Node çalışma zamanı, dil modeli, sürücüler içinde),
hedef makinede **internet gerekmez**. Kurulum betiği yapılandırmayı hazırlar,
klasör izinlerini kısıtlar, açılışta başlayan görevi tanımlar ve güvenlik duvarı
kuralını açar.

Paketi üretmek için:

```bash
npm install
npm run package
```

Çıktı `package/` klasörüne yazılır (~209 MB; büyük kısmı dil modeli ve OCR dosyaları).
Windows çalışma zamanını da eklemek için `node server/build-package.mjs --fetch-node`.

---

## Kural yönetimi

Kurallar uygulamadan değil, **doğrudan SQL'den** yönetilir. Varsayılan tablo
`dbo.RedaktKurallari`:

| Kolon | Anlamı |
|---|---|
| `Id` | Anahtar |
| `AranacakIfade` | Belgede aranacak ifade |
| `YerineDeger` | Yerine yazılacak değer, ör. `[SIRKET_1]` |
| `Kategori` | Gruplama (Kisi, Sirket, Proje…) |
| `Aktif` | `0` yapılan kural uygulanmaz; silmeye gerek yok |
| `Notlar` | Serbest açıklama |

Uygulama yalnızca `Aktif = 1` olan satırları okur.

Yeni kural eklendiğinde: sunucu değişikliği en geç bir dakika içinde görür
(`RULES_CACHE_TTL_MS`), ancak tarayıcı kural listesini **sayfa açılışında** çeker.
Sayfası zaten açık olan kullanıcı için yeni kural, sayfayı yenilediğinde veya
kural panelindeki **"Yenile"** düğmesine bastığında etkili olur.

**Eşleştirme büyük/küçük harfe duyarsızdır**, Türkçe karakter varyantlarını eşdeğer
sayar (`Şen` ≈ `Sen`) ve yazım hatası tolere eder: kısa ifadelerde 1, uzun
ifadelerde 2 karakter. Yani `ALFA-2026` kuralı `ALFA-2027`'yi de yakalayabilir —
kod adları gibi birebir eşleşmesi gereken kurallarda buna dikkat edin.

Aynı ifade için farklı değer taşıyan iki kural varsa sunucu bunu log'a uyarı
olarak yazar ve kullanıcıya bildirir.

---

## Bir şeyler ters giderse ne olur

Redaksiyon aracında en tehlikeli arıza sessiz olanıdır: kullanıcı belgeyi
indirir, maskelendiğini sanır, oysa isimler yerinde durmaktadır. İki koruma var:

- **SQL'e ulaşılamazsa** kullanıcı taramadan önce açık bir onay ekranı görür:
  *"Kurumsal kurallar yüklenemedi. Yine de devam edilsin mi?"* Sunucu son bilinen
  kural listesini önbellekten sunarsa da bunu "eski kopya" olarak işaretler.
- **NER modeli çalışmazsa** inceleme ekranında kalıcı bir uyarı belirir:
  *"Kişi ve kurum adları aranamadı."* Teknik neden de parantez içinde yazılır,
  böylece kurulumu yapan kişi sorunu teşhis edebilir.

---

## İşletim ve izleme

İki ayrı uç nokta var ve karıştırılmamalı:

| Uç | Anlamı | SQL kapalıyken |
|---|---|---|
| `GET /api/health` | **Canlılık** — süreç ayakta mı? | `200` |
| `GET /api/ready` | **Hazırlık** — iş görebiliyor mu? | `503` |

Ayrım önemli: SQL sorunu servisi yeniden başlatarak çözülmez. İzleme sisteminiz
*"servisi yeniden başlat"* kararını `/api/health`'e, *"yöneticiye haber ver"*
kararını `/api/ready`'ye bağlamalıdır.

`/api/health` ayrıca çalışan sürümü, çalışma süresini, istek ve hata sayaçlarını,
SQL bağlantı durumunu, kural önbelleğinin yaşını ve bellek kullanımını döndürür.
Prometheus yerine düz JSON tercih edildi; kurumsal Windows ortamlarında JSON
okuyabilen izleme aracı (PRTG, Zabbix, SCOM) daha yaygındır.

**Sürüm bilgisi.** Destek çağrısında ilk sorulan şeydir. Paket üretilirken sürüm,
derleme zamanı ve git commit'i gömülür; `/api/health` ve açılış log'u bunu bildirir.

**İstek kimliği.** Her yanıt `X-Request-Id` başlığı taşır ve hata gövdelerinde de
döner. Kullanıcı "hata aldım" dediğinde bu kimlikle log'daki tam kaydı bulursunuz.

**Log gürültüsü.** SQL erişilemez hale geldiğinde tek bir kayıt yazılır, geri
geldiğinde bir kayıt daha. İzleme sistemi 30 saniyede bir yoklasa da log dolmaz.

**Disk koruması.** Log dosyaları hem günlük hem boyut sınırına göre bölünür
(`LOG_MAX_FILE_MB`) ve klasörün toplam boyutu aşılırsa en eski dosyalar silinir
(`LOG_MAX_TOTAL_MB`). Bir hata döngüsü diski dolduramaz. Yazılmakta olan dosya
temizlikte hiçbir zaman silinmez.

> Şu an kimlik doğrulama olmadığı için `/api/health` ağdaki herkese açıktır ve
> SQL hata mesajı sunucu adını içerebilir. Giriş eklendiğinde bu uçların da
> korunması gerekir.

## Geliştirme

```bash
npm install          # bağımlılıklar
npm run dev          # tarayıcı uygulaması (vite, 127.0.0.1:5173)
npm test             # 116 test
npm run build        # statik çıktı → dist/
npm run package      # kurulum paketi → package/
```

Sunucuyu çalıştırmak için:

```bash
cp server/.env.example server/.env    # doldurun
cd server && npm install
npm run check                          # bağlantıyı ve tabloyu doğrular
npm start                              # uygulama + API, varsayılan :8080
```

`npm run check` kurulum sorunlarını sırayla eler: ağ erişimi, SQL Browser, port,
TLS, kimlik doğrulama, tablo ve yetkiler. Şirkette ilk bağlantıda bununla başlayın.

### Yapı

```
src/          Tarayıcı uygulaması (framework yok, vanilla + Vite)
  pipeline.js       Belge adaptörleri arayüzü
  office.js         DOCX/XLSX · pdf.js · txt.js · image.js
  office-parts.js   Office paketinin metin taşıyan tüm parçaları
  pii.js            Regex + doğrulama katmanı
  ner.js            Yerel ONNX NER modeli
  ner-worker.js     NER'i ayrı thread'de çalıştırır
  custom-rules.js   Kural eşleştirme motoru (ters indeks)
  rule-source.js    /api/rules istemcisi — TEK ağ erişim noktası
  main.js           Arayüz ve akış

server/       Şirket içi servis
  src/config.js         Yapılandırma, iki kimlik modu
  src/db.js             SQL bağlantı havuzu
  src/rules-repository.js  Kural okuma + önbellek + değişiklik tespiti
  src/server.js         HTTP: statik + /api/rules + /api/health
  src/logger.js         Kayıt altyapısı (döndürme + disk sınırı)
  src/diagnostics.js    Sayaçlar ve SQL durum takibi
  src/build-info.js     Sürüm/commit bilgisi
  src/secret.js         DPAPI ile şifrelenmiş parola
  src/check.js          Kurulum doğrulama aracı
  scripts/              kurulum.ps1 ve KURULUM.md

public/models/   Türkçe NER modeli (~150 MB)
public/ocr/      Tesseract dil dosyaları (~31 MB)
tests/           116 test
```

### Kural eşleştirme motoru

Binlerce kuralı kaldırabilmesi için motor ters indeks kullanır: belge bir kez
taranır, her kelime için aday kurallar hash aramasıyla bulunur. Bulanık
eşleştirmeyi koruyabilmek için SymSpell silme-varyantı yöntemi kullanılır.

Ölçülen: 20.000 kural × 5.000 birim ≈ 13 saniye, 1.000 kural × 1.000 birim ≈ 0,3 saniye.
Önceki "her kural için belgeyi baştan tara" yaklaşımı aynı 1.000 × 1.000 işini
29 saniyede yapıyordu; binlerce kuralda kullanılamaz hale geliyordu.

Motoru değiştirirseniz [tests/rule-index.test.js](tests/rule-index.test.js)
sonuçları kaba-kuvvet referans implementasyonla karşılaştırır — hız uğruna
doğruluktan ödün verilmediğini garanti eder.

---

## Bilinmesi gereken kısıtlar

Bunlar tasarım gereği veya ortamdan kaynaklanır; şaşırmamak için:

**Şifreli SQL bağlantısında IP adresi kullanılamaz.** TLS, sunucu adının IP
olmasına izin vermez. `SQL_HOST` bir DNS adı olmalıdır. Ad çözümlemesi yoksa
`hosts` dosyasına kayıt ekleyin. Yapılandırma bunu erken ve anlaşılır bir hatayla
yakalar.

**Named instance portu dinamik olabilir.** SQL servisi her yeniden başladığında
port değişir ve uygulama sessizce kopar. Sabit port atayın veya `SQL_INSTANCE`
kullanın (o da SQL Browser'ın UDP 1434'ten erişilebilir olmasını gerektirir).

**Dil modeli kullanıcının tarayıcısında çalışır.** Sunucu yükü düşüktür ama
tarama hızı kullanıcının bilgisayarına bağlıdır. Büyük belgelerde dakikalar
sürebilir.

**Model dosyaları GitHub'ın dosya sınırına yakın.** `model_q4.onnx_data` 94 MB;
sert sınır 100 MB. Model büyürse Git LFS gerekir.

**Tarayıcı gereksinimi:** güncel Chrome veya Edge. WebAssembly ve ES2020
gerekiyor; Internet Explorer ve eski Edge çalışmaz.

---

## Bilinen açık konular

- **Çok çekirdekli NER kapalı.** `crossOriginIsolated` false olduğu için ONNX tek
  iş parçacığında çalışıyor; çok çekirdekli makinede tek çekirdek kullanılıyor.
  `Cross-Origin-Embedder-Policy` başlığı eklenince izolasyon açılıyor **ama NER hiç
  bulgu üretmiyor**; nedeni henüz bulunamadı. Bu yüzden başlık eklenmedi.
  Çözülürse büyük belgelerde 3-6× hızlanma bekleniyor.
- **Kullanıcı girişi ve denetim logu yok.** Şu an ağa erişen herkes kullanabilir.
  KVKK denetimi için "kim, ne zaman, hangi belgeyi maskeledi" kaydı gerekiyorsa
  kimlik doğrulama (tercihen Windows Integrated Authentication) eklenmelidir.
- **HTTPS yapılandırması eklenmedi.** Kurumun mevcut düzenine göre ya ters proxy
  arkasında çalışacak ya da sertifika doğrudan servise tanımlanacak.
- **`kurulum.ps1` gerçek Windows'ta denenmedi.** İlk kurulumda küçük düzeltme
  gerekebilir.

---

## Lisans ve model

NER modeli `akdeniz27/bert-base-turkish-cased-ner` temel alınarak q4 nicemlenmiş
ONNX biçimine dönüştürülmüştür (kaynak model kartındaki beyana göre MIT).
Model ve OCR dosyaları uygulama ile aynı kaynaktan yüklenir; çalışma anında
Hugging Face'e veya başka bir dış servise istek atılmaz (`env.allowRemoteModels = false`).
