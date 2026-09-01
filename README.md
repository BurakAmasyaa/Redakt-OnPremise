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

**Model nerede duruyor.** Dil modeli (~147 MB) ilk taramada sunucudan bir kez
indirilir ve kullanıcının tarayıcı profilinin Cache Storage deposunda
(`transformers-cache`) kalır. Cihazdan çıkmaz, sunucuya geri gitmez, başka bir
tarayıcı profiline taşınmaz. Tarama ekranı bunu — kaynak adres, boyut ve indirilip
indirilmediği — açıkça yazar ve **Cihazdan kaldır** düğmesiyle silmeyi sunar.

Bu sınır kodda gevşetilmemesi gereken bir kuraldır ve testle korunur
([tests/privacy.test.js](tests/privacy.test.js)): belgeyi işleyen 16 modülde ağ
erişimi ve kalıcı depolama yasaktır, ağ erişimi yalnızca
[src/rule-source.js](src/rule-source.js) içinde bulunabilir ve orada da tek
yönlüdür — gövdesiz `GET`, yalnızca `/api/rules`.

---

## Ne bulur

Üç bağımsız katman çalışır:

| Katman | Bulduğu | Nasıl |
|---|---|---|
| **Kesin** | E-posta, IBAN, T.C. Kimlik No, kredi kartı | Regex + doğrulama (IBAN mod-97, TCKN 10./11. hane, kart Luhn) |
| **Alan etiketi** | Ad, soyad, baba adı, doğum yeri, adres, adres/cilt/dosya/sicil no | Belgenin kendi etiketi (`Adı :`, tablo hücresi, Excel sütun başlığı) |
| **Muhtemel** | Kişi adı, kurum/şirket, adres-konum, telefon | Yerel Türkçe BERT NER modeli, güven puanıyla |
| **Kurumsal** | Şirkete özel isimler, proje kodları, müşteri unvanları | SQL'deki kural tablosu |

Alan etiketi katmanı modelden bağımsız ve deterministiktir. Resmî evrakta bilgi
cümle içinde değil, etiketin karşısında ve büyük harfle durur (`Adı : KEREM`);
dil modeli bu biçimi kötü okur. Etiketin ne olduğunu belgenin kendisi söylediği
için bu alanlar model hiç çalışmasa da bulunur. Etiket dört biçimde aranır:

| Biçim | Nerede | Nasıl bulunur |
|---|---|---|
| `Adı : KEREM` | Her belge türü | Aynı satırda, iki nokta zorunlu |
| `Adı` \| `:` \| `KEREM` | Word tablosu | Komşu hücreler |
| Sütun başlığı | Excel, Word tablosu | Hücre koordinatı (`C4`, tablo/satır/sütun) |
| Sütun başlığı | PDF | Kaydın sayfa üzerindeki x konumu |

Sütun başlığı yalnızca başlığın kendisi bir alan adıysa çalışır: `Adres No`
sütunu maskelenir, `Tutar` sütununa dokunulmaz. Aşırı maskeleme de bir arızadır
— tablodan sonra gelen düz metin satırı sütun değeri sayılmaz, "Web adresi" ya
da "IP adresi" bir yer sayılmaz, sütununun başlığı alan adı olmayan hücre de
komşusunun etiketi sayılmaz.

Bulguların tamamı seçili gelir. NER bulguları ayrı bir **"Muhtemel"** grubunda
model güven puanıyla listelenir — model yanılabildiği için kullanıcı bunları
gözden geçirip seçimini kaldırabilir.

Model teknik metni Türkçe düzyazı gibi okur: bir T-SQL dokümanında kolon adları,
veri tipleri ve anahtar kelimeler düzenli olarak kişi/kurum diye işaretlenir
(`nvarchar`, `RETURN`, `STG`). Bunlar iki ayrı zarar üretir — liste kirlenir ve
maskelenirlerse belge işlevini kaybeder. [src/technical-noise.js](src/technical-noise.js)
bunları eler: terimin kendisi (kesin liste) ve terimin bulunduğu satırın kod olup
olmadığı (bağlam) birlikte değerlendirilir. Bağlam ayağı, listeye giremeyecek
projeye özgü kısaltmaları da yakalar.

