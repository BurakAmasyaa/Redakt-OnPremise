# Redakt On-Premise · Kurulum

Bu paket şirket ağındaki bir Windows sunucuda çalışır ve maskeleme kurallarını
şirketin SQL Server veritabanından okur. **Kurulum sırasında internet erişimi
gerekmez**; Node çalışma zamanı, dil modeli ve tüm bağımlılıklar paketin içindedir.

Belgeler kullanıcının tarayıcısında işlenir, sunucuya yüklenmez. Sunucu yalnızca
uygulamayı ve kural listesini sunar.

## Paket içeriği

```
redakt-onprem\
  node.exe                        Windows Node çalışma zamanı
  app\                            Sunucu (tek dosyaya derlenmiş)
  web\                            Uygulama, dil modeli ve OCR dosyaları
  config\.env.example             Örnek yapılandırma
  logs\                           Servis kayıtları (kurulumda oluşur)
  kurulum.ps1                     Kurulum betiği
  redakt-check.cmd                Kurulum doğrulama
  redakt-encrypt-password.cmd     SQL parolası şifreleme
  redakt-start.cmd                Ön planda çalıştırma (sorun giderme)
```

## Gereksinimler

- Windows Server (x64)
- Yaklaşık 300 MB boş disk
- Servis için bir Windows hesabı (etki alanı hesabı önerilir)
- Sunucudan SQL Server'a ağ erişimi
- Kullanıcılardan bu sunucuya HTTP(S) erişimi

## Adımlar

### 1. Paketi kopyalayın

Klasörü sunucuya kopyalayın, örneğin `C:\Redakt`.

### 2. Kurulum betiğini çalıştırın

Yönetici PowerShell'de:

```powershell
powershell -ExecutionPolicy Bypass -File kurulum.ps1 -ServiceAccount "SIRKET\svc_redakt"
```

Betik şunları yapar: yapılandırma dosyasını oluşturur, `config` klasörünün
okuma iznini servis hesabı ve yöneticilerle sınırlar, açılışta başlayan bir
görev tanımlar ve güvenlik duvarında ilgili portu açar.

### 3. SQL parolasını şifreleyin

**Servis hesabıyla oturum açarak** çalıştırın:

```
redakt-encrypt-password.cmd
```

Parola Windows DPAPI ile şifrelenir; **yalnızca onu üreten hesap çözebilir**.
Çıkan `SQL_PASSWORD_ENC=...` satırını `config\.env` içine yazın ve düz metin
`SQL_PASSWORD` satırını silin.

> Betik başka bir hesapla çalıştırılırsa üretilen değer serviste çözülemez.

### 4. Yapılandırmayı doldurun

`config\.env` içinde en az şunlar:

| Ayar | Açıklama |
|---|---|
| `SQL_HOST` | SQL sunucusunun **DNS adı**. IP adresi kullanılamaz — şifreli bağlantıda TLS, sunucu adının IP olmasına izin vermez. |
| `SQL_PORT` veya `SQL_INSTANCE` | Sabit port önerilir. Named instance'ta port dinamikse SQL servisi her yeniden başladığında değişir. |
| `SQL_DATABASE` | Kural tablosunun bulunduğu veritabanı |
| `SQL_USER` | Yalnızca kural tablosunda `SELECT` yetkisi olan hesap |
| `SQL_PASSWORD_ENC` | 3. adımda üretilen şifreli değer |
| `SQL_TRUST_CERT` | `false` (önerilen). Kurum CA'sı imzalı sertifika yoksa geçici olarak `true`. |
| `HTTP_PORT` | Varsayılan 8080 |
| `AUTH_MODE` | `proxy` (önerilen) veya `none`. Aşağıya bakın. |
| `AUTH_TRUSTED_PROXIES` | İsteğin kabul edileceği adresler. Proxy aynı makinedeyse varsayılan yeterli. |

### 4b. Kimlik doğrulamayı kurun

`AUTH_MODE=none` bırakılırsa `/api/rules` **tüm kurumsal kural listesini
kimliksiz olarak** döner. O liste müşteri adları, proje kodları ve personel
isimlerinden oluşur — yani listenin kendisi korunması gereken bir varlıktır.
Ağdaki herhangi bir makine şunu çalıştırıp listeyi indirir:

```
curl http://sunucu:8080/api/rules
```

Önerilen kurulum: kimliği **ters proxy** doğrular, servis onun ilettiği başlığa
güvenir.

```
AUTH_MODE=proxy
AUTH_USER_HEADER=x-remote-user
AUTH_TRUSTED_PROXIES=127.0.0.1,::1
```

