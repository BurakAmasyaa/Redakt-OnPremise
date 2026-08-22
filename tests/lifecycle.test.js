import assert from "node:assert/strict";
import test from "node:test";
import { applyBeforeUnloadWarning, createBeforeUnloadGuard, hasActiveProcessing } from "../src/lifecycle.js";

function coordinator(activeKinds = []) {
  return { active(kind) { return activeKinds.includes(kind) ? {} : null; } };
}

test("beforeunload yalnız aktif tarama veya dışa aktarmada uyarır", () => {
  assert.equal(hasActiveProcessing({ coordinator: coordinator() }), false);
  assert.equal(hasActiveProcessing({ coordinator: coordinator(["scan"]) }), true);
  assert.equal(hasActiveProcessing({ coordinator: coordinator(["export"]) }), true);
  assert.equal(hasActiveProcessing({ coordinator: coordinator(), batchScanning: true }), true);
  assert.equal(hasActiveProcessing({ coordinator: coordinator(), bulkExporting: true }), true);

  let prevented = false;
  const event = { preventDefault() { prevented = true; }, returnValue: undefined };
  assert.equal(applyBeforeUnloadWarning(event, false), false);
  assert.equal(prevented, false);
  assert.equal(applyBeforeUnloadWarning(event, true), true);
  assert.equal(prevented, true);
  assert.equal(event.returnValue, "");
});

test("beforeunload listener'ı idle durumda bağlı değildir ve işlem bitince kaldırılır", () => {
  const listeners = new Map();
  const windowObject = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  };
  let active = false;
  let cleanupCount = 0;
  const guard = createBeforeUnloadGuard({
    windowObject,
    isActive: () => active,
    onUnload: () => { cleanupCount += 1; },
  });

  guard.sync();
  assert.equal(guard.installed(), false);
  assert.equal(listeners.has("beforeunload"), false);
  active = true;
  guard.sync();
  assert.equal(guard.installed(), true);
  const event = { preventDefault() {}, returnValue: undefined };
  listeners.get("beforeunload")(event);
  assert.equal(cleanupCount, 1);
  assert.equal(event.returnValue, "");
  active = false;
  guard.sync();
  assert.equal(guard.installed(), false);
  assert.equal(listeners.has("beforeunload"), false);
});