Model bir sözcüğün yalnız bir parçasını etiketleyebilir (`Agent` → `Ag`); varlık
aralığı daima sözcük sınırına taşınır, yoksa listede anlamsız bir öge görünür ve
maskelemeden sonra sözcüğün kalanı belgede kalırdı. Eşleşme büyük/küçük harfe de
takılmaz: modelin bir yerde yakaladığı `LEAF`, başka bir yerdeki `Leaf` ile aynı
addır.

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

**Dosya adı da bir tarama birimidir.** `Kerem Aydın ikametgah.pdf` belgesinin içi
maskelenip adı olduğu gibi kalırsa, dosya paylaşıldığı anda maskeleme boşa
çıkar. Ad; desenler, kendi kuralların, kurumsal kurallar ve modelle aynı
şekilde taranır ve çıktı adı aynı yer tutucularla yazılır
(`[KİŞİ_1] ikametgah_redakte.pdf`). Eşleştirme dosyasının adı da bundan
türetilir.

Sayfa adı maskelenirken Excel'in ad kurallarına uydurulur (yasak karakterler,
31 karakter sınırı) ve ona yapılan formül başvuruları birlikte güncellenir.
Önbellek değeri maskelenip formül el değmeden kalırsa Excel dosyayı açtığında
orijinali geri hesaplar; bu durumda formül düşürülür.

Üç tarama seviyesi var — Hızlı, Dengeli, Kapsamlı. Değiştirdikleri iki şey var:
metnin kaç karakterlik parçalar hâlinde modele verildiği ve parçaların ne kadar
**bindiği** (overlap), bir de taranmış sayfaların OCR çözünürlüğü (150 / 200 /
300 DPI). Bindirme, parça sınırına denk gelen adın kaybını önler.

Bulgu listesindeki kullanım sayısı, maskelemenin gerçekten yapacağı değişiklik
sayısıdır: sayım, maskelemenin kendi çakışma çözümleme fonksiyonuyla yapılır ve
**seçim her değiştiğinde yeniden hesaplanır**. Öncelikli bir kuralın seçimi
kaldırıldığında onun kapsadığı bulgu yeniden devreye girer ve sayı bunu anında
yansıtır. `0` gösteren bir bulgu, o değerin şu anki seçimde başka bir kuralın
kapsamında olduğu anlamına gelir.

### Eşleştirme neyi "aynı değer" sayar

İki yazımın aynı değer olup olmadığına tek yerden karar verilir
([src/text-match.js](src/text-match.js)). Eşleşme şunları gözetmez:

| Gözetilmeyen | Neden |
|---|---|
| Büyük/küçük harf | Belge "KEREM" der, kural "Kerem" yazar |
| Nokta ayrımı (I/İ/ı/i) | Excel `UPPER()` ve İngilizce klavye "Melis"i "MELIS" yapar |
| Diyakritik (ş/ğ/ü/ö/ç/â) | Türkçe belgede diyakritiksiz yazım olağandır |
| Ayrışık yazım (NFD) | Word ve bazı PDF'ler harfi taban + birleştirici işaret yazar |
| Görünmez karakterler | Yumuşak tire, ZWJ/ZWNJ/ZWSP, bidi işaretleri |

Bunların her biri, eşleşmeyi kopardığında aynı adı belgenin bir yarısında
maskesiz bırakıyordu. Sözcük sınırı yine korunur: "Ali" kuralı "kalite"nin
içini yakalamaz, ayrışık yazımda bile.

Desenler de aynı gözle bakar: telefon ve kart numarasında kırılmaz boşluk
(U+00A0) ve tipografik tire ayırıcı sayılır — Word/Excel kopyalamasının
standart çıktısı budur ve ASCII sınıf bunları görmediği için gözle normal
görünen numaralar taramaya hiç girmiyordu.

