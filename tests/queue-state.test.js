import assert from "node:assert/strict";
import test from "node:test";
import { canStartScan, hasScannableItem, itemsToRequeue } from "../src/queue-state.js";

const queue = (...statuses) => statuses.map((status, index) => ({ id: `q_${index}`, status }));

// Tarama başarısız olunca dosya "error" durumunda kalıyor, sıradaki işi arayan
// kod yalnızca "queued" bakıyordu: kullanıcı hatayı düzeltip düğmeye basıyor,
// hiçbir şey olmuyor, tek çıkış yolu sayfayı yenilemek oluyordu.
test("hata almış dosya yeniden denenebilir", () => {
  const failed = queue("error");
  assert.equal(hasScannableItem(failed), false, "doğrudan taranabilir görünmemeli");
  assert.equal(canStartScan(failed), true, "yeniden deneme engellendi");
  assert.deepEqual(itemsToRequeue(failed).map((item) => item.id), ["q_0"]);
});

test("kullanıcının durdurduğu dosya sırada bekler", () => {
  // İptal, dosyayı hataya düşürmez; doğrudan yeniden başlatılabilir kalır.
  assert.equal(hasScannableItem(queue("queued")), true);
  assert.equal(canStartScan(queue("queued")), true);
});

test("tamamlanmış kuyrukta düğme boşuna çalışmaz", () => {
  assert.equal(canStartScan(queue("done", "done")), false);
  assert.equal(canStartScan([]), false);
  assert.deepEqual(itemsToRequeue(queue("done", "processing")), []);
});

test("karışık kuyrukta hem bekleyen hem hatalı dosya işlenir", () => {
  const mixed = queue("done", "error", "queued", "error");
  assert.equal(canStartScan(mixed), true);
  assert.deepEqual(itemsToRequeue(mixed).map((item) => item.id), ["q_1", "q_3"]);
});
