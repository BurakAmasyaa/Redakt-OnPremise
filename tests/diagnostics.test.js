import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnostics } from "../server/src/diagnostics.js";

test("sayaçlar artar ve bilinmeyen ad yok sayılır", () => {
  const d = createDiagnostics();
  d.say("istek");
  d.say("istek", 4);
  d.say("olmayanSayac");
  assert.equal(d.anlik().sayaclar.istek, 5);
  assert.equal(d.anlik().sayaclar.olmayanSayac, undefined);
});

test("SQL durum değişimi yalnızca geçişte bildirilir", () => {
  const d = createDiagnostics();

  // İlk hata bir geçiştir: bildirilmeli.
  assert.equal(d.sqlBasarisiz("baglanti yok"), true);
  // Ardışık hatalar log'u boğmamalı.
  assert.equal(d.sqlBasarisiz("baglanti yok"), false);
  assert.equal(d.sqlBasarisiz("baglanti yok"), false);
  assert.equal(d.ardisikSqlHatasi, 3);
  assert.equal(d.sqlSaglikli, false);

  // Toparlanma da bir geçiştir: bildirilmeli.
  assert.equal(d.sqlBasarili(), true);
  // Sağlıklı durumdaki tekrarlar sessiz kalmalı.
  assert.equal(d.sqlBasarili(), false);
  assert.equal(d.ardisikSqlHatasi, 0);
  assert.equal(d.sqlSaglikli, true);
});

test("ilk başarı, önceden hata yoksa geçiş sayılmaz", () => {
  const d = createDiagnostics();
  assert.equal(d.sqlBasarili(), false, "açılışta gereksiz log yazılmamalı");
});

test("hata mesajı saklanır ama sınırsız büyümez", () => {
  const d = createDiagnostics();
  d.sqlBasarisiz("x".repeat(1000));
  assert.ok(d.anlik().sql.sonHataMesaji.length <= 300);
});

test("anlık durum izleme sisteminin okuyacağı alanları içerir", () => {
  let saat = 1_000_000;
  const d = createDiagnostics({ now: () => saat });
  saat += 5000;
  d.say("istek");
  d.sqlBasarisiz("hata");

  const durum = d.anlik({ kurallar: { adet: 10 } });
  assert.equal(durum.calismaSuresiSn, 5);
  assert.equal(durum.sayaclar.istek, 1);
  assert.equal(durum.sql.saglikli, false);
  assert.equal(durum.sql.ardisikHata, 1);
  assert.equal(durum.kurallar.adet, 10);
  assert.ok(Number.isFinite(durum.bellekMB));
  assert.match(durum.baslangic, /^\d{4}-\d{2}-\d{2}T/u);
});

test("zaman damgaları ISO biçiminde döner", () => {
  const d = createDiagnostics();
  d.sqlBasarisiz("hata");
  d.sqlBasarili();
  const { sql } = d.anlik();
  assert.match(sql.sonHata, /^\d{4}-\d{2}-\d{2}T.*Z$/u);
  assert.match(sql.sonBasari, /^\d{4}-\d{2}-\d{2}T.*Z$/u);
});
