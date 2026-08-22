import assert from "node:assert/strict";
import test from "node:test";
import { findingsForCategory, toggledCategory } from "../src/finding-filter.js";

const findings = [
  { id: "1", label: "E-posta" },
  { id: "2", label: "Telefon" },
  { id: "3", label: "E-posta" },
];

test("kategori filtresi yalnız seçilen bulguları gösterir; Tümü tüm listeyi döndürür", () => {
  assert.deepEqual(findingsForCategory(findings, "E-posta").map(({ id }) => id), ["1", "3"]);
  assert.equal(findingsForCategory(findings, null), findings);
});

test("aktif kategoriye yeniden tıklamak filtreyi sıfırlar", () => {
  assert.equal(toggledCategory(null, "Telefon"), "Telefon");
  assert.equal(toggledCategory("Telefon", "Telefon"), null);
});
