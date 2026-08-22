export const DEFAULT_DOCUMENT_TITLE = "Redakt — Belgen paylaşılmaya hazır.";

export function scanDocumentTitle(progress) {
  const ratio = Number(progress?.progress);
  if (Number.isFinite(ratio) && progress?.totalUnits > 0) {
    const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    return `%${percent} · Redakt`;
  }
  return "Taranıyor · Redakt";
}
