import readline from "node:readline";
import { encryptSecret } from "./secret.js";

// Bu araç, servisin çalışacağı Windows hesabıyla ÇALIŞTIRILMALIDIR.
// DPAPI ile şifrelenen değeri yalnızca aynı hesap çözebilir.

if (process.platform !== "win32") {
  console.error("Bu araç yalnızca Windows üzerinde çalışır (DPAPI).");
  console.error("Geliştirme ortamında server/.env içinde SQL_PASSWORD kullanın.");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

console.log("Redakt · SQL parolası şifreleme");
console.log("");
console.log("UYARI: Bu aracı, Redakt servisinin çalışacağı Windows hesabıyla çalıştırın.");
console.log("Başka bir hesapla üretilen değer serviste çözülemez.");
console.log(`Şu anki hesap: ${process.env.USERDOMAIN || "?"}\\${process.env.USERNAME || "?"}`);
console.log("");

// Girdi ekranda görünmesin.
const originalWrite = rl._writeToOutput?.bind(rl);
let masking = false;
rl._writeToOutput = function write(value) {
  if (masking) return;
  originalWrite?.(value);
};

rl.question("SQL parolası: ", (answer) => {
  masking = false;
  console.log("");
  rl.close();
  try {
    const blob = encryptSecret(answer);
    console.log("Aşağıdaki satırı server/.env dosyasına ekleyin ve SQL_PASSWORD satırını silin:");
    console.log("");
    console.log(`SQL_PASSWORD_ENC=${blob}`);
    console.log("");
    console.log("Ardından .env dosyasının izinlerini yalnızca servis hesabı ve yöneticiler okuyacak şekilde kısıtlayın.");
  } catch (error) {
    console.error(`Şifreleme başarısız: ${error.message}`);
    process.exit(1);
  }
});
masking = true;
