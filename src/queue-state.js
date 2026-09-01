// Kuyruğun "bir sonraki ne taranacak" kararı.
//
// Tarama başarısız olduğunda dosya kuyrukta "error" durumunda kalıyor, sıradaki
// iş arayan kod ise yalnızca "queued" dosyalara bakıyordu. Sonuç: kullanıcı
// hatayı düzeltiyor, "Belgeyi tara" düğmesine basıyor ve hiçbir şey olmuyordu.
// Tek çıkış yolu sayfayı yenilemekti. Karar buraya alındı ki geri gelmesin.

export const SCANNABLE_STATUS = "queued";
export const RETRYABLE_STATUSES = Object.freeze(["error"]);

export function hasScannableItem(queue) {
  return queue.some((item) => item.status === SCANNABLE_STATUS);
}

export function itemsToRequeue(queue) {
  return queue.filter((item) => RETRYABLE_STATUSES.includes(item.status));
}

// Yeniden denemeden sonra taranacak bir şey kaldı mı: hepsi tamamlanmışsa
// düğme boşuna çalışmamalı.
export function canStartScan(queue) {
  return queue.length > 0 && (hasScannableItem(queue) || itemsToRequeue(queue).length > 0);
}
