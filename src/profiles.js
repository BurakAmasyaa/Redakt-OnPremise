export const processingProfiles = Object.freeze({
  fast: Object.freeze({
    id: "fast",
    label: "Hızlı",
    ner: Object.freeze({ maxChunkLength: 900, overlap: 24 }),
    ocr: Object.freeze({ dpi: 150, retryLowConfidence: false }),
  }),
  balanced: Object.freeze({
    id: "balanced",
    label: "Dengeli",
    ner: Object.freeze({ maxChunkLength: 800, overlap: 80 }),
    ocr: Object.freeze({ dpi: 200, retryLowConfidence: false }),
  }),
  thorough: Object.freeze({
    id: "thorough",
    label: "Kapsamlı",
    ner: Object.freeze({ maxChunkLength: 700, overlap: 180 }),
    ocr: Object.freeze({ dpi: 300, retryLowConfidence: false }),
  }),
});

export function processingConfig(profile = "balanced") {
  return processingProfiles[profile] || processingProfiles.balanced;
}

export function recommendedProfile(device = globalThis.navigator || {}) {
  const cores = Number(device.hardwareConcurrency) || null;
  const memory = Number(device.deviceMemory) || null;
  if ((cores && cores <= 2) || (memory && memory <= 2)) return "fast";
  if ((cores && cores >= 8) && (memory && memory >= 8)) return "thorough";
  return "balanced";
}
