import assert from "node:assert/strict";
import test from "node:test";
import { createOperationCoordinator } from "../src/operation-coordinator.js";

test("export başlatmak aktif tarama controller'ını iptal etmez", () => {
  const operations = createOperationCoordinator();
  const scan = operations.begin("scan");
  const exportOperation = operations.begin("export");

  assert.equal(scan.signal.aborted, false);
  assert.equal(exportOperation.signal.aborted, false);
  assert.equal(operations.active("scan"), scan);
  assert.equal(operations.active("export"), exportOperation);
});

test("yalnız aynı türdeki yeni işlem eskisini iptal eder", () => {
  const operations = createOperationCoordinator();
  const firstScan = operations.begin("scan");
  const secondScan = operations.begin("scan");

  assert.equal(firstScan.signal.aborted, true);
  assert.equal(secondScan.signal.aborted, false);
  assert.equal(operations.active("scan"), secondScan);
});

test("bir işlemi bitirmek veya iptal etmek diğer türü etkilemez", () => {
  const operations = createOperationCoordinator();
  const scan = operations.begin("scan");
  const exportOperation = operations.begin("export");

  operations.finish("export", exportOperation);
  assert.equal(operations.active("export"), null);
  assert.equal(scan.signal.aborted, false);
  operations.abort("scan");
  assert.equal(scan.signal.aborted, true);
});
