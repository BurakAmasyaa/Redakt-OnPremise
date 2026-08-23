const BASE_URL = import.meta.env?.BASE_URL || "/";

function localModelPath() {
  return new URL(`${BASE_URL}models/`, document.baseURI).href;
}

export function detectNamedEntitiesInWorker(texts, { profile = "balanced", signal, onProgress } = {}) {
  if (!texts.some((text) => String(text).trim())) return Promise.resolve([]);

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./ner-worker.js", import.meta.url), { type: "module", name: "redakt-ner" });
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      worker.terminate();
      callback(value);
    };
    const cancel = () => {
      worker.postMessage({ type: "cancel" });
      finish(reject, signal?.reason || new DOMException("İşlem iptal edildi.", "AbortError"));
    };

    if (signal?.aborted) {
      cancel();
      return;
    }
    signal?.addEventListener("abort", cancel, { once: true });
    worker.addEventListener("error", (event) => {
      const error = new Error("Yerel kişi/kurum worker'ı başlatılamadı.");
      error.detail = String(event?.message || "").slice(0, 300);
      finish(reject, error);
    });
    worker.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "batch-progress") onProgress?.({ phase: "batch", ...message });
      else if (message.type === "model-progress") onProgress?.({ phase: "model", ...message.progress });
      else if (message.type === "complete") finish(resolve, message.findings || []);
      else if (message.type === "error") {
        const error = new Error(message.message || "Yerel kişi/kurum modeli çalıştırılamadı.");
        error.name = message.name || "Error";
        error.detail = message.detail ? String(message.detail).slice(0, 300) : null;
        finish(reject, error);
      }
    });
    worker.postMessage({
      type: "detect",
      texts: texts.map(String),
      profile,
      modelPath: localModelPath(),
    });
  });
}
