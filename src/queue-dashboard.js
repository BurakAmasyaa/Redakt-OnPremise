export function aggregateQueueFindings(queue) {
  const totals = new Map();
  let fileCount = 0;
  let findingCount = 0;

  for (const item of queue) {
    if (item.status !== "done" || !Array.isArray(item.findings)) continue;
    fileCount += 1;
    for (const finding of item.findings) {
      const count = Number(finding.count) || 0;
      findingCount += count;
      totals.set(finding.label, (totals.get(finding.label) || 0) + count);
    }
  }

  return {
    fileCount,
    findingCount,
    categories: [...totals.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, "tr")),
  };
}
