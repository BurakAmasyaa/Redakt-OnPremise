import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const resolvePath = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
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
