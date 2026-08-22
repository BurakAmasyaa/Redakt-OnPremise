import assert from "node:assert/strict";
import test from "node:test";
import { installGlobalErrorBoundary, shouldShowFatalFallback } from "../src/error-boundary.js";

test("genel hata sınırı yalnız işlem sırasındaki beklenmeyen hatayı bir kez gösterir", () => {
  const listeners = new Map();
  const windowObject = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener() {},
  };
  let active = false;
  let fatalCount = 0;
  installGlobalErrorBoundary({ windowObject, isProcessing: () => active, onFatal: () => { fatalCount += 1; } });

  listeners.get("error")({ message: "idle failure" });
  assert.equal(fatalCount, 0);
  active = true;
  listeners.get("unhandledrejection")({ reason: new Error("unexpected processing failure") });
  listeners.get("error")({ message: "second failure" });
  assert.equal(fatalCount, 1);
});

test("iptal ve eski chunk hataları mevcut özel kurtarma yoluna bırakılır", () => {
  const abort = new DOMException("İptal", "AbortError");
  assert.equal(shouldShowFatalFallback({ reason: abort }), false);
  assert.equal(shouldShowFatalFallback({ reason: new Error("Failed to fetch dynamically imported module") }), false);
  assert.equal(shouldShowFatalFallback({ reason: new Error("unexpected") }), true);
});
