import { configureNerRuntime, detectNamedEntities } from "./ner.js";
import { mergeNerBatches, nerBatchDelayMs, nerBatchSize } from "./ner-batching.js";

let activeController = null;

function abortError() {
  return new DOMException("İşlem iptal edildi.", "AbortError");
}

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  if (message.type === "cancel") {
    activeController?.abort(abortError());
    return;
  }
  if (message.type !== "detect") return;

  activeController?.abort(abortError());
  const controller = new AbortController();
  activeController = controller;
  configureNerRuntime({ modelPath: message.modelPath });

  try {
    const texts = Array.isArray(message.texts) ? message.texts : [];
    const batchSize = nerBatchSize(message.profile);
    const interBatchDelayMs = nerBatchDelayMs(texts);
    const batches = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      if (controller.signal.aborted) throw controller.signal.reason || abortError();
      const batch = texts.slice(offset, offset + batchSize);
      const findings = await detectNamedEntities(batch, {
        profile: message.profile,
        signal: controller.signal,
        inferenceBatchSize: batch.every((text) => text.length <= 160) ? 32 : 4,
        interBatchDelayMs,
        onProgress(progress) {
          if (progress.phase === "model" || progress.status) {
            self.postMessage({ type: "model-progress", progress });
          }
        },
      });
      batches.push({ offset, findings });
      self.postMessage({
        type: "batch-progress",
        current: Math.min(offset + batch.length, texts.length),
        total: texts.length,
        batchSize,
      });
    }
    self.postMessage({ type: "complete", findings: mergeNerBatches(batches) });
  } catch (error) {
    // Gerçek hata metni kurulum ve sorun gidermede tek ipucudur; kaybedilmemeli.
    // Bu metin çalışma zamanından gelir, belge içeriği taşımaz.
    self.postMessage({
      type: "error",
      name: error?.name || "Error",
      message: error?.name === "AbortError" ? "İşlem iptal edildi." : "Yerel kişi/kurum modeli çalıştırılamadı.",
      detail: error?.name === "AbortError" ? null : String(error?.message || error || "").slice(0, 300),
    });
  } finally {
    if (activeController === controller) activeController = null;
  }
});
