import assert from "node:assert/strict";
import test from "node:test";
import { aggregateQueueFindings } from "../src/queue-dashboard.js";

test("aggregateQueueFindings rolls completed files up by category and occurrence", () => {
  const result = aggregateQueueFindings([
    { status: "done", findings: [{ label: "E-posta", count: 2 }, { label: "IBAN", count: 1 }] },
    { status: "done", findings: [{ label: "E-posta", count: 3 }, { label: "Kişi", count: 4 }] },
    { status: "queued", findings: [{ label: "E-posta", count: 99 }] },
  ]);

  assert.deepEqual(result, {
    fileCount: 2,
    findingCount: 10,
    categories: [
      { label: "E-posta", count: 5 },
      { label: "Kişi", count: 4 },
      { label: "IBAN", count: 1 },
    ],
  });
});

test("aggregateQueueFindings handles completed files without findings", () => {
  assert.deepEqual(aggregateQueueFindings([{ status: "done", findings: [] }]), {
    fileCount: 1,
    findingCount: 0,
    categories: [],
  });
});
