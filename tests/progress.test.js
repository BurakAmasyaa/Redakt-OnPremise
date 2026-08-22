import assert from "node:assert/strict";
import test from "node:test";
import { createProgressTracker, formatRemaining, unitLabel } from "../src/progress.js";

test("gerçek batch sayacı yüzdeyi doğrudan sürer; fazlar arası ağırlıklandırma yapılmaz", () => {
  let time = 0;
  const updates = [];
  const tracker = createProgressTracker((value) => updates.push(value), () => time);
  time = 1000;
  tracker.start("detecting", 4179);
  time = 2000;
  const first = tracker.advance(1240);
  assert.equal(first.completedUnits, 1240);
  assert.equal(first.totalUnits, 4179);
  assert.equal(Math.round(first.progress * 1000) / 1000, Math.round((1240 / 4179) * 1000) / 1000);
  assert.equal(first.unitLabel, unitLabel("detecting"));
});

test("aynı fazda ilerleme geriye sıçramaz (monotonik)", () => {
  let time = 0;
  const tracker = createProgressTracker(null, () => time);
  tracker.start("ocr", 10);
  time = 100;
  tracker.advance(6);
  time = 200;
  const regressed = tracker.advance(3);
  assert.equal(regressed.completedUnits, 6, "daha düşük bir değer ilerlemeyi geri almamalı");
  time = 300;
  const forward = tracker.advance(9);
  assert.equal(forward.completedUnits, 9);
});

test("OCR gibi alt adımlı işlerde kesirli gerçek ilerlemeyi korur", () => {
  let time = 0;
  const tracker = createProgressTracker(null, () => time);
  tracker.start("ocr", 2);
  time = 100;
  const halfway = tracker.advance(0.45);
  assert.equal(halfway.completedUnits, 0.45);
  assert.equal(halfway.progress, 0.225);
  time = 200;
  const forward = tracker.advance(1.2);
  assert.equal(forward.completedUnits, 1.2);
  time = 300;
  const regressed = tracker.advance(0.8);
  assert.equal(regressed.completedUnits, 1.2, "OCR yüzdesi geriye sıçramamalı");
});

test("faz değişimi kendi gerçek toplamıyla dürüstçe sıfırlanır, önceki fazla karışmaz", () => {
  let time = 0;
  const tracker = createProgressTracker(null, () => time);
  tracker.start("extracting", 1);
  time = 50;
  tracker.advance(1);
  time = 60;
  const started = tracker.start("detecting", 4179);
  assert.equal(started.completedUnits, 0);
  assert.equal(started.totalUnits, 4179);
  assert.equal(started.progress, 0);
});

test("yetersiz örnekte ETA göstermez; en az birkaç batch sonra son 5 örneğin ortalamasını kullanır", () => {
  let time = 0;
  const tracker = createProgressTracker(null, () => time);
  tracker.start("detecting", 10000);
  time = 1000;
  const first = tracker.advance(100);
  assert.equal(first.estimatedRemainingMs, undefined, "ilk örnekte tahmin yapılmamalı");

  time = 2000;
  const second = tracker.advance(200);
  assert.equal(second.estimatedRemainingMs, undefined, "tek aralıkla hâlâ güvenilir tahmin yok");

  time = 3000;
  const third = tracker.advance(300);
  // Ortalama hız: 300 item / 3000 ms = 10 ms/item; kalan (10000-300) item.
  assert.equal(third.estimatedRemainingMs, (10000 - 300) * 10);
  assert.equal(formatRemaining(third.estimatedRemainingMs), "Kalan süre: ~1 dk 37 sn");
});

test("yalnızca son 5 batch'i pencereye alır; eski örnekler ortalamayı etkilemez", () => {
  let time = 0;
  const tracker = createProgressTracker(null, () => time);
  tracker.start("detecting", 10000);
  // İlk yavaş bir sıçrama (1000ms'de 10 öğe), ardından istikrarlı hızlı örnekler.
  time = 1000;
  tracker.advance(10);
  time = 1100;
  tracker.advance(20);
  time = 1200;
  tracker.advance(30);
  time = 1300;
  tracker.advance(40);
  time = 1400;
  tracker.advance(50);
  time = 1500;
  const result = tracker.advance(60);
  // Pencere en fazla son 5 gerçek advance()'i tutar (start()'ın 0'ı düşer).
  // 10,20,30,40,50,60 @ 1000..1500 -> 50 item / 500ms = 0.1 item/ms
  assert.equal(result.estimatedRemainingMs, (10000 - 60) / 0.1);
});

test("kısa işlerde formatRemaining okunur bir metin üretir", () => {
  assert.equal(formatRemaining(4000), "Kalan süre: < 10 saniye");
  assert.equal(formatRemaining(16000), "Kalan süre: ~16 saniye");
  assert.equal(formatRemaining(102000), "Kalan süre: ~1 dk 42 sn");
  assert.equal(formatRemaining(120000), "Kalan süre: ~2 dakika");
});
