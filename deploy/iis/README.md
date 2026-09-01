# IIS ters proxy ve erişim kontrolü

Bu klasördeki iki dosya, Redakt'ı IIS arkasında **kimlik doğrulamalı** çalıştırmak
içindir. `AUTH_MODE=proxy` bu iki dosya olmadan kurulamaz: servis kimliği kendisi
doğrulamaz, ters proxy'nin ilettiği başlığa güvenir.

```
web.config                      TLS sonlandırma, HTTP→HTTPS, ters proxy kuralları
App_Code\HeaderInjectorModule.cs  Windows kullanıcısını X-Remote-User başlığına yazar
```

## Kurulum

1. Her iki öğeyi de IIS sitesinin **kök klasörüne** kopyalayın (paket
   `C:\inetpub\wwwroot\Redakt` altındaysa `web.config` ve `App_Code\` oraya gider).
   Site fiziksel yolu paketin kökü olmalıdır — `iis` alt klasörü gösterilirse
   IIS kendi 404 sayfasını döner.
2. Site için **Windows Authentication** açık, **Anonymous Authentication** kapalı.
3. Uygulama havuzu: **.NET CLR v4.0**, **Integrated** (App_Code çalışma anında
   derlenir; derleyici kurmanız gerekmez).
4. URL Rewrite 2.1 + ARR 3.0 kurulu ve ARR'da **proxy enabled**.
5. Server variable kilidini bir kez açın (sunucu geneli):

   ```
   %windir%\system32\inetsrv\appcmd.exe unlock config -section:system.webServer/rewrite/allowedServerVariables
   ```

6. `config\.env` içinde:

   ```
   AUTH_MODE=proxy
   AUTH_USER_HEADER=x-remote-user
   AUTH_TRUSTED_PROXIES=127.0.0.1,::1
   HTTP_HOST=127.0.0.1
   ```

## Neden bir modül var

URL Rewrite'in `{LOGON_USER}` değişkeni kural çalıştığı anda (BeginRequest)
**henüz boştur**. `serverVariables` ile yazılan başlık bu yüzden boş gider ve
servis her isteği "kimlik başlığı yok" diye reddeder. Modül
`PostAuthenticateRequest` aşamasında çalışır; kimlik orada dolmuştur.

Modül, istemcinin gönderdiği `X-Remote-User` başlığını **her koşulda** ezer.
Kimlik doğrulanamazsa başlığı boşaltır. Servisin güvenliği buna bağlıdır.

## Doğrulama

Kurulumdan sonra proxy üzerinden sahte başlıkla istek atın; log'da **kendi**
kullanıcı adınız görünmelidir:

```powershell
curl.exe -k -u SIRKET\kullanici: --ntlm -H "X-Remote-User: baskasi" https://redakt.sirket.local/api/rules
```

## Sık karşılaşılanlar

| Belirti | Neden |
|---|---|
| HTTP 500, "not well-formed XML" | `web.config` yorumunda ardışık tire (`--`) var |
| HTTP 500.52 | `HTTP_X_REMOTE_USER` hem burada hem applicationHost.config'de tanımlı |
| "server variable ... not allowed" | 5. adımdaki `appcmd unlock` yapılmamış |
| Servis 401 döndürüyor, log'da kimlik yok | `App_Code` kopyalanmamış ya da app pool Integrated değil |
| IIS'in 404 sayfası | Site fiziksel yolu paketin kökünü göstermiyor |
