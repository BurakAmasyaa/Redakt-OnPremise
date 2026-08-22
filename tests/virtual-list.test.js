import assert from "node:assert/strict";
import test from "node:test";
import { visibleWindow } from "../src/virtual-list.js";

test("4.179 öğelik listede yalnız görünür pencere ve overscan aralığını döndürür", () => {
  const top = visibleWindow({ scrollTop: 0, viewportHeight: 640, rowHeight: 80, itemCount: 4179 });
  assert.deepEqual(top, { start: 0, end: 13 });
  const middle = visibleWindow({ scrollTop: 80000, viewportHeight: 640, rowHeight: 80, itemCount: 4179 });
  assert.deepEqual(middle, { start: 995, end: 1013 });
  assert.ok(middle.end - middle.start < 25);
});
