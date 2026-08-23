import { execFileSync } from "node:child_process";

// SQL Server login kullanıldığında şifre VM üzerinde durmak zorunda.
// Windows DPAPI ile şifrelenirse, çözebilen tek hesap onu şifreleyen
// hesaptır — yani servisin çalıştığı hesap. Dosyayı okuyabilen başka
// biri (yedek operatörü, yanlış ACL) düz metni göremez.
//
// Şifreleme PowerShell'in ConvertFrom-SecureString komutuyla yapılır;
// çözme de aynı mekanizmadadır. Ek bir yerel modül gerekmediği için
// internet erişimi olmayan makinede de sorunsuz kurulur.

const POWERSHELL_DECRYPT = `
$ErrorActionPreference = 'Stop'
$blob = [Console]::In.ReadToEnd().Trim()
$secure = ConvertTo-SecureString $blob
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringAuto($pointer)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
`;

const POWERSHELL_ENCRYPT = `
$ErrorActionPreference = 'Stop'
$plain = [Console]::In.ReadToEnd().Trim()
[Console]::Out.Write((ConvertTo-SecureString $plain -AsPlainText -Force | ConvertFrom-SecureString))
`;

function runPowerShell(script, input, { execFile = execFileSync } = {}) {
  if (process.platform !== "win32") {
    throw new Error("Şifrelenmiş parola yalnızca Windows üzerinde çözülebilir (DPAPI). Geliştirme ortamında SQL_PASSWORD kullanın.");
  }
  return execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input,
    encoding: "utf8",
    windowsHide: true,
  });
}

export function decryptSecret(blob, options = {}) {
  const trimmed = String(blob || "").trim();
  if (!trimmed) throw new Error("Şifrelenmiş parola boş.");
  try {
    const plain = runPowerShell(POWERSHELL_DECRYPT, trimmed, options);
    if (!plain) throw new Error("Çözülen parola boş döndü.");
    return plain;
  } catch (error) {
    if (/yalnızca Windows/u.test(error.message)) throw error;
    throw new Error(
      "SQL_PASSWORD_ENC çözülemedi. Şifreli parola, servisin çalıştığı Windows hesabıyla üretilmiş olmalıdır. " +
      "Hesap değiştiyse parolayı o hesapla yeniden şifreleyin.",
    );
  }
}

export function encryptSecret(plain, options = {}) {
  const trimmed = String(plain || "").trim();
  if (!trimmed) throw new Error("Şifrelenecek parola boş.");
  return runPowerShell(POWERSHELL_ENCRYPT, trimmed, options).trim();
}

// SQL_PASSWORD_ENC varsa o kullanılır; yoksa düz SQL_PASSWORD'a düşülür.
export function resolvePassword(environment = process.env, { logger, ...options } = {}) {
  if (environment.SQL_PASSWORD_ENC) {
    const plain = decryptSecret(environment.SQL_PASSWORD_ENC, options);
    logger?.info("SQL parolası şifreli yapılandırmadan çözüldü", { kaynak: "SQL_PASSWORD_ENC" });
    return plain;
  }
  if (environment.SQL_PASSWORD) {
    logger?.warn("SQL parolası yapılandırmada düz metin duruyor", {
      oneri: "npm run encrypt-password ile SQL_PASSWORD_ENC üretin",
    });
    return environment.SQL_PASSWORD;
  }
  throw new Error("Yapılandırma eksik: SQL_PASSWORD veya SQL_PASSWORD_ENC. server/.env dosyasını doldurun.");
}
