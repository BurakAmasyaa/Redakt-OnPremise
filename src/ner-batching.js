import { categoryMeta, matchKey } from "./pii.js";

export const NER_BATCH_SIZES = Object.freeze({ fast: 200, balanced: 150, thorough: 100 });
export const LARGE_NER_WORKLOAD = Object.freeze({ minUnits: 50, minCharacters: 20_000, delayMs: 2 });

export function nerBatchSize(profile = "balanced") {
  return NER_BATCH_SIZES[profile] || NER_BATCH_SIZES.balanced;
}

export function nerBatchDelayMs(texts = []) {
  const units = Array.isArray(texts) ? texts : [];
  let characters = 0;
  for (const text of units) {
    characters += String(text).length;
    if (characters >= LARGE_NER_WORKLOAD.minCharacters) return LARGE_NER_WORKLOAD.delayMs;
  }
  return units.length >= LARGE_NER_WORKLOAD.minUnits ? LARGE_NER_WORKLOAD.delayMs : 0;
}

export function mergeNerBatches(batches) {
  const aggregate = new Map();

  for (const { offset = 0, findings = [] } of batches) {
    for (const finding of findings) {
      const key = matchKey(finding.category, finding.normalized);
      const shiftedLocations = (finding.locations || []).map((location) => ({
        ...location,
        unitIndex: location.unitIndex + offset,
      }));
      const current = aggregate.get(key);
      if (current) {
        current.count += finding.count;
        current.score = Math.max(current.score, finding.score);
        current.locations.push(...shiftedLocations);
        for (const variant of finding.variants || [finding.value]) current.variants.add(variant);
      } else {
        aggregate.set(key, {
          ...finding,
          count: finding.count,
          locations: shiftedLocations,
          variants: new Set(finding.variants || [finding.value]),
        });
      }
    }
  }

  const categoryCounts = { person: 0, organization: 0, location: 0 };
  return [...aggregate.values()].map((finding, index) => {
    categoryCounts[finding.category] += 1;
    const meta = categoryMeta[finding.category];
    const placeholder = `[${meta.prefix}_${categoryCounts[finding.category]}]`;
    return {
      ...finding,
      id: `ner_${index + 1}`,
      variants: [...finding.variants],
      placeholder,
      replacementText: placeholder,
    };
  });
}