Model ve alan etiketi bulguları belgenin **tamamında** aranır. Eskiden yalnızca
bulundukları birime uygulanıyorlardı; XLSX her hücreyi ayrı birim saydığı için
bir hücrede bulunan ad başka hücrede maskesiz kalabiliyordu.

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
cd server && npm install && cd ..
npm run package
```

`server/` kendi `package.json`'ına sahiptir ve `mssql` yalnızca orada bulunur;
paketleyici sunucuyu bağımlılıklarıyla tek dosyaya derlediği için bu kurulum
atlanırsa derleme "mssql çözülemedi" diye düşer.

Çıktı `package/` klasörüne yazılır (~209 MB; büyük kısmı dil modeli ve OCR dosyaları).
Windows çalışma zamanını da eklemek için `node server/build-package.mjs --fetch-node`.
Pakete IIS ters proxy + erişim kontrolü şablonu da girer (`iis\`, kaynağı
[deploy/iis](deploy/iis)).

---

## Redakt Guard — tarayıcı eklentisi

Aynı maskeleme hattını ikinci bir tetikleyiciye bağlar: çalışan ChatGPT, Claude,
Gemini veya Copilot arayüzüne bir belge sürüklediğinde dosya **uygulamanın
JavaScript'ine ulaşmadan** durdurulur, cihazda taranır, maskelenir ve yalnızca
maskelenmiş kopya yüklenir. Dosya yine hiçbir sunucuya gitmez.

Prompt metni de kapsanır: yapıştırılan ve gönderilen metin kutuyu terk etmeden
taranır. Bulgu yoksa akış hiç kesilmez; bulunanların tamamı kullanıcıya
sorulmadan maskelenir. Eksik tarama, açılamayan tür veya motor hatası ham veriye
düşmez, gönderimi durdurur.

Her başarılı maskeleme için sunucuya yalnız kullanıcı kimliğiyle ilişkilendirilen
kategori/adet özeti yazılır; kullanıcı adı güvenilen ters proxy'den gelir.
Dosya adı, gerçek bulgu değerleri ve prompt audit gövdesine alınmaz.

```bash
npm run build:guard
```

Kurulum, mimari ve kapsam dışı kalanlar: **[guard/README.md](guard/README.md)**

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
| `TamEslesme` | `1` yapılan kural bulanık eşleşmez (isteğe bağlı kolon) |
| `Notlar` | Serbest açıklama |

Uygulama yalnızca `Aktif = 1` olan satırları okur.

Yeni kural eklendiğinde: sunucu değişikliği en geç bir dakika içinde görür
(`RULES_CACHE_TTL_MS`), ancak tarayıcı kural listesini **sayfa açılışında** çeker.
Sayfası zaten açık olan kullanıcı için yeni kural, sayfayı yenilediğinde veya
kural panelindeki **"Yenile"** düğmesine bastığında etkili olur.

**Eşleştirme büyük/küçük harfe duyarsızdır** ve Türkçe karakter varyantlarını
eşdeğer sayar (`Şen` ≈ `Sen`). Ayrıca yazım hatası tolere eder ve **bu toleransın
bedeli vardır**: tolerans kelime uzunluğuna göre ölçeklenir —

| Kelime uzunluğu | Tolerans | Sonuç |
|---|---|---|
| 5 harften kısa | 0 | `Ak` kuralı yalnızca `Ak`'ı yakalar |
| 5–7 harf | 1 harf | `Siskon` kuralı `Diskon`'u da yakalar |
| 8 harf ve üzeri | 2 harf | `ALFA-2026` kuralı `ALFA-2027`'yi de yakalar |

Kısa marka ve kod adlarında bu gevşeklik belgeyi sessizce bozar: bir otomasyon
belgesinde geçen her `piston` şirket adı sanılabilir. Birebir eşleşmesi gereken
kurallarda `TamEslesme = 1` yapın — o kural artık hiç bulanıklaşmaz, ama büyük-küçük
harf ve Türkçe karakter esnekliğini korur.

```sql
ALTER TABLE dbo.RedaktKurallari ADD TamEslesme bit NOT NULL DEFAULT 0;
UPDATE dbo.RedaktKurallari SET TamEslesme = 1 WHERE AranacakIfade IN (N'Siskon', N'ALFA-2026');
```

Kolon yoksa uygulama eskisi gibi çalışır (tüm kurallar bulanık). `redakt-check`
kolonun var olup olmadığını ve riskli kısa kuralları listeler.

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

---

## Erişim kontrolü

`/api/rules` **tüm kurumsal kural listesini** döner. O liste müşteri adları,
proje kodları ve personel isimlerinden oluşur — yani listenin kendisi korunması
gereken bir varlıktır. Bu yüzden kimlik doğrulama kapalıyken servis her açılışta
log'a uyarı yazar.

Kimliği **ters proxy** (IIS / nginx) doğrular, servis onun ilettiği başlığa
güvenir. Kurumsal Windows ortamında Windows Integrated Authentication zaten orada
yapılır; servise ek bağımlılık girmez.

```
AUTH_MODE=proxy
AUTH_USER_HEADER=x-remote-user
AUTH_TRUSTED_PROXIES=127.0.0.1,::1
```

Servis iki koşulu birden zorlar: istek güvenilen bir adresten gelmeli **ve**
kimlik başlığı dolu olmalı. Değilse `403` / `401` döner ve uygulama hiç açılmaz.
`AUTH_MODE=proxy` iken servis varsayılan olarak yalnızca `127.0.0.1` dinler.

Üçüncü koşulu ise yalnızca proxy sağlayabilir: **istemciden gelen kimlik
başlığını silmeli.** Silmezse herhangi bir kullanıcı isteğine
`X-Remote-User: baskasi` ekleyip başkası gibi görünür. Bu kodla zorlanamaz;
IIS ve nginx örnekleri [kurulum belgesinde](server/scripts/KURULUM.md).

IIS tarafı elle yazılmaz: `web.config` ve kimlik başlığını yazan modül
[deploy/iis](deploy/iis) altında hazır gelir ve pakete `iis\` olarak kopyalanır.
Başlığı URL Rewrite ile yazmak **çalışmaz** — `{LOGON_USER}` kural çalıştığında
(BeginRequest) henüz boştur, servis her isteği kimliksiz sayar. Şablondaki
`HeaderInjectorModule` kimlik doğrulamadan sonra (`PostAuthenticateRequest`)
çalışır ve istemciden gelen başlığı her koşulda ezer.

İzleme uçları (`/api/health`, `/api/ready`) kimlik istemez — izleme sistemi
kimlik başlığı gönderemediği için aksi hâlde servisi ölü sanardı. Bu uçlar kural
metni döndürmez, yalnızca sayaç ve durum.

**HTTPS.** `HTTPS_CERT` + `HTTPS_KEY` verilirse servis doğrudan TLS ile dinler ve
`Strict-Transport-Security` gönderir. Verilmezse düz HTTP kalır ve TLS'i ters
proxy üstlenir. İkisi de geçerli kurulumdur; hiçbiri yapılmazsa kural listesi
ağda düz metin geçer.

---

## Kayıt ve disk

**Disk koruması.** Log dosyaları hem günlük hem boyut sınırına göre bölünür
(`LOG_MAX_FILE_MB`) ve klasörün toplam boyutu aşılırsa en eski dosyalar silinir
(`LOG_MAX_TOTAL_MB`). Bir hata döngüsü diski dolduramaz. Yazılmakta olan dosya
temizlikte hiçbir zaman silinmez.

> İzleme uçları kimlik doğrulama açıkken de korumasızdır — bu bilinçli bir
> tercihtir, izleme sistemi kimlik başlığı gönderemez. Kural metni dönmezler ama
> `/api/ready` SQL hata mesajını yansıtır ve o mesaj sunucu adını içerebilir.
> Hassassa ters proxy'de bu iki yolu kaynak IP ile sınırlayın.

## Geliştirme

```bash
npm install          # bağımlılıklar
npm run dev          # tarayıcı uygulaması (vite, 127.0.0.1:5173)
npm test             # 211 test
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
  src/auth.js           Ters proxy kimlik doğrulaması
  src/check.js          Kurulum doğrulama aracı
  scripts/              kurulum.ps1 ve KURULUM.md

