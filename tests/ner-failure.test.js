import assert from "node:assert/strict";
import test from "node:test";
import { detectNamedEntitiesInWorker } from "../src/ner-client.js";

// Worker'ı taklit ederek hata iletim zincirini test eder.
// Kişi/kurum tespiti sessizce boş dönerse belge eksik maskelenir; bu yüzden
// hatanın çağırana ve oradan kullanıcıya ulaştığı kanıtlanmalıdır.
// ner-client model yolunu document.baseURI'den türetir.
globalThis.document ??= { baseURI: "http://127.0.0.1/" };

function stubWorker(behaviour) {
  const previous = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => behaviour(this));
    }
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }
    postMessage() {}
    terminate() {
      this.terminated = true;
    }
    emit(type, payload) {
      this.listeners.get(type)?.(payload);
    }
  };
  return () => { globalThis.Worker = previous; };
}

const TEXTS = ["Ahmet Yılmaz ile toplantı yapıldı."];

test("model çalışmazsa hata yutulmaz, çağırana iletilir", async () => {
  const restore = stubWorker((worker) => {
    worker.emit("message", { data: { type: "error", name: "Error", message: "Yerel kişi/kurum modeli çalıştırılamadı.", detail: "no available backend found" } });
  });
  try {
    await assert.rejects(
      () => detectNamedEntitiesInWorker(TEXTS),
      (error) => {
        assert.match(error.message, /çalıştırılamadı/u);
        assert.equal(error.detail, "no available backend found");
        return true;
      },
    );
  } finally { restore(); }
});

test("worker hiç başlamazsa da hata iletilir", async () => {
  const restore = stubWorker((worker) => {
    worker.emit("error", { message: "Failed to construct 'Worker'" });
  });
  try {
    await assert.rejects(
      () => detectNamedEntitiesInWorker(TEXTS),
      (error) => {
        assert.match(error.message, /worker'ı başlatılamadı/u);
        assert.match(error.detail, /Failed to construct/u);
        return true;
      },
    );
  } finally { restore(); }
});

test("teknik ayrıntı korunur ama sınırsız büyümez", async () => {
  const restore = stubWorker((worker) => {
    worker.emit("message", { data: { type: "error", message: "hata", detail: "x".repeat(1000) } });
  });
  try {
    await assert.rejects(
      () => detectNamedEntitiesInWorker(TEXTS),
      (error) => {
        assert.ok(error.detail.length <= 300, "ayrıntı kırpılmadı");
        return true;
      },
    );
  } finally { restore(); }
});

test("iptal edildiğinde teknik ayrıntı taşınmaz", async () => {
  const restore = stubWorker((worker) => {
    worker.emit("message", { data: { type: "error", name: "AbortError", message: "İşlem iptal edildi.", detail: null } });
  });
  try {
    await assert.rejects(
      () => detectNamedEntitiesInWorker(TEXTS),
      (error) => {
        assert.equal(error.name, "AbortError");
        assert.equal(error.detail, null);
        return true;
      },
    );
  } finally { restore(); }
});

test("başarılı sonuç bulguları döndürür", async () => {
  const restore = stubWorker((worker) => {
    worker.emit("message", { data: { type: "complete", findings: [{ id: "ner_1", value: "Ahmet Yılmaz" }] } });
  });
  try {
    const findings = await detectNamedEntitiesInWorker(TEXTS);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].value, "Ahmet Yılmaz");
  } finally { restore(); }
});

test("boş metinde worker hiç oluşturulmaz", async () => {
  let created = false;
  const restore = stubWorker(() => { created = true; });
  try {
    assert.deepEqual(await detectNamedEntitiesInWorker(["", "   "]), []);
    assert.equal(created, false);
  } finally { restore(); }
});

test("worker.js hatayı sabit metinle değiştirip ayrıntıyı atmaz", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/ner-worker.js", import.meta.url), "utf8");
  // detail alanı gönderilmezse arıza nedeni kurulumda hiçbir yerde görünmez.
  assert.match(source, /detail:/u, "ner-worker.js hata ayrıntısını göndermiyor");
  assert.match(source, /slice\(0,\s*300\)/u, "ayrıntı kırpılmıyor");
});
