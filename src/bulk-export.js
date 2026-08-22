function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
}

function uniqueFilename(filename, usedNames) {
  if (!usedNames.has(filename)) {
    usedNames.add(filename);
    return filename;
  }
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  let copy = 2;
  while (usedNames.has(`${stem}_${copy}${extension}`)) copy += 1;
  const result = `${stem}_${copy}${extension}`;
  usedNames.add(result);
  return result;
}

export async function createBulkArchive(queue, {
  JSZip,
  extractDocument,
  applyDocumentChanges,
  disposeDocument,
  profile = "balanced",
  signal,
  onProgress,
} = {}) {
  const items = queue.filter((item) => item.status === "done");
  if (!items.length) throw new Error("İndirilecek tamamlanmış dosya yok.");
  const archive = new JSZip();
  const usedNames = new Set();

  for (let index = 0; index < items.length; index += 1) {
    throwIfAborted(signal);
    const item = items[index];
    onProgress?.({ current: index, total: items.length, filename: item.file.name, phase: "processing" });
    let context = null;
    try {
      const extracted = await extractDocument(await item.file.arrayBuffer(), item.file.name, { profile, signal });
      context = extracted.context;
      const selectedIds = Array.isArray(item.selectedFindingIds)
        ? item.selectedFindingIds
        : item.findings.map((finding) => finding.id);
      const result = await applyDocumentChanges(context, item.findings, selectedIds, { signal });
      archive.file(uniqueFilename(result.filename, usedNames), result.bytes);
    } finally {
      if (context) await disposeDocument(context);
    }
    onProgress?.({ current: index + 1, total: items.length, filename: item.file.name, phase: "processed" });
  }

  throwIfAborted(signal);
  onProgress?.({ current: items.length, total: items.length, phase: "archiving" });
  return archive.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