deploy/iis/   IIS ters proxy şablonu (web.config + kimlik başlığı modülü)

public/models/   Türkçe NER modeli (~150 MB)
public/ocr/      Tesseract dil dosyaları (~31 MB)
tests/           211 test
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
- **Belge düzeyinde KVKK denetim izi yok.** Log "kim, ne zaman kural listesini
  çekti"yi yazar; "kim, hangi belgeyi maskeledi"yi yazmaz. Yazabilmesi için
  tarayıcının sunucuya belge adı ve bulgu sayısı göndermesi gerekirdi — bu da
  ürünün temel sınırını ("belge tarayıcıdan çıkmaz") gevşetirdi. Bilerek
  yapılmadı; gerekiyorsa bilinçli bir karar olarak ele alınmalıdır.
- **Bulanık eşleşme 5–7 harfli kurallarda hâlâ 1 harf tolere eder.** `Siskon`
  kuralı `Diskon`'u yakalar. Birebir eşleşmesi gerekenlerde `TamEslesme = 1`
  kullanın; `redakt-check` riskli kuralları listeler.
- **Tanımlı ad (defined name) *etiketleri* maskelenmez.** Excel'de bir tanımlı adın
  kendisi kişi adı taşıyorsa (`Ahmet_Bakiye`) formül metni maskelenir ama etiketin
  kendisi kalır — yeniden adlandırma tüm formül başvurularını bozma riski taşıyor.
  Etiketler e-posta veya boşluk içeremediği için pratikte dar bir durum.
