import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const recoverySource = await readFile(new URL("../public/chunk-recovery.js", import.meta.url), "utf8");

function createRecoveryHarness() {
  const listeners = new Map();
  const storage = new Map();
  let reloads = 0;
  const window = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    location: { reload() { reloads += 1; } },
    sessionStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
    },
  };

  vm.runInNewContext(recoverySource, { window });
  return { listeners, reloadCount: () => reloads, storage };
}

test("dinamik import hatasında sayfayı yalnız bir kez yeniler", () => {
  const harness = createRecoveryHarness();
  const failure = { reason: new TypeError("Failed to fetch dynamically imported module: /assets/pipeline-old.js") };

  harness.listeners.get("unhandledrejection")(failure);
  harness.listeners.get("unhandledrejection")(failure);

  assert.equal(harness.reloadCount(), 1);
  assert.equal(harness.storage.get("redakt:dynamic-import-reload-attempted"), "1");
});

test("ilgisiz fetch ve uygulama hatalarında sayfayı yenilemez", () => {
  const harness = createRecoveryHarness();

  harness.listeners.get("unhandledrejection")({ reason: new TypeError("Failed to fetch") });
  harness.listeners.get("error")({ message: "Beklenmeyen uygulama hatası" });

  assert.equal(harness.reloadCount(), 0);
});

test("Safari ve chunk loader hata biçimlerini de yakalar", () => {
  const safariHarness = createRecoveryHarness();
  safariHarness.listeners.get("error")({ message: "Importing a module script failed." });
  assert.equal(safariHarness.reloadCount(), 1);

  const chunkHarness = createRecoveryHarness();
  chunkHarness.listeners.get("error")({ message: "ChunkLoadError: Loading chunk pipeline-OLD failed" });
  assert.equal(chunkHarness.reloadCount(), 1);
});
