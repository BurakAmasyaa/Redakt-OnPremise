import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("çıktı blob URL'leri yeni oturumda, dosya silmede ve özet dönüşünde temizlenir", async () => {
  const source = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
  assert.match(source, /async function resetApp\(\)\s*\{\s*revokeDownloads\(\)/u);
  assert.match(source, /if \(state\.activeQueueItem\?\.id === id\)[\s\S]*?revokeDownloads\(\)/u);
  assert.match(source, /elements\.doneBatchBack\.addEventListener\("click", async \(\) => \{\s*revokeDownloads\(\)/u);
  assert.match(source, /window\.setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 2000\)/u);
});
