import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ana sayfa kullanılan üç Switzer ağırlığını ilk boyamadan önce yükler", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const weight of ["regular", "semibold", "bold"]) {
    assert.match(
      html,
      new RegExp(`<link rel="preload" href="/fonts/switzer-${weight}\\.woff2" as="font" type="font/woff2" crossorigin \\/>`),
    );
  }
});
