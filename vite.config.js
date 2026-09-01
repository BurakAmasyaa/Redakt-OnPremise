import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const resolvePath = (path) => fileURLToPath(new URL(path, import.meta.url));

const CROSS_ORIGIN_ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: "./",
  // Geliştirmede de üretimdeki başlıklar verilir: yalıtım olmadan WASM tek
  // iş parçacığında koşar ve ölçümler yanıltıcı çıkar.
  server: {
    host: "127.0.0.1",
    port: 5173,
    headers: CROSS_ORIGIN_ISOLATION,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    headers: CROSS_ORIGIN_ISOLATION,
  },
  build: {
    target: "es2020",
    rollupOptions: {
      // Şirket içi kurulumda yalnızca uygulama ve 404 sayfası paketlenir.
      // Kamuya açık sitedeki pazarlama/SEO sayfaları bu ürüne dahil değildir.
      input: {
        main: resolvePath("index.html"),
        notFound: resolvePath("404.html"),
      },
    },
  },
});
