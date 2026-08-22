export function findingsForCategory(findings, categoryLabel) {
  if (!categoryLabel) return findings;
  return findings.filter((finding) => finding.label === categoryLabel);
}

export function toggledCategory(currentCategory, requestedCategory) {
  return currentCategory === requestedCategory ? null : requestedCategory;
}