- **`kurulum.ps1` gerçek Windows'ta denenmedi.** İlk kurulumda küçük düzeltme
  gerekebilir. İlk saha kurulumunda görev, betik yerine elle tanımlandı.
- **IIS modülü gelen istek başlıklarını yansımayla açar.** ASP.NET başlık
  koleksiyonunu salt okunur tutar; `HeaderInjectorModule` `IsReadOnly` bayrağını
  yansıma ile kapatıp başlığı yazar ve **geri kilitlemez** (ASP.NET kendi
  senkronizasyonunda koleksiyonu tekrar yazdığı için kilitli bırakmak istisnaya
  yol açıyor). Belgelenmemiş bir iç yapıya dayanır; .NET Framework sürümü
  değişirse şablonun sınanması gerekir. Modül yalnızca `X-Remote-User`
  başlığına dokunur.
- **IIS şablonu Kerberos yerine NTLM kullanıyor.** Ters proxy arkasındaki
  loopback istekte Negotiate/Kerberos SPN doğrulamasına takıldığı için sağlayıcı
  listesi NTLM'e sabitlendi. Kimlik yine etki alanında doğrulanır; Kerberos'un
  sorunsuz çalıştığı ortamda `web.config` içinde Negotiate eklenebilir.

---

## Lisans ve model

Yazılım tescillidir ve şirket içi kullanım için lisanslanır; koşullar
[LICENSE](LICENSE) dosyasındadır.

NER modeli `akdeniz27/bert-base-turkish-cased-ner` temel alınarak q4 nicemlenmiş
ONNX biçimine dönüştürülmüştür (kaynak model kartındaki beyana göre MIT).
Model ve OCR dosyaları uygulama ile aynı kaynaktan yüklenir; çalışma anında
Hugging Face'e veya başka bir dış servise istek atılmaz (`env.allowRemoteModels = false`).