`AUTH_MODE=proxy` iken servis varsayılan olarak yalnızca `127.0.0.1` dinler:
kimlik kontrolü proxy'de yapıldığı için servisin dışarıdan doğrudan görünmemesi
gerekir. `HTTP_HOST` ile değiştirirseniz servis log'a uyarı yazar.

**IIS (Application Request Routing) tarafında iki ayar zorunludur:**

1. Site için **Windows Authentication** açık, **Anonymous Authentication** kapalı.
2. Proxy, istemciden gelen kimlik başlığını **silmeli** ve kendi doğruladığı
   kullanıcıyı yazmalı. `web.config` içinde:

```xml
<rewrite>
  <allowedServerVariables>
    <add name="HTTP_X_REMOTE_USER" />
  </allowedServerVariables>
  <rules>
    <rule name="Redakt">
      <match url="(.*)" />
      <serverVariables>
        <!-- Istemcinin gonderdigi deger her kosulda ezilir. -->
        <set name="HTTP_X_REMOTE_USER" value="{LOGON_USER}" />
      </serverVariables>
      <action type="Rewrite" url="http://127.0.0.1:8080/{R:1}" />
    </rule>
  </rules>
</rewrite>
```

nginx karşılığı:

```nginx
location / {
    auth_request       /auth;               # ya da kurumun SSO modülü
    proxy_set_header   X-Remote-User $remote_user;   # istemciden geleni ezer
    proxy_pass         http://127.0.0.1:8080;
}
```

> **Bu koşul serviste zorlanamaz.** Proxy başlığı silmezse, herhangi bir
> kullanıcı isteğine `X-Remote-User: baskasi` ekleyip başkası gibi görünür.
> Kurulumdan sonra mutlaka sınayın: proxy üzerinden sahte başlıkla istek atın,
> log'da kendi kullanıcı adınızın göründüğünü doğrulayın.

İzleme uçları (`/api/health`, `/api/ready`) kimlik istemez; izleme sistemi
kimlik başlığı gönderemediği için aksi hâlde servisi ölü sanardı. Bu uçlar
belge içeriği ya da kural metni döndürmez, yalnızca sayaç ve durum bilgisi.

### 5. Doğrulayın

```
redakt-check.cmd
```

Ağ erişimi, port, TLS, SQL bağlantısı, kural tablosu ve yetkileri sırayla
denetler; sorun varsa nedenini ve çözümünü yazar.

### 6. Başlatın

```powershell
Start-ScheduledTask -TaskName "Redakt-OnPremise"
```

Sunucu yeniden başladığında görev kendiliğinden çalışır.

## Kayıtlar

Tüm servis olayları `logs\redakt-YYYY-AA-GG.log` dosyalarına yazılır: başlatma,
SQL bağlantı durumu, kural yenileme, hatalar ve reddedilen istekler.
Varsayılan saklama süresi 30 gündür (`LOG_RETENTION_DAYS`).

**Belge içeriği ve bulunan isimler hiçbir koşulda log'a yazılmaz.**

## HTTPS

Paket varsayılan olarak HTTP dinler. Kurumsal kurulumda iki yol vardır:

1. **Ters proxy** (IIS, nginx, F5) — TLS orada sonlandırılır, sertifika
   yönetimi mevcut süreçle döner. Önerilen yol budur. Servis düz HTTP kalır ama
   yalnızca `127.0.0.1` dinler, yani ağdan doğrudan erişilemez.
2. **Doğrudan TLS** — sertifika servise tanımlanır:

```
HTTPS_CERT=..\config\redakt.crt
HTTPS_KEY=..\config\redakt.key
#HTTPS_CA=..\config\kurum-ca.crt
```

İkisi birlikte verilmelidir; yalnızca biri verilirse servis anlaşılır bir
hatayla durur. Sertifika tanımlıysa servis `Strict-Transport-Security`
başlığını da gönderir.

Hiçbiri yapılmazsa kural listesi ağda düz metin geçer.

## Sorun giderme

| Belirti | Bakılacak yer |
|---|---|
| Servis açılmıyor | `logs\` içindeki son dosya; `redakt-start.cmd` ile ön planda çalıştırıp hatayı görün |
| "Kurallar yüklenemedi" | `redakt-check.cmd` çıktısı |
| Parola çözülemiyor | Şifreli değer servis hesabından farklı bir hesapla üretilmiş olabilir; 3. adımı tekrarlayın |
| Kullanıcılar erişemiyor | Güvenlik duvarı kuralı ve DNS kaydı |

## Güncelleme

`app\` ve `web\` klasörlerini yeni sürümle değiştirip görevi yeniden başlatın.
`config\` ve `logs\` klasörlerine dokunmayın.
