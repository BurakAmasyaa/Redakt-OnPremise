import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("özel 404 sayfası yalnız bilinmeyen yollar için statik çıktı olarak hazırlanır", async () => {
  const [html, viteConfig] = await Promise.all([
    readFile(new URL("../404.html", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /<meta name="robots" content="noindex" \/>/u);
  assert.match(html, /Bu sayfa bulunamadı\./u);
  assert.match(html, /href="\/"/u);
  assert.match(viteConfig, /notFound:\s*resolvePath\("404\.html"\)/u);
});
