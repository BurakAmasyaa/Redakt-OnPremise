// Fırlatılan şey her zaman bir Error değildir.
//
// Worker sınırını geçen hatalar ErrorEvent ya da düz nesne olarak gelir; bazı
// kütüphaneler (tesseract.js, pdf.js) worker'daki hatayı serileştirip olduğu
// gibi reddeder; kimi yerde düz bir dize fırlatılır. `instanceof Error`
// denetimine takılan her şey "bilinmeyen hata" ya da "Dosya okunamadı veya
// bozuk olabilir" diye gösteriliyordu. Sahada üç alt sistem aynı anda
// bozulduğunda kullanıcının elinde tek bir gerçek hata mesajı yoktu ve tanı
// konulamadı. Mesaj nerede duruyorsa oradan çıkarılır; geri kalan her şey
// yalnızca ayrıntısı olmayan bir yedek metindir.
export function describeError(error, fallback = "Beklenmeyen bir hata oluştu.") {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    // ErrorEvent: message + (filename, lineno) — worker betiği hiç yüklenemediğinde
    // gelen biçim budur ve tek ipucu dosya adıdır.
    if (typeof error.message === "string" && error.message.trim()) {
      const where = typeof error.filename === "string" && error.filename ? ` (${error.filename.split("/").pop()})` : "";
      return `${error.message.trim()}${where}`;
    }
    if (error.error) return describeError(error.error, fallback);
    if (error.reason) return describeError(error.reason, fallback);
    if (typeof error.name === "string" && error.name && error.name !== "Error") return error.name;
  }
  return fallback;
}

// Yakalanan değeri, mesajı korunmuş gerçek bir Error'a çevirir; üst katmanlar
// `error.name === "AbortError"` gibi denetimleri sürdürebilsin diye ad da taşınır.
export function toError(error, fallback) {
  if (error instanceof Error) return error;
  const normalized = new Error(describeError(error, fallback));
  if (error && typeof error === "object" && typeof error.name === "string") normalized.name = error.name;
  return normalized;
}
