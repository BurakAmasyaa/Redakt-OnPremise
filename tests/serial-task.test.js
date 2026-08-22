import assert from "node:assert/strict";
import test from "node:test";
import { createSerialTaskRunner } from "../src/serial-task.js";

test("hızlı accordion görevleri aynı anda çalışmaz ve tıklama sırasını korur", async () => {
  const runSerial = createSerialTaskRunner();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = runSerial(async () => {
    events.push("A:start");
    await firstGate;
    events.push("A:end");
  });
  const second = runSerial(async () => {
    events.push("B:start");
    events.push("B:end");
  });

  await Promise.resolve();
  assert.deepEqual(events, ["A:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["A:start", "A:end", "B:start", "B:end"]);
});

test("bir accordion görevi hata verse de sonraki geçiş çalışır", async () => {
  const runSerial = createSerialTaskRunner();
  const events = [];
  await assert.rejects(runSerial(async () => { throw new Error("panel koptu"); }), /panel koptu/u);
  await runSerial(async () => { events.push("sonraki"); });
  assert.deepEqual(events, ["sonraki"]);
});
