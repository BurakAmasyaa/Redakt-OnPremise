
import { processingProfiles, recommendedProfile } from "./profiles.js";
import { createProgressTracker, formatRemaining } from "./progress.js";
import { VIRTUAL_LIST_THRESHOLD, visibleWindow } from "./virtual-list.js";
import { describeRuleSource, fetchCorporateRules, RULE_SOURCE_STATUS, shouldWarnBeforeScan } from "./rule-source.js";
import { detectCustomRules, detectImportedRulesBatched, normalizeCustomRules } from "./custom-rules.js";
import { aggregateQueueFindings } from "./queue-dashboard.js";
import { acceptedDocumentExtensions, MAX_DOCUMENT_FILE_SIZE, validateDocumentBytes } from "./file-validation.js";
import { createOperationCoordinator } from "./operation-coordinator.js";
import { createSerialTaskRunner } from "./serial-task.js";
import { canStartScan, itemsToRequeue, SCANNABLE_STATUS } from "./queue-state.js";
import {
  clearNerModelCache,
  formatModelDownloadBytes,
  formatModelSize,
  isMeasurableModelDownload,
  isNerModelCached,
  nerModelStorage,
  NER_MODEL_DOWNLOAD_MESSAGE,
} from "./model-cache.js";
import { detectLabelledFields } from "./field-labels.js";
import { aggregateFindings, collectReplacementPlanBatched, countsForSelection, mergeFindings } from "./pii.js";
import { DEFAULT_DOCUMENT_TITLE, scanDocumentTitle } from "./live-title.js";
import { findingsForCategory, toggledCategory } from "./finding-filter.js";
import { createBeforeUnloadGuard, hasActiveProcessing } from "./lifecycle.js";
import { installGlobalErrorBoundary } from "./error-boundary.js";

const MAX_FILE_SIZE = MAX_DOCUMENT_FILE_SIZE;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");
const BATCH_INSTRUCTION = "Her dosyayı incelemek için üzerine tıkla ya da hazırsan hepsini birden indir.";

const state = {
  context: null,
  filename: "",
  findings: [],
  // Aday listesi: seçim her değiştiğinde sayım bundan yeniden çıkarılır.
  replacementPlan: [],
  outputUrl: null,
  outputName: "",
  mappingUrl: null,
  mappingName: "",
  customRules: [],
  importedRules: [],
  ruleSource: null,
  pendingFile: null,
  pendingBytes: null,
  preflightPromise: null,
  estimatedUnits: null,
  profile: "balanced",
  selectedFindingIds: new Set(),
  queue: [],
  currentQueueItem: null,
  activeQueueItem: null,
  expandedQueueItemId: null,
  cancelledQueueItemId: null,
  // Kullanıcı taramayı kendisi durdurdu mu: durduran kişi hata mesajı değil,
  // yeniden başlatabildiği bir kuyruk görmeli.
  cancelledScan: false,
  cancellingAll: false,
  batchMode: false,
  batchScanning: false,
  bulkExporting: false,
  bulkDownloadComplete: false,
  activeFindingCategory: null,
  fatalError: false,
};

const operationCoordinator = createOperationCoordinator();
const runQueueAccordionTask = createSerialTaskRunner();

const elements = Object.fromEntries(
  [
    "upload-stage", "review-stage", "done-stage", "batch-stage", "brand-button", "drop-zone", "file-input",
    "folder-input", "folder-select-button",
    "review-back", "review-filename", "review-total", "finding-list", "empty-state", "select-all",
    "category-summary", "exact-group", "exact-count", "exact-list", "probable-group", "probable-count", "probable-list",
    "selection-status", "mapping-card", "mapping-toggle", "redact-button", "download-filename",
    "download-button", "mapping-download", "mapping-warning", "start-over", "drag-follower",
    "processing-layer", "processing-title", "processing-detail", "toast", "toast-message", "toast-close",
    "done-copy", "download-detail", "rule-add", "custom-rules-list", "custom-rules-empty",
    "rule-refresh-button", "rule-import-status", "rule-source-badge",
    "saved-rules", "saved-rules-count", "saved-rules-list",
    "custom-group", "custom-count", "custom-list",
    "scan-setup", "selected-file-bar", "selected-filename", "selected-filename-detail", "change-file",
    "scan-button", "scan-button-label", "device-recommendation", "large-file-warning",
    "model-storage-badge", "model-storage-detail", "model-storage-clear",
    "queue-list", "queue-cancel-all", "review-controls",
    "processing-progress", "processing-units", "progress-bar", "processing-percent", "processing-eta", "processing-cancel",
    "batch-back", "batch-title", "batch-cancel-all", "batch-download-all", "batch-subtitle", "batch-instruction", "batch-summary-tab", "batch-files-tab",
    "batch-summary-view", "batch-files-view", "batch-total", "aggregate-grid", "batch-file-list", "done-batch-back",
    "scan-warning", "scan-warning-title", "scan-warning-detail",
    "confirm-layer", "confirm-dismiss", "confirm-accept", "confirm-eyebrow", "confirm-title", "confirm-detail",
    "fatal-error-layer", "fatal-error-reload",
  ].map((id) => [id.replace(/-([a-z])/g, (_, character) => character.toUpperCase()), document.getElementById(id)])
);

let dragDepth = 0;
let dragFrame = null;
let dragPosition = { x: 0, y: 0 };
let toastTimer = null;
let confirmResolver = null;
const springAnimations = new WeakMap();
const virtualLists = new Map();
const beforeUnloadGuard = createBeforeUnloadGuard({
  windowObject: window,
  isActive: processingIsActive,
  onUnload: revokeDownloads,
});

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function showStage(active) {
  for (const stage of [elements.uploadStage, elements.reviewStage, elements.doneStage, elements.batchStage]) {
    const selected = stage === active;
    stage.hidden = !selected;
    stage.classList.toggle("is-active", selected);
  }
  window.scrollTo({ top: 0, behavior: REDUCED_MOTION.matches ? "auto" : "smooth" });
}

function setProcessing(visible, title = "Belge taranıyor…", detail = "Her şey bu tarayıcıda gerçekleşiyor.") {
  if (state.fatalError) {
    elements.processingLayer.hidden = true;
    elements.processingProgress.hidden = true;
    return;
  }
  if (state.batchScanning) {
    elements.processingLayer.hidden = true;
    elements.processingProgress.hidden = true;
    return;
  }
  elements.processingLayer.hidden = !visible;
  elements.processingTitle.textContent = title;
  elements.processingDetail.textContent = detail;
  if (!visible) {
    elements.processingProgress.hidden = true;
    elements.processingProgress.classList.remove("is-indeterminate");
  }
}

function progressUnitsText(progress) {
  if (progress.phase === "model") {
    return progress.totalUnits > 0
      ? formatModelDownloadBytes(progress.completedUnits, progress.totalUnits)
      : "Model indirme bağlantısı hazırlanıyor";
  }
  const completed = progress.phase === "ocr"
    ? Math.floor(progress.completedUnits)
    : Math.round(progress.completedUnits);
  const total = Math.round(progress.totalUnits);
  const unitSuffix = progress.unitLabel ? ` ${progress.unitLabel}` : "";
  return `${completed.toLocaleString("tr-TR")} / ${total.toLocaleString("tr-TR")}${unitSuffix}`;
}

function renderProcessingProgress(progress) {
  setProcessing(true, `${progress.phaseLabel}…`, progress.detail || "Her şey bu tarayıcıda gerçekleşiyor.");
  const hasMeasuredProgress = progress.totalUnits > 0 && progress.completedUnits > 0;
  const isIndeterminate = !hasMeasuredProgress;
  elements.processingProgress.hidden = false;
  elements.processingProgress.classList.toggle("is-indeterminate", isIndeterminate);
  elements.processingUnits.textContent = isIndeterminate ? `${progress.phaseLabel}…` : progressUnitsText(progress);
  const percent = Math.round(progress.progress * 100);
  elements.progressBar.style.width = isIndeterminate ? "" : `${percent}%`;
  elements.processingPercent.textContent = isIndeterminate ? "İşlem sürüyor" : `%${percent} tamamlandı`;
  elements.processingEta.textContent = isIndeterminate
    ? "Hesaplanıyor…"
    : progress.completedUnits >= progress.totalUnits
      ? "Tamamlandı"
      : progress.estimatedRemainingMs === undefined ? "Hesaplanıyor…" : formatRemaining(progress.estimatedRemainingMs);
  if (state.currentQueueItem) {
    const isFirstModelDownload = progress.phase === "model" && progress.detail === NER_MODEL_DOWNLOAD_MESSAGE;
    const queueText = isFirstModelDownload
      ? `${NER_MODEL_DOWNLOAD_MESSAGE}${isIndeterminate ? "" : ` · %${percent}`}`
      : isIndeterminate
        ? `${progress.phaseLabel}…`
        : `${progressUnitsText(progress)} · %${percent}`;
    updateQueueRow(state.currentQueueItem.id, {
      progressIndeterminate: isIndeterminate,
      progressRatio: isIndeterminate ? 0 : progress.progress,
      progressText: queueText,
    });
  }
}

function beginOperation(kind) {
  const controller = operationCoordinator.begin(kind);
  beforeUnloadGuard.sync();
  if (kind === "scan") document.title = scanDocumentTitle();
  return {
    controller,
    tracker: createProgressTracker((progress) => {
      renderProcessingProgress(progress);
      if (kind === "scan" && !state.fatalError) document.title = scanDocumentTitle(progress);
    }),
  };
}

function finishOperation(kind, controller) {
  operationCoordinator.finish(kind, controller);
  beforeUnloadGuard.sync();
}

function showError(message) {
  window.clearTimeout(toastTimer);
  elements.toastMessage.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 6500);
}

function selectedFindings() {
  return state.findings.filter((finding) => state.selectedFindingIds.has(finding.id));
}

// Sayı "tarama sırasında kaç yer bulundu" değil, "bu seçimle kaç yer
// değişecek" olmalı. Kullanıcı öncelikli bir kuralın seçimini kaldırdığında
// onun kapsadığı bulgu yeniden devreye giriyor; sayı eskisi gibi sabit
// kalırsa arayüz "0 kullanım maskelenecek" derken belgede iki değişiklik
// oluyordu. Yeniden tarama gerekmez: aday listesi taramada saklandı.
function refreshPlannedCounts() {
  if (!state.replacementPlan.length) return;
  const counts = countsForSelection(state.replacementPlan, [...state.selectedFindingIds]);
  for (const finding of state.findings) finding.count = counts.get(finding.id) || 0;

  for (const element of document.querySelectorAll(".finding-count[data-finding-id]")) {
    const finding = state.findings.find((item) => item.id === element.dataset.findingId);
    if (!finding) continue;
    const covered = finding.count === 0;
    element.textContent = covered ? "0" : finding.count > 1 ? `×${finding.count}` : "";
    element.setAttribute("aria-label", covered
      ? "Bu değer öncelikli başka bir kuralla maskeleniyor"
      : `${finding.count} kullanım maskelenecek`);
    element.closest(".finding-row")?.classList.toggle("is-covered", covered);
  }

  const byLabel = new Map();
  for (const finding of state.findings) {
    byLabel.set(finding.label, (byLabel.get(finding.label) || 0) + finding.count);
  }
  for (const chip of document.querySelectorAll(".category-chip[data-category-label]")) {
    const label = chip.dataset.categoryLabel;
    if (!label) continue;
    chip.textContent = `${label} ${byLabel.get(label) || 0}`;
  }
}

function updateSelection() {
  refreshPlannedCounts();
  const selected = selectedFindings();
  const total = state.findings.length;
  const occurrences = selected.reduce((sum, finding) => sum + finding.count, 0);
  elements.selectionStatus.textContent = total
    ? `${selected.length}/${total} öğe · ${occurrences} kullanım maskelenecek`
    : "Seçilebilir bir öğe yok";
  elements.selectAll.checked = total > 0 && selected.length === total;
  elements.selectAll.indeterminate = selected.length > 0 && selected.length < total;
  elements.redactButton.disabled = selected.length === 0;
  if (state.activeQueueItem) state.activeQueueItem.selectedFindingIds = [...state.selectedFindingIds];
}

function stopSpring(element) {
  const animation = springAnimations.get(element);
  if (animation) cancelAnimationFrame(animation);
  springAnimations.delete(element);
}

function springIn(element, initialOffset = 22, response = 0.36, dampingRatio = 1) {
  stopSpring(element);
  if (REDUCED_MOTION.matches) {
    element.style.opacity = "1";
    element.style.transform = "none";
    return;
  }

  const omega = (2 * Math.PI) / response;
  let position = initialOffset;
  let velocity = 0;
  let previousTime = performance.now();
  element.style.transform = `translate3d(0, ${initialOffset}px, 0) scale(0.985)`;
  element.style.opacity = "0";

  const step = (time) => {
    const delta = Math.min((time - previousTime) / 1000, 1 / 30);
    previousTime = time;
    const acceleration = -2 * dampingRatio * omega * velocity - omega * omega * position;
    velocity += acceleration * delta;
    position += velocity * delta;
    const progress = Math.max(0, Math.min(1, 1 - position / initialOffset));
    element.style.transform = `translate3d(0, ${position.toFixed(3)}px, 0) scale(${(0.985 + progress * 0.015).toFixed(4)})`;
    element.style.opacity = progress.toFixed(3);

    if (Math.abs(position) < 0.08 && Math.abs(velocity) < 0.08) {
      element.style.transform = "translate3d(0, 0, 0) scale(1)";
      element.style.opacity = "1";
      springAnimations.delete(element);
      return;
    }
    springAnimations.set(element, requestAnimationFrame(step));
  };
  springAnimations.set(element, requestAnimationFrame(step));
}

function springQueueState(element, response = 0.36, dampingRatio = 1) {
  stopSpring(element);
  if (REDUCED_MOTION.matches) {
    element.style.transform = "none";
    element.style.removeProperty("--queue-transition");
    return;
  }
  const omega = (2 * Math.PI) / response;
  let position = 1;
  let velocity = 0;
  let previousTime = performance.now();
  element.style.setProperty("--queue-transition", "0");
  element.style.transform = "translate3d(0, 2px, 0) scale(0.996)";
  const step = (time) => {
    const delta = Math.min((time - previousTime) / 1000, 1 / 30);
    previousTime = time;
    const acceleration = -2 * dampingRatio * omega * velocity - omega * omega * position;
    velocity += acceleration * delta;
    position += velocity * delta;
    const clamped = Math.max(0, Math.min(1, position));
    element.style.setProperty("--queue-transition", (1 - clamped).toFixed(4));
    element.style.transform = `translate3d(0, ${(clamped * 2).toFixed(3)}px, 0) scale(${(1 - clamped * 0.004).toFixed(4)})`;
    if (Math.abs(position) < 0.005 && Math.abs(velocity) < 0.01) {
      element.style.transform = "none";
      element.style.setProperty("--queue-transition", "1");
      springAnimations.delete(element);
      return;
    }
    springAnimations.set(element, requestAnimationFrame(step));
  };
  springAnimations.set(element, requestAnimationFrame(step));
}

function springProgressWidth(element, targetRatio, response = 0.36, dampingRatio = 1) {
  stopSpring(element);
  const target = Math.max(0, Math.min(1, Number(targetRatio) || 0));
  if (REDUCED_MOTION.matches) {
    element.dataset.progressRatio = String(target);
    element.style.width = `${target * 100}%`;
    return;
  }
  const omega = (2 * Math.PI) / response;
  let position = Math.max(0, Math.min(1, Number(element.dataset.progressRatio) || 0));
  let velocity = 0;
  let previousTime = performance.now();
  const step = (time) => {
    const delta = Math.min((time - previousTime) / 1000, 1 / 30);
    previousTime = time;
    const displacement = position - target;
    const acceleration = -2 * dampingRatio * omega * velocity - omega * omega * displacement;
    velocity += acceleration * delta;
    position += velocity * delta;
    const visible = Math.max(0, Math.min(1, position));
    element.dataset.progressRatio = visible.toFixed(5);
    element.style.width = `${(visible * 100).toFixed(3)}%`;
    if (Math.abs(position - target) < 0.0005 && Math.abs(velocity) < 0.001) {
      element.dataset.progressRatio = String(target);
      element.style.width = `${target * 100}%`;
      springAnimations.delete(element);
      return;
    }
    springAnimations.set(element, requestAnimationFrame(step));
  };
  springAnimations.set(element, requestAnimationFrame(step));
}

function springAccordionContent(element, expanding, response = 0.36, dampingRatio = 1) {
  stopSpring(element);
  if (REDUCED_MOTION.matches) {
    element.style.opacity = expanding ? "1" : "0";
    element.style.transform = "none";
    return Promise.resolve();
  }
  const omega = (2 * Math.PI) / response;
  const target = expanding ? 1 : 0;
  let position = expanding ? 0 : 1;
  let velocity = 0;
  let previousTime = performance.now();
  return new Promise((resolve) => {
    const step = (time) => {
      const delta = Math.min((time - previousTime) / 1000, 1 / 30);
      previousTime = time;
      const displacement = position - target;
      const acceleration = -2 * dampingRatio * omega * velocity - omega * omega * displacement;
      velocity += acceleration * delta;
      position += velocity * delta;
      const visible = Math.max(0, Math.min(1, position));
      element.style.opacity = visible.toFixed(3);
      element.style.transform = `translate3d(0, ${((1 - visible) * 8).toFixed(3)}px, 0)`;
      if (Math.abs(position - target) < 0.005 && Math.abs(velocity) < 0.01) {
        element.style.opacity = String(target);
        element.style.transform = "translate3d(0, 0, 0)";
        springAnimations.delete(element);
        resolve();
        return;
      }
      springAnimations.set(element, requestAnimationFrame(step));
    };
    springAnimations.set(element, requestAnimationFrame(step));
  });
}

function springDangerFill(element, targetAlpha, response = 0.36, dampingRatio = 1) {
  stopSpring(element);
  if (REDUCED_MOTION.matches) {
    element.style.backgroundColor = `rgba(200, 30, 30, ${targetAlpha})`;
    return;
  }
  const omega = (2 * Math.PI) / response;
  let position = Number(element.dataset.dangerAlpha || 0);
  let velocity = 0;
  let previousTime = performance.now();
  const step = (time) => {
    const delta = Math.min((time - previousTime) / 1000, 1 / 30);
    previousTime = time;
    const displacement = position - targetAlpha;
    const acceleration = -2 * dampingRatio * omega * velocity - omega * omega * displacement;
    velocity += acceleration * delta;
    position += velocity * delta;
    position = Math.max(0, Math.min(0.08, position));
    element.dataset.dangerAlpha = position.toFixed(4);
    element.style.backgroundColor = `rgba(200, 30, 30, ${position.toFixed(4)})`;
    if (Math.abs(position - targetAlpha) < 0.001 && Math.abs(velocity) < 0.001) {
      element.dataset.dangerAlpha = String(targetAlpha);
      element.style.backgroundColor = `rgba(200, 30, 30, ${targetAlpha})`;
      springAnimations.delete(element);
      return;
    }
    springAnimations.set(element, requestAnimationFrame(step));
  };
  springAnimations.set(element, requestAnimationFrame(step));
}

function springCheckboxToggle(element, response = 0.36, dampingRatio = 1) {
  stopSpring(element);
  if (REDUCED_MOTION.matches) {
    element.style.opacity = "1";
    element.style.transform = "none";
    return;
  }
  const omega = (2 * Math.PI) / response;
  let position = 1;
  let velocity = 0;
  let previousTime = performance.now();
  const step = (time) => {
    const delta = Math.min((time - previousTime) / 1000, 1 / 30);
    previousTime = time;
    const acceleration = -2 * dampingRatio * omega * velocity - omega * omega * position;
    velocity += acceleration * delta;
    position += velocity * delta;
    const visible = Math.max(0, Math.min(1, position));
    element.style.opacity = (1 - visible * 0.28).toFixed(3);
    element.style.transform = `scale(${(1 - visible * 0.14).toFixed(4)})`;
    if (Math.abs(position) < 0.005 && Math.abs(velocity) < 0.01) {
      element.style.opacity = "1";
      element.style.transform = "none";
      springAnimations.delete(element);
      return;
    }
    springAnimations.set(element, requestAnimationFrame(step));
  };
  springAnimations.set(element, requestAnimationFrame(step));
}

function installDangerHover(element) {
  if (!element || element.dataset.dangerReady) return;
  element.dataset.dangerReady = "true";
  element.addEventListener("pointerenter", () => springDangerFill(element, 0.08));
  element.addEventListener("pointerleave", () => springDangerFill(element, 0));
}

function makeFindingRow(finding, { virtualized = false, index = 0, total = 0 } = {}) {
  const row = document.createElement("label");
  row.className = `finding-row pressable ${finding.confidence === "probable" ? "is-probable" : "is-exact"}`;
  if (virtualized) {
    row.setAttribute("aria-posinset", String(index + 1));
    row.setAttribute("aria-setsize", String(total));
  }
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = finding.id;
  input.checked = state.selectedFindingIds.has(finding.id);
  input.addEventListener("change", () => {
    if (input.checked) state.selectedFindingIds.add(finding.id);
    else state.selectedFindingIds.delete(finding.id);
    springCheckboxToggle(checkbox, 0.36, 1);
    updateSelection();
  });

  const checkbox = document.createElement("span");
  checkbox.className = "check-control";
  checkbox.setAttribute("aria-hidden", "true");

  const copy = document.createElement("span");
  copy.className = "finding-copy";
  const value = document.createElement("span");
  value.className = "finding-value";
  value.dir = "auto";
  value.textContent = finding.value;
  const label = document.createElement("span");
  label.className = "finding-label";
  const score = finding.score ? ` · model %${Math.round(finding.score * 100)}` : "";
  if (finding.source === "custom") label.textContent = `${finding.label} · ${finding.value} → ${finding.replacementText}`;
  else if (finding.source === "imported-rule") {
    label.textContent = `${finding.label} · ${finding.ruleText || finding.originalText} → ${finding.replacementText}`;
  } else label.textContent = `${finding.label}${score}`;
  copy.append(value, label);

  const placeholder = document.createElement("code");
  placeholder.textContent = finding.placeholder;
  row.dataset.findingId = finding.id;
  const count = document.createElement("span");
  count.className = "finding-count";
  count.dataset.findingId = finding.id;
  // Sayı artık "model kaç kez gördü" değil, "maskeleme kaç yeri değiştirecek".
  // Sıfır, değerin başka bir kuralın kapsamında kaldığı anlamına gelir; boş
  // bırakmak bunu "bir kez" ile aynı gösterirdi.
  const covered = finding.count === 0;
  count.textContent = covered ? "0" : finding.count > 1 ? `×${finding.count}` : "";
  count.setAttribute("aria-label", covered
    ? "Bu değer öncelikli başka bir kuralla maskeleniyor"
    : `${finding.count} kullanım maskelenecek`);
  if (covered) {
    row.classList.add("is-covered");
    row.title = "Bu değer öncelikli başka bir kuralla maskeleniyor.";
  }
  row.append(input, checkbox, copy, placeholder, count);
  installPressFeedback(row);
  return row;
}

function disposeVirtualList(container) {
  const current = virtualLists.get(container);
  if (!current) return;
  container.removeEventListener("scroll", current.onScroll);
  window.removeEventListener("resize", current.onResize);
  if (current.frame) cancelAnimationFrame(current.frame);
  virtualLists.delete(container);
  container.classList.remove("virtual-list");
  container.removeAttribute("role");
  container.removeAttribute("tabindex");
  container.style.height = "";
}

function renderFindingGroup(container, findings) {
  disposeVirtualList(container);
  if (findings.length <= VIRTUAL_LIST_THRESHOLD) {
    const rows = findings.map((finding) => makeFindingRow(finding));
    container.replaceChildren(...rows);
    return rows;
  }

  container.classList.add("virtual-list");
  container.setAttribute("role", "list");
  container.tabIndex = 0;
  const spacer = document.createElement("div");
  spacer.className = "virtual-spacer";
  container.replaceChildren(spacer);
  const virtualState = { findings, spacer, frame: null, rowHeight: 80 };

  const renderWindow = () => {
    virtualState.frame = null;
    virtualState.rowHeight = window.matchMedia("(max-width: 760px)").matches ? 104 : 80;
    container.style.height = `${Math.min(8, findings.length) * virtualState.rowHeight}px`;
    spacer.style.height = `${findings.length * virtualState.rowHeight}px`;
    const range = visibleWindow({
      scrollTop: container.scrollTop,
      viewportHeight: container.clientHeight,
      rowHeight: virtualState.rowHeight,
      itemCount: findings.length,
    });
    const fragment = document.createDocumentFragment();
    for (let index = range.start; index < range.end; index += 1) {
      const row = makeFindingRow(findings[index], { virtualized: true, index, total: findings.length });
      row.style.top = `${index * virtualState.rowHeight}px`;
      row.style.height = `${virtualState.rowHeight}px`;
      fragment.append(row);
    }
    spacer.replaceChildren(fragment);
  };
  const scheduleRender = () => {
    if (!virtualState.frame) virtualState.frame = requestAnimationFrame(renderWindow);
  };
  virtualState.onScroll = scheduleRender;
  virtualState.onResize = scheduleRender;
  container.addEventListener("scroll", scheduleRender, { passive: true });
  window.addEventListener("resize", scheduleRender, { passive: true });
  virtualLists.set(container, virtualState);
  renderWindow();
  return [];
}

function renderReview({ inline = false, reviewState = null, preserveCategory = false } = {}) {
  const filename = reviewState?.filename ?? state.filename;
  const findings = reviewState?.findings ?? state.findings;
  if (!preserveCategory) state.activeFindingCategory = null;
  const visibleFindings = findingsForCategory(findings, state.activeFindingCategory);
  elements.reviewFilename.textContent = filename;
  const occurrences = findings.reduce((sum, finding) => sum + finding.count, 0);
  elements.reviewTotal.textContent = `${occurrences} bulgu`;
  const customFindings = visibleFindings.filter((finding) => finding.source === "custom");
  const exactFindings = visibleFindings.filter((finding) => finding.source !== "custom" && finding.confidence !== "probable");
  const probableFindings = visibleFindings.filter((finding) => finding.confidence === "probable");
  const customRows = renderFindingGroup(elements.customList, customFindings);
  const exactRows = renderFindingGroup(elements.exactList, exactFindings);
  const probableRows = renderFindingGroup(elements.probableList, probableFindings);
  elements.customGroup.hidden = customFindings.length === 0;
  elements.exactGroup.hidden = exactFindings.length === 0;
  elements.probableGroup.hidden = probableFindings.length === 0;
  elements.customCount.textContent = `${customFindings.length} öğe`;
  elements.exactCount.textContent = `${exactFindings.length} öğe`;
  elements.probableCount.textContent = `${probableFindings.length} öğe`;

  const summary = new Map();
  for (const finding of findings) {
    summary.set(finding.label, (summary.get(finding.label) || 0) + finding.count);
  }
  const categoryChip = (label, count, category = null) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "category-chip pressable";
    const active = state.activeFindingCategory === category;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", String(active));
    chip.dataset.categoryLabel = category === null ? "" : category;
    chip.textContent = count === null ? label : `${label} ${count}`;
    chip.addEventListener("click", () => {
      state.activeFindingCategory = category === null
        ? null
        : toggledCategory(state.activeFindingCategory, category);
      renderReview({ inline, reviewState: { filename, findings }, preserveCategory: true });
      elements.findingList.scrollIntoView({ behavior: REDUCED_MOTION.matches ? "auto" : "smooth", block: "start" });
    });
    installPressFeedback(chip);
    return chip;
  };
  elements.categorySummary.replaceChildren(
    categoryChip("Tümü", null),
    ...[...summary].map(([label, count]) => categoryChip(label, count, label))
  );

  const rows = [...customRows, ...exactRows, ...probableRows];
  const hasFindings = findings.length > 0;
  elements.findingList.hidden = !hasFindings;
  elements.categorySummary.hidden = !hasFindings;
  elements.emptyState.hidden = hasFindings;
  elements.selectAll.closest("label").hidden = !hasFindings;
  elements.mappingCard.hidden = !hasFindings;
  elements.mappingToggle.checked = false;
  updateSelection();
  if (!inline) {
    elements.reviewStage.append(elements.reviewControls);
    showStage(elements.reviewStage);
  }
  requestAnimationFrame(() => {
    for (const container of [elements.customList, elements.exactList, elements.probableList]) {
      virtualLists.get(container)?.onResize();
    }
  });
  rows.forEach((row) => springIn(row, 22, 0.36, 1));
}

async function handleFile(file, { backgroundQueue = false } = {}) {
  if (!/\.(docx|xlsx|pdf|txt|jpe?g|png)$/iu.test(file.name)) {
    showError("Yalnızca DOCX, XLSX, PDF, UTF-8 TXT, JPG ve PNG dosyaları destekleniyor.");
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    showError("Dosya boyutu 50 MB sınırını aşıyor.");
    return;
  }

  const { controller, tracker } = beginOperation("scan");
  setProcessing(true, "Belge taranıyor…", "Doğrulanabilir bilgiler bu sekmede aranıyor.");
  tracker.start("reading", 1, "Dosya ve yerel işlem bileşenleri tarayıcıda hazırlanıyor.");
  await nextPaint();
  let nerWarning = null;
  let workingContext = null;
  let succeeded = false;
  try {
    const [{ extractDocument }, { detectNamedEntitiesInWorker }] = await Promise.all([
      import("./pipeline.js"),
      import("./ner-client.js"),
    ]);
    await state.preflightPromise;
    const fileBytes = state.pendingFile === file && state.pendingBytes
      ? state.pendingBytes
      : await file.arrayBuffer();
    tracker.advance(1);
    tracker.start("extracting", 1, "Belge yapısı ve metin katmanları tarayıcıda ayrıştırılıyor.");
    let ocrStarted = false;
    let ocrCompleted = 0;
    let ocrTotal = 0;
    const { context, findings } = await extractDocument(fileBytes, file.name, {
      profile: state.profile,
      signal: controller.signal,
      onProgress(progress) {
        if (progress.phase !== "ocr") return;
        const isEmbeddedImage = progress.kind === "image";
        const detail = progress.status === "initializing"
          ? isEmbeddedImage
            ? "Belge içindeki görseller algılandı; Türkçe ve İngilizce OCR modeli cihazında hazırlanıyor."
            : "Taranmış sayfa algılandı; Türkçe ve İngilizce OCR modeli cihazında hazırlanıyor."
          : isEmbeddedImage
            ? `Belge görseli ${progress.current}/${progress.total} cihazında işlendi.`
            : `Taranmış sayfa ${progress.current}/${progress.total} cihazında işlendi.`;
        if (!ocrStarted) {
          ocrStarted = true;
          ocrTotal = Math.max(1, Number(progress.total) || 1);
          tracker.start("ocr", progress.total, detail);
        }
        ocrCompleted = Math.max(0, Number(progress.current) || 0);
        tracker.advance(progress.current, detail);
      },
      onOcrProgress(progress) {
        if (progress.status !== "recognizing text") return;
        const pageProgress = Math.max(0, Math.min(1, Number(progress.progress) || 0));
        const percent = Math.round(pageProgress * 100);
        const detail = `Yerel OCR %${percent} · dosya içeriği cihazından çıkmıyor.`;
        if (!ocrStarted) {
          ocrStarted = true;
          ocrTotal = 1;
          tracker.start("ocr", ocrTotal, detail);
        }
        tracker.advance(Math.min(ocrTotal, ocrCompleted + pageProgress), detail);
      },
    });
    workingContext = context;
    tracker.start("extracting", 1);
    tracker.advance(1);
    const customRules = normalizeCustomRules(state.customRules);
    const documentUnits = context.units || context.texts || [];
    // Dosya adı da taranan bir birimdir. "Kerem Aydın ikametgah.pdf" belgesinin
    // içi maskelenip adı olduğu gibi kalınca, dosya paylaşıldığı anda maskeleme
    // boşa çıkıyordu. Ad, belgenin geri kalanıyla aynı kurallardan geçer.
    const filenameStem = file.name.replace(/\.[^.]+$/u, "");
    const filenameUnit = { text: filenameStem, location: { kind: "filename" } };
    const scanUnits = [...documentUnits, filenameUnit];
    const customFindings = detectCustomRules(scanUnits, customRules);
    const fieldFindings = detectLabelledFields(documentUnits);
    const filenameFindings = aggregateFindings([filenameUnit])
      .map((finding, index) => ({ ...finding, id: `fn_${index + 1}` }));
    let importedFindings = [];
    if (state.importedRules.length) {
      let rulesStarted = false;
      importedFindings = await detectImportedRulesBatched(scanUnits, state.importedRules, {
        batchSize: 100,
        signal: controller.signal,
        onProgress({ current, total }) {
          const detail = `${state.importedRules.length} kayıtlı kural, NER modelinden bağımsız olarak karşılaştırılıyor.`;
          if (!rulesStarted) {
            rulesStarted = true;
            tracker.start("rules", total, detail);
          }
          tracker.advance(current, detail);
        },
      });
    }
    let namedEntities = [];
    const unitCount = (context.units || context.texts || []).length;
    if (unitCount > 1000) showLargeFileWarning(unitCount);
    let modelProgressStarted = false;
    let detectionStarted = false;
    const modelCached = await isNerModelCached();
    const modelDetail = modelCached
      ? "Yerel Türkçe model tarayıcı önbelleğinden hazırlanıyor."
      : NER_MODEL_DOWNLOAD_MESSAGE;
    tracker.start("model", 0, modelDetail);
    try {
      namedEntities = await detectNamedEntitiesInWorker([...(context.texts || []), filenameStem], {
        profile: state.profile,
        signal: controller.signal,
        onProgress(progress) {
          if (progress.phase === "batch") {
            if (!detectionStarted) {
              detectionStarted = true;
              tracker.start("detecting", Math.max(1, unitCount), "Hassas bilgiler cihazındaki ayrı işlem hattında aranıyor.");
            }
            tracker.advance(
              progress.current,
              `${progress.batchSize} kayıtlık gruplar cihazındaki ayrı işlem hattında değerlendiriliyor.`
            );
          } else if (isMeasurableModelDownload(progress)) {
            const percent = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
            const detail = modelCached
              ? `Yerel model önbellekten hazırlanıyor · %${percent}.`
              : NER_MODEL_DOWNLOAD_MESSAGE;
            if (!modelProgressStarted) {
              modelProgressStarted = true;
              tracker.start("model", progress.total, detail);
            }
            tracker.advance(progress.loaded, detail);
          } else if (progress.status === "done" && modelProgressStarted) {
            modelProgressStarted = false;
            tracker.start("model", 0, modelDetail);
          }
        },
      });
      if (!detectionStarted) {
        detectionStarted = true;
        tracker.start("detecting", Math.max(1, unitCount), "Hassas bilgiler cihazındaki ayrı işlem hattında aranıyor.");
        tracker.advance(Math.max(1, unitCount), "Tarama tamamlandı.");
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // Kişi/kurum tespiti çalışmadıysa belgede isimler maskelenmeden kalır.
      // Kullanıcı bunu indirmeden önce görmeli; geçici bir bildirim yetmez.
      nerWarning = {
        title: "Kişi ve kurum adları aranamadı.",
        detail: `Bu belgede isimler maskelenmemiş olabilir; yalnızca e-posta, telefon, IBAN, T.C. kimlik ve kart numaraları ile kurumsal kurallar uygulandı.${error?.detail ? ` (Teknik ayrıntı: ${error.detail})` : ""}`,
      };
    }
    // Sıra güven sırasıdır: senin kuralın, kurumsal kural, doğrulanabilir desen,
    // belgenin kendi alan etiketi, sonra dil modeli. Aynı değeri iki katman da
    // bulduysa öndeki kazanır, arkadakinin yazım varyantları ona eklenir.
    const combinedFindings = mergeFindings([
      customFindings,
      importedFindings,
      findings,
      filenameFindings,
      fieldFindings,
      namedEntities,
    ]);
    // "Kaç kullanım maskelenecek" sorusunu maskelemenin kendi kodu yanıtlar.
    // Tespit sayısı ile uygulanan değişiklik sayısı birbirini tutmuyordu:
    // rapor 17 derken belgede 18 yer tutucu, 2 derken 8 değişiklik çıkıyordu.
    tracker.start("verifying", scanUnits.length, "Her bulgunun belgede kaç yerde geçtiği sayılıyor.");
    const replacementPlan = await collectReplacementPlanBatched(scanUnits, combinedFindings, {
      signal: controller.signal,
      onProgress({ current }) {
        tracker.advance(current, "Her bulgunun belgede kaç yerde geçtiği sayılıyor.");
      },
    });
    const plannedCounts = countsForSelection(replacementPlan, combinedFindings.map((finding) => finding.id));
    for (const finding of combinedFindings) finding.count = plannedCounts.get(finding.id) || 0;

    tracker.start("reviewPreparation", 1);
    tracker.advance(1);
    if (backgroundQueue && state.currentQueueItem) {
      // Uyarı dosyaya iliştirilir: toplu taramada inceleme ekranı hiç
      // açılmadığı için "isimler aranamadı" uyarısı kullanıcıya ulaşmıyordu.
      state.currentQueueItem.scanWarning = nerWarning;
      state.currentQueueItem.findings = combinedFindings;
      state.currentQueueItem.replacementPlan = replacementPlan;
      state.currentQueueItem.selectedFindingIds = combinedFindings.map((finding) => finding.id);
      const { disposeDocument } = await import("./pipeline.js");
      await disposeDocument(context);
      workingContext = null;
    } else {
      state.context = context;
      workingContext = null;
      state.filename = file.name;
      state.findings = combinedFindings;
      state.replacementPlan = replacementPlan;
      state.selectedFindingIds = new Set(combinedFindings.map((finding) => finding.id));
      renderReview();
    }
    succeeded = true;
  } catch (error) {
    if (workingContext) {
      const { disposeDocument } = await import("./pipeline.js");
      await disposeDocument(workingContext);
    }
    if (error?.name !== "AbortError") showError(error instanceof Error ? error.message : "Dosya okunamadı veya bozuk olabilir.");
  } finally {
    elements.fileInput.value = "";
    setProcessing(false);
    document.title = DEFAULT_DOCUMENT_TITLE;
    finishOperation("scan", controller);
    if (backgroundQueue) {
      // Toplu modda inceleme paneli görünmez; uyarı hem bildirimle duyurulur
      // hem de dosyanın kendi panelinde saklanır.
      if (nerWarning) showError(`${file.name}: ${nerWarning.title}`);
    } else showScanWarning(nerWarning);
  }
  return succeeded;
}

function showScanWarning(warning) {
  elements.scanWarning.hidden = !warning;
  if (!warning) return;
  elements.scanWarningTitle.textContent = warning.title;
  elements.scanWarningDetail.textContent = warning.detail || "";
}

function mappingContents(findings) {
  return JSON.stringify({
    format: "redakt-mapping",
    version: 1,
    created_at: new Date().toISOString(),
    source_file: state.filename,
    warning: "Bu dosya orijinal hassas değerleri içerir. Güvenli saklayın ve paylaşmayın.",
    replacements: findings.map((finding) => ({
      placeholder: finding.placeholder,
      original: finding.value,
      category: finding.label,
    })),
  }, null, 2);
}

function revokeDownloads() {
  if (state.outputUrl) URL.revokeObjectURL(state.outputUrl);
  if (state.mappingUrl) URL.revokeObjectURL(state.mappingUrl);
  state.outputUrl = null;
  state.mappingUrl = null;
}

function processingIsActive() {
  return hasActiveProcessing({
    coordinator: operationCoordinator,
    batchScanning: state.batchScanning,
    bulkExporting: state.bulkExporting,
  });
}

function showFatalErrorFallback() {
  state.fatalError = true;
  operationCoordinator.abortAll(new DOMException("Beklenmeyen uygulama hatası.", "AbortError"));
  state.batchScanning = false;
  state.bulkExporting = false;
  beforeUnloadGuard.sync();
  setProcessing(false);
  document.title = "Bir şeyler ters gitti · Redakt";
  elements.fatalErrorLayer.hidden = false;
  elements.fatalErrorReload.focus();
}

async function releaseContext() {
  if (!state.context) return;
  const { disposeDocument } = await import("./pipeline.js");
  await disposeDocument(state.context);
  state.context = null;
}

async function processSelection() {
  const selected = selectedFindings();
  if (!selected.length) return;
  const { controller, tracker } = beginOperation("export");
  setProcessing(true, "Temiz kopya hazırlanıyor…", "Dosya yalnızca tarayıcı belleğinde işleniyor.");
  tracker.start("exporting", 1, "Maskeleme bileşenleri tarayıcıda hazırlanıyor.");
  await nextPaint();
  try {
    const { applyDocumentChanges, extractDocument } = await import("./pipeline.js");
    if (!state.context && state.activeQueueItem) {
      tracker.start("reading", 1, "Seçilen dosya maskeleme için yeniden açılıyor.");
      const bytes = await state.activeQueueItem.file.arrayBuffer();
      tracker.advance(1);
      tracker.start("extracting", 1);
      const extracted = await extractDocument(bytes, state.activeQueueItem.file.name, {
        profile: state.profile,
        signal: controller.signal,
      });
      state.context = extracted.context;
      tracker.advance(1);
    }
    if (!state.context) throw new Error("Dosya maskeleme için açılamadı.");
    const isPdf = state.context.kind === "pdf";
    setProcessing(
      true,
      "Temiz kopya hazırlanıyor…",
      isPdf ? "PDF sayfaları güvenli, düzleştirilmiş çıktıya dönüştürülüyor." : "Dosya yalnızca tarayıcı belleğinde işleniyor."
    );
    let redactingStarted = false;
    const result = await applyDocumentChanges(state.context, state.findings, selected.map((finding) => finding.id), {
      onProgress(progress) {
        if (controller.signal.aborted) throw controller.signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
        if (!isPdf && progress.kind !== "image") return;
        const detail = progress.kind === "image"
          ? `Gömülü görsel ${progress.current}/${progress.total} cihazında maskeleniyor.`
          : `Sayfa ${progress.current}/${progress.total} cihazında düzleştiriliyor.`;
        if (!redactingStarted) {
          redactingStarted = true;
          tracker.start("redacting", progress.total, detail);
        }
        tracker.advance(progress.current, detail);
      },
      signal: controller.signal,
    });
    tracker.start("exporting", 1);
    tracker.advance(1);
    revokeDownloads();
    state.outputUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.mimeType }));
    state.outputName = result.filename;
    elements.downloadFilename.textContent = result.filename;
    elements.doneCopy.textContent = isPdf
      ? "Seçtiğin bilgiler maskelendi; hassas metin katmanı kaldırılıp sayfalar güvenli biçimde düzleştirildi."
      : "Seçtiğin bilgiler tutarlı etiketlerle maskelendi. Orijinal dosyana dokunulmadı.";
    // Dosya adı da maskelendiyse bunu söylemek gerekir: kullanıcı aradığı adı
    // bulamayınca yanlış dosyayı indirdiğini sanabilir.
    // Karşılaştırma bağlamın kendi adıyla yapılır: çıktı adını üreten de odur.
    const sourceName = state.context?.filename || state.filename;
    const untouchedName = sourceName.replace(/(\.[^.]+)$/u, "_redakte$1");
    const filenameRedacted = result.filename !== untouchedName;
    elements.downloadDetail.textContent = [
      isPdf ? "Paylaşmaya hazır · metin katmanı kaldırıldı" : "Paylaşmaya hazır",
      filenameRedacted ? "dosya adındaki hassas bilgi de maskelendi" : "",
    ].filter(Boolean).join(" · ");

    const shouldMap = elements.mappingToggle.checked;
    if (shouldMap) {
      state.mappingUrl = URL.createObjectURL(new Blob([mappingContents(selected)], { type: "application/json" }));
      // Eşleştirme dosyasının adı da maskelenmiş addan türetilir; orijinal ad
      // hassas olabiliyor ve bu dosya zaten ayrı saklanıyor.
      const mappingStem = result.filename.replace(/\.[^.]+$/u, "").replace(/_redakte$/u, "");
      state.mappingName = `${mappingStem}_eslestirme.json`;
    }
    elements.mappingDownload.hidden = !shouldMap;
    elements.mappingWarning.hidden = !shouldMap;
    await releaseContext();
    if (!state.batchMode) finishCurrentQueueItem();
    elements.startOver.hidden = state.batchMode;
    elements.doneBatchBack.hidden = !state.batchMode;
    showStage(elements.doneStage);
  } catch (error) {
    if (error?.name !== "AbortError") showError(error instanceof Error ? error.message : "Temiz kopya hazırlanamadı.");
  } finally {
    setProcessing(false);
    finishOperation("export", controller);
  }
}

function triggerDownload(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

async function resetApp() {
  revokeDownloads();
  operationCoordinator.abortAll(new DOMException("İşlem iptal edildi.", "AbortError"));
  await closeQueueAccordion();
  await releaseContext();
  state.filename = "";
  state.activeFindingCategory = null;
  document.title = DEFAULT_DOCUMENT_TITLE;
  state.findings = [];
  state.replacementPlan = [];
  state.outputName = "";
  state.mappingName = "";
  state.customRules = [];
  state.pendingFile = null;
  state.pendingBytes = null;
  state.preflightPromise = null;
  state.estimatedUnits = null;
  state.profile = "balanced";
  state.queue = [];
  state.currentQueueItem = null;
  state.activeQueueItem = null;
  state.expandedQueueItemId = null;
  state.cancelledQueueItemId = null;
  state.cancelledScan = false;
  state.cancellingAll = false;
  state.batchMode = false;
  state.batchScanning = false;
  state.bulkExporting = false;
  state.bulkDownloadComplete = false;
  state.fatalError = false;
  state.selectedFindingIds.clear();
  beforeUnloadGuard.sync();
  for (const container of [elements.customList, elements.exactList, elements.probableList]) {
    disposeVirtualList(container);
  }
  elements.customRulesList.replaceChildren();
  updateCustomRulesEmptyState();
  elements.scanSetup.hidden = true;
  elements.largeFileWarning.hidden = true;
  elements.largeFileWarning.textContent = "";
  elements.fileInput.value = "";
  elements.folderInput.value = "";
  elements.queueCancelAll.hidden = true;
  elements.startOver.hidden = false;
  elements.doneBatchBack.hidden = true;
  elements.reviewStage.append(elements.reviewControls);
  renderQueue();
  document.querySelector('input[name="processing-profile"][value="balanced"]').checked = true;
  elements.customList.replaceChildren();
  elements.exactList.replaceChildren();
  elements.probableList.replaceChildren();
  elements.categorySummary.replaceChildren();
  elements.mappingToggle.checked = false;
  showStage(elements.uploadStage);
}

function updateCustomRulesEmptyState() {
  elements.customRulesEmpty.hidden = state.customRules.length > 0;
}

// Model nerede duruyor sorusunun cevabı ekranda durur.
//
// Uygulama "yerel model" diyordu ama modelin cihazda nereye indiğini
// söylemiyordu; kullanıcı ne doğrulayabiliyor ne de kaldırabiliyordu.
// Doğrulanamayan bir mahremiyet iddiası, iddia olmaktan öteye gitmez.
async function renderModelStorage() {
  const storage = nerModelStorage();
  const cached = await isNerModelCached().catch(() => false);
  elements.modelStorageBadge.textContent = cached ? "Cihazda" : "İndirilmedi";
  elements.modelStorageBadge.dataset.tone = cached ? "ok" : "loading";
  elements.modelStorageDetail.textContent = [
    `${formatModelSize(storage.totalBytes)} · bu tarayıcı profilinin önbelleğinde (Cache Storage → “${storage.cacheName}”)`,
    cached
      ? `Kaynak: ${storage.sourceUrl} · bir kez indirildi, cihazdan çıkmıyor.`
      : `İlk taramada ${storage.sourceUrl} adresinden bir kez indirilecek; sonrasında cihazda kalır.`,
  ].join("\n");
  elements.modelStorageClear.hidden = !cached;
}

const RULE_SOURCE_BADGES = Object.freeze({
  [RULE_SOURCE_STATUS.loading]: { text: "Yükleniyor", tone: "loading" },
  [RULE_SOURCE_STATUS.ready]: { text: "Bağlı", tone: "ok" },
  [RULE_SOURCE_STATUS.stale]: { text: "Eski kopya", tone: "warn" },
  [RULE_SOURCE_STATUS.unavailable]: { text: "Bağlanamadı", tone: "error" },
});

function renderSavedRules() {
  const status = state.ruleSource?.status || RULE_SOURCE_STATUS.loading;
  const badge = RULE_SOURCE_BADGES[status];
  elements.ruleSourceBadge.textContent = badge.text;
  elements.ruleSourceBadge.dataset.tone = badge.tone;
  elements.ruleRefreshButton.disabled = status === RULE_SOURCE_STATUS.loading;

  const hasRules = state.importedRules.length > 0;
  elements.savedRules.hidden = !hasRules;
  elements.savedRulesCount.textContent = `${state.importedRules.length} kurumsal kural`;
  elements.savedRulesList.replaceChildren(...state.importedRules.map((rule) => {
    const row = document.createElement("div");
    row.className = "saved-rule-row";
    const find = document.createElement("code");
    find.textContent = rule.find;
    const arrow = document.createElement("span");
    arrow.textContent = "→";
    arrow.setAttribute("aria-hidden", "true");
    const replacement = document.createElement("code");
    replacement.textContent = rule.replacement;
    row.append(find, arrow, replacement);
    return row;
  }));
  elements.ruleImportStatus.textContent = describeRuleSource(state.ruleSource);
}

async function loadCorporateRules() {
  state.ruleSource = { status: RULE_SOURCE_STATUS.loading, rules: [] };
  renderSavedRules();

  const result = await fetchCorporateRules();
  state.ruleSource = result;
  state.importedRules = result.rules;
  renderSavedRules();

  if (result.duplicates?.length) {
    showError(`Veritabanında çakışan kural var: “${result.duplicates[0].find}”. Yöneticinize bildirin.`);
  }
  return result;
}

function removeCustomRule(id) {
  state.customRules = state.customRules.filter((rule) => rule.id !== id);
  elements.customRulesList.querySelector(`[data-rule-id="${CSS.escape(id)}"]`)?.remove();
  updateCustomRulesEmptyState();
}

function addCustomRule() {
  const suffix = crypto.randomUUID?.() || `${Date.now()}_${Math.random()}`;
  const id = `rule_${suffix}`;
  const rule = { id, find: "", replacement: "" };
  state.customRules.push(rule);

  const row = document.createElement("div");
  row.className = "custom-rule-row";
  row.dataset.ruleId = id;
  const find = document.createElement("input");
  find.type = "text";
  find.placeholder = "Bul";
  find.setAttribute("aria-label", "Bulunacak ifade");
  const arrow = document.createElement("span");
  arrow.className = "custom-rule-arrow";
  arrow.textContent = "→";
  arrow.setAttribute("aria-hidden", "true");
  const replacement = document.createElement("input");
  replacement.type = "text";
  replacement.placeholder = "Şununla değiştir";
  replacement.setAttribute("aria-label", "Yeni değer");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "rule-remove pressable";
  remove.setAttribute("aria-label", "Kuralı kaldır");
  remove.textContent = "×";
  find.addEventListener("input", () => { rule.find = find.value; });
  replacement.addEventListener("input", () => { rule.replacement = replacement.value; });
  remove.addEventListener("click", () => removeCustomRule(id));
  installPressFeedback(remove);
  row.append(find, arrow, replacement, remove);
  elements.customRulesList.append(row);
  updateCustomRulesEmptyState();
  find.focus();
}

function showLargeFileWarning(unitCount) {
  state.estimatedUnits = unitCount;
  elements.largeFileWarning.textContent = `${unitCount.toLocaleString("tr-TR")} satır/kayıt algılandı. Tarama cihazında ve ayrı bir worker içinde sürecek; bu işlem normalden uzun sürebilir.`;
  elements.largeFileWarning.hidden = false;
}

async function preflightFile(file) {
  state.pendingBytes = null;
  state.estimatedUnits = null;
  elements.largeFileWarning.hidden = true;
  elements.largeFileWarning.textContent = "";
  if (!/\.xlsx$/iu.test(file.name)) return;
  try {
    const bytes = await file.arrayBuffer();
    if (state.pendingFile !== file) return;
    state.pendingBytes = bytes;
    const { estimateXlsxRows } = await import("./office.js");
    const rows = await estimateXlsxRows(bytes);
    if (state.pendingFile === file && rows > 1000) showLargeFileWarning(rows);
  } catch {
    state.pendingBytes = null;
  }
}

const QUEUE_STATUS_LABELS = Object.freeze({
  queued: "Sırada",
  processing: "Taranıyor",
  done: "Tamamlandı",
  error: "Hata",
});

function makeQueueId() {
  return `q_${crypto.randomUUID?.() || `${Date.now()}_${Math.random()}`}`;
}

function renderQueue() {
  const isBatch = state.batchMode && state.queue.length > 0;
  elements.queueList.hidden = !isBatch;
  elements.queueCancelAll.hidden = !isBatch;
  if (!isBatch) {
    elements.queueList.replaceChildren();
    return;
  }
  const items = state.queue.map(makeQueueItem);
  items.forEach((item, index) => springIn(item, Math.min(12, 5 + index * 1.5), 0.36, 1));
  elements.queueList.replaceChildren(...items);
}

function makeQueueItem(item, { dashboard = false } = {}) {
    const wrapper = document.createElement("section");
    wrapper.className = "queue-item";
    wrapper.dataset.queueItemId = item.id;
    const row = document.createElement("div");
    row.className = `queue-row queue-row--${item.status}`;
    row.dataset.queueId = item.id;
    row.dataset.queueStatus = item.status;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "queue-row-open pressable";
    open.disabled = item.status !== "done";
    open.setAttribute("aria-expanded", String(state.expandedQueueItemId === item.id));
    open.setAttribute("aria-label", item.status === "done" ? `${item.file.name} bulgularını aç` : item.file.name);
    const name = document.createElement("span");
    name.className = "queue-row-name";
    name.dir = "auto";
    name.textContent = item.file.webkitRelativePath || item.file.name;
    const status = document.createElement("span");
    status.className = "queue-row-status";
    const findingCount = item.findings?.reduce((sum, finding) => sum + finding.count, 0) || 0;
    status.textContent = item.progressText || (item.status === "done" ? `${findingCount} bulgu · Aç` : QUEUE_STATUS_LABELS[item.status]);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "queue-row-cancel danger-outline pressable";
    cancel.textContent = "×";
    cancel.setAttribute("aria-label", `${item.file.name} dosyasını iptal et`);
    const bar = document.createElement("span");
    bar.className = "queue-row-bar";
    bar.classList.toggle("is-indeterminate", Boolean(item.progressIndeterminate));
    bar.setAttribute("aria-hidden", "true");
    const fill = document.createElement("i");
    fill.dataset.progressRatio = String(item.progressRatio || 0);
    fill.style.width = `${Math.round((item.progressRatio || 0) * 100)}%`;
    bar.append(fill);
    const chevron = document.createElement("span");
    chevron.className = "queue-row-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "›";
    open.append(name, status, chevron);
    open.addEventListener("click", () => {
      if (item.status === "done") {
        toggleQueueItem(item).catch(() => showError("Dosya incelemesi açılamadı; lütfen yeniden deneyin."));
      }
    });
    cancel.addEventListener("click", () => cancelQueueItem(item.id));
    installPressFeedback(open);
    installPressFeedback(cancel);
    installDangerHover(cancel);
    row.append(open, cancel, bar);
    if (dashboard) row.classList.add("queue-row--dashboard");
    wrapper.append(row);
    return wrapper;
}

function updateQueueRow(id, patch) {
  const item = state.queue.find((entry) => entry.id === id);
  if (!item) return;
  Object.assign(item, patch);
  for (const container of [elements.queueList, elements.batchFileList]) {
    const row = container.querySelector(`[data-queue-id="${CSS.escape(id)}"]`);
    if (!row) continue;
    const previousStatus = row.dataset.queueStatus;
    for (const statusName of Object.keys(QUEUE_STATUS_LABELS)) row.classList.remove(`queue-row--${statusName}`);
    row.classList.add(`queue-row--${item.status}`);
    row.dataset.queueStatus = item.status;
    const findingCount = item.findings?.reduce((sum, finding) => sum + finding.count, 0) || 0;
    row.querySelector(".queue-row-status").textContent = item.progressText || (item.status === "done" ? `${findingCount} bulgu · Aç` : QUEUE_STATUS_LABELS[item.status]);
    const bar = row.querySelector(".queue-row-bar");
    bar.classList.toggle("is-indeterminate", Boolean(item.progressIndeterminate));
    springProgressWidth(bar.querySelector("i"), item.progressRatio || 0, 0.36, 1);
    const open = row.querySelector(".queue-row-open");
    open.disabled = item.status !== "done";
    open.setAttribute("aria-label", item.status === "done" ? `${item.file.name} bulgularını aç` : item.file.name);
    if (previousStatus && previousStatus !== item.status) {
      springQueueState(row, 0.36, 1);
      springIn(row.querySelector(".queue-row-status"), 6, 0.36, 1);
    }
  }
}

function nextQueueItem() {
  return state.queue.find((item) => item.status === SCANNABLE_STATUS);
}

function finishCurrentQueueItem() {
  if (!state.currentQueueItem) return;
  updateQueueRow(state.currentQueueItem.id, { status: "done", progressText: "", progressRatio: 1, progressIndeterminate: false });
  state.currentQueueItem = null;
}

function updateBatchProgressHeading() {
  if (!state.batchScanning) return;
  const completed = state.queue.filter((item) => ["done", "error"].includes(item.status)).length;
  elements.batchSubtitle.textContent = `${completed} / ${state.queue.length} dosya tamamlandı · dosyalar sırayla işleniyor.`;
}

async function advanceQueue() {
  if (state.batchMode) {
    state.batchScanning = true;
    renderBatchDashboard("files");
  }
  while (!state.cancellingAll) {
    const next = nextQueueItem();
    if (!next) break;
    state.currentQueueItem = next;
    updateQueueRow(next.id, { status: "processing", progressText: "Dosya okunuyor…", progressRatio: 0, progressIndeterminate: true });
    state.pendingFile = next.file;
    state.preflightPromise = preflightFile(next.file);
    const succeeded = await handleFile(next.file, { backgroundQueue: state.batchMode });
    const cancelled = state.cancelledQueueItemId === next.id;
    state.currentQueueItem = null;
    if (cancelled) {
      state.queue = state.queue.filter((item) => item.id !== next.id);
      state.cancelledQueueItemId = null;
      renderQueue();
      if (state.batchMode) renderBatchDashboard("files");
      continue;
    }
    // Kullanıcının durdurduğu dosya "hata" değildir: sırada bekler ve "Belgeyi
    // tara" ikinci kez basıldığında hiçbir şey sıfırlanmadan yeniden başlar.
    if (state.cancelledScan) {
      state.cancelledScan = false;
      updateQueueRow(next.id, { status: SCANNABLE_STATUS, progressText: "", progressRatio: 0, progressIndeterminate: false });
      renderQueue();
      break;
    }
    if (succeeded) updateQueueRow(next.id, { status: "done", progressText: "", progressRatio: 1, progressIndeterminate: false });
    else updateQueueRow(next.id, { status: "error", progressText: "Tarama başarısız oldu · yeniden denenebilir", progressRatio: 0, progressIndeterminate: false });
    updateBatchProgressHeading();
    renderQueue();
  }
  state.batchScanning = false;
  beforeUnloadGuard.sync();
  setProcessing(false);
  if (state.batchMode && !state.cancellingAll && state.queue.length && elements.doneStage.hidden) {
    renderBatchDashboard("files", { preserveFileList: true });
  }
}

function setBatchView(view) {
  const summary = view === "summary";
  elements.batchSummaryView.hidden = !summary;
  elements.batchFilesView.hidden = summary;
  elements.batchSummaryTab.classList.toggle("is-active", summary);
  elements.batchFilesTab.classList.toggle("is-active", !summary);
  elements.batchSummaryTab.setAttribute("aria-selected", String(summary));
  elements.batchFilesTab.setAttribute("aria-selected", String(!summary));
}

function renderBatchDashboard(view = "summary", { preserveFileList = false } = {}) {
  const aggregate = aggregateQueueFindings(state.queue);
  const errorCount = state.queue.filter((item) => item.status === "error").length;
  elements.batchTitle.textContent = state.batchScanning ? "Dosya kuyruğu." : "Tarama özeti.";
  elements.batchSummaryTab.disabled = state.batchScanning;
  elements.batchSubtitle.textContent = state.batchScanning
    ? `${aggregate.fileCount} / ${state.queue.length} dosya tamamlandı · dosyalar sırayla işleniyor.`
    : `${aggregate.fileCount} dosya tarandı${errorCount ? ` · ${errorCount} dosyada hata` : ""}.`;
  elements.batchInstruction.hidden = state.batchScanning;
  elements.batchDownloadAll.disabled = state.batchScanning
    || state.bulkExporting
    || !state.queue.some((item) => item.status === "done");
  elements.batchTotal.textContent = `Toplam ${aggregate.findingCount.toLocaleString("tr-TR")} bulgu, ${aggregate.fileCount.toLocaleString("tr-TR")} dosya`;
  elements.aggregateGrid.replaceChildren(...aggregate.categories.map(({ label, count }) => {
    const card = document.createElement("div");
    card.className = "aggregate-card";
    const value = document.createElement("strong");
    value.textContent = count.toLocaleString("tr-TR");
    const category = document.createElement("span");
    category.textContent = label;
    card.append(value, category);
    return card;
  }));
  if (!aggregate.categories.length) {
    const empty = document.createElement("p");
    empty.className = "batch-note";
    empty.textContent = "Tamamlanan dosyalarda hassas bilgi bulunmadı.";
    elements.aggregateGrid.replaceChildren(empty);
  }
  if (!preserveFileList || !elements.batchFileList.children.length) {
    const fileItems = state.queue.map((item) => makeQueueItem(item, { dashboard: true }));
    fileItems.forEach((item, index) => springIn(item, Math.min(12, 5 + index * 1.5), 0.36, 1));
    elements.batchFileList.replaceChildren(...fileItems);
  }
  setBatchView(view);
  showStage(elements.batchStage);
}

function springAccordionHeight(panel, targetHeight, { expanding }) {
  stopSpring(panel);
  if (REDUCED_MOTION.matches) {
    panel.style.height = expanding ? "auto" : "0px";
    return Promise.resolve();
  }
  const omega = (2 * Math.PI) / 0.36;
  let position = panel.getBoundingClientRect().height;
  let velocity = 0;
  let previousTime = performance.now();
  return new Promise((resolve) => {
    const step = (time) => {
      const delta = Math.min((time - previousTime) / 1000, 1 / 30);
      previousTime = time;
      const displacement = position - targetHeight;
      const acceleration = -2 * omega * velocity - omega * omega * displacement;
      velocity += acceleration * delta;
      position += velocity * delta;
      panel.style.height = `${Math.max(0, position).toFixed(2)}px`;
      if (Math.abs(position - targetHeight) < 0.35 && Math.abs(velocity) < 0.35) {
        panel.style.height = expanding ? "auto" : "0px";
        springAnimations.delete(panel);
        resolve();
        return;
      }
      springAnimations.set(panel, requestAnimationFrame(step));
    };
    springAnimations.set(panel, requestAnimationFrame(step));
  });
}

async function closeQueueAccordionNow() {
  if (!state.expandedQueueItemId) return;
  const wrapper = elements.batchFileList.querySelector(`[data-queue-item-id="${CSS.escape(state.expandedQueueItemId)}"]`);
  const panel = wrapper?.querySelector(".queue-accordion");
  const inner = panel?.querySelector(".queue-accordion-inner");
  state.expandedQueueItemId = null;
  state.activeQueueItem = null;
  if (panel) {
    await Promise.all([
      springAccordionHeight(panel, 0, { expanding: false }),
      inner ? springAccordionContent(inner, false, 0.36, 1) : Promise.resolve(),
    ]);
  }
  elements.reviewStage.append(elements.reviewControls);
  panel?.remove();
  wrapper?.classList.remove("is-expanded");
  wrapper?.querySelector(".queue-row-open")?.setAttribute("aria-expanded", "false");
}

function closeQueueAccordion() {
  return runQueueAccordionTask(closeQueueAccordionNow);
}

async function toggleQueueItemNow(requestedItem) {
  const item = state.queue.find((entry) => entry.id === requestedItem.id);
  if (!item) return;
  if (item.status !== "done") return;
  if (state.expandedQueueItemId === item.id) {
    await closeQueueAccordionNow();
    return;
  }
  await closeQueueAccordionNow();
  revokeDownloads();
  await releaseContext();
  const wrapper = elements.batchFileList.querySelector(`[data-queue-item-id="${CSS.escape(item.id)}"]`);
  if (!wrapper) return;
  state.activeQueueItem = item;
  state.expandedQueueItemId = item.id;
  state.filename = item.file.name;
  state.findings = item.findings;
  state.replacementPlan = item.replacementPlan || [];
  state.selectedFindingIds = new Set(
    Array.isArray(item.selectedFindingIds) ? item.selectedFindingIds : item.findings.map((finding) => finding.id)
  );
  const panel = document.createElement("div");
  panel.className = "queue-accordion";
  const inner = document.createElement("div");
  inner.className = "queue-accordion-inner";
  const heading = document.createElement("div");
  heading.className = "queue-accordion-heading";
  const title = document.createElement("strong");
  title.textContent = item.file.name;
  const meta = document.createElement("span");
  const occurrences = item.findings.reduce((sum, finding) => sum + finding.count, 0);
  meta.textContent = `${occurrences} bulgu · dosyaya özel seçim`;
  heading.append(title, meta);
  inner.append(heading, elements.reviewControls);
  panel.append(inner);
  wrapper.append(panel);
  wrapper.classList.add("is-expanded");
  wrapper.querySelector(".queue-row-open")?.setAttribute("aria-expanded", "true");
  showScanWarning(item.scanWarning || null);
  renderReview({
    inline: true,
    reviewState: { filename: item.file.name, findings: item.findings },
  });
  await nextPaint();
  await Promise.all([
    springAccordionHeight(panel, inner.scrollHeight, { expanding: true }),
    springAccordionContent(inner, true, 0.36, 1),
  ]);
}

function toggleQueueItem(item) {
  return runQueueAccordionTask(() => toggleQueueItemNow(item));
}

async function cancelQueueItem(id) {
  const item = state.queue.find((entry) => entry.id === id);
  if (!item) return;
  if (state.currentQueueItem?.id === id) {
    state.cancelledQueueItemId = id;
    operationCoordinator.abort("scan", new DOMException("Dosya iptal edildi.", "AbortError"));
    return;
  }
  if (state.activeQueueItem?.id === id) {
    operationCoordinator.abort("export", new DOMException("Dosya çıktısı iptal edildi.", "AbortError"));
    revokeDownloads();
  }
  if (state.expandedQueueItemId) await closeQueueAccordion();
  await releaseContext();
  state.queue = state.queue.filter((entry) => entry.id !== id);
  renderQueue();
  if (!state.queue.length) await resetApp();
  else if (!elements.batchStage.hidden || !elements.reviewStage.hidden) renderBatchDashboard(elements.batchFilesView.hidden ? "summary" : "files");
}

async function cancelAllQueue() {
  if (!state.queue.length) return;
  if (!await confirmQueueCancellation()) return;
  state.cancellingAll = true;
  operationCoordinator.abortAll(new DOMException("Tüm işlem iptal edildi.", "AbortError"));
  await resetApp();
}

function renderBulkProgress({ current, total, filename, phase }) {
  const complete = phase === "archiving";
  const completed = Math.min(current, total);
  const percent = total ? Math.round((completed / total) * 100) : 0;
  setProcessing(
    true,
    complete ? "Dosyalar paketleniyor…" : "Tüm dosyalar maskeleniyor…",
    complete ? "Temiz kopyalar tek bir ZIP dosyasında hazırlanıyor." : `${filename} cihazında hazırlanıyor.`
  );
  elements.processingProgress.hidden = false;
  elements.processingUnits.textContent = `${completed.toLocaleString("tr-TR")} / ${total.toLocaleString("tr-TR")} dosya`;
  elements.progressBar.style.width = `${percent}%`;
  elements.processingPercent.textContent = `%${percent} tamamlandı`;
  elements.processingEta.textContent = complete ? "Paketleniyor…" : "Dosyalar sırayla işleniyor";
}

async function downloadAllQueueItems() {
  if (state.bulkExporting || state.batchScanning) return;
  const completedItems = state.queue.filter((item) => item.status === "done");
  if (!completedItems.length) return;
  state.bulkExporting = true;
  elements.batchDownloadAll.disabled = true;
  elements.batchDownloadAll.textContent = "Hazırlanıyor…";
  const { controller } = beginOperation("export");
  try {
    await closeQueueAccordion();
    await releaseContext();
    const [{ default: JSZip }, { createBulkArchive }, pipeline] = await Promise.all([
      import("jszip"),
      import("./bulk-export.js"),
      import("./pipeline.js"),
    ]);
    const bytes = await createBulkArchive(state.queue, {
      JSZip,
      extractDocument: pipeline.extractDocument,
      applyDocumentChanges: pipeline.applyDocumentChanges,
      disposeDocument: pipeline.disposeDocument,
      profile: state.profile,
      signal: controller.signal,
      onProgress: renderBulkProgress,
    });
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const date = new Date().toISOString().slice(0, 10);
    triggerDownload(url, `redakt_toplu_${date}.zip`);
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    state.bulkDownloadComplete = true;
    elements.batchInstruction.textContent = `${completedItems.length} dosyanın temiz kopyası tek ZIP olarak indirildi.`;
    window.setTimeout(() => {
      if (!state.bulkExporting) elements.batchInstruction.textContent = BATCH_INSTRUCTION;
    }, 4000);
  } catch (error) {
    if (error?.name !== "AbortError") showError(error instanceof Error ? error.message : "Toplu indirme hazırlanamadı.");
  } finally {
    finishOperation("export", controller);
    state.bulkExporting = false;
    beforeUnloadGuard.sync();
    elements.batchDownloadAll.textContent = "Tümünü Maskele ve İndir";
    elements.batchDownloadAll.disabled = state.batchScanning
      || !state.queue.some((item) => item.status === "done");
    setProcessing(false);
  }
}

function askConfirmation({ eyebrow, title, detail = "", accept, dismiss = "Vazgeç" }) {
  if (confirmResolver) return Promise.resolve(false);
  elements.confirmEyebrow.textContent = eyebrow;
  elements.confirmTitle.textContent = title;
  elements.confirmDetail.textContent = detail;
  elements.confirmDetail.hidden = !detail;
  elements.confirmAccept.textContent = accept;
  elements.confirmDismiss.textContent = dismiss;
  elements.confirmLayer.hidden = false;
  elements.confirmAccept.focus();
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function confirmQueueCancellation() {
  return askConfirmation({
    eyebrow: "Geri alınamaz işlem",
    title: "Tüm işlemi iptal etmek istediğine emin misin?",
    accept: "Hepsini İptal Et",
  });
}

// Kurumsal kurallar yüklenemediyse belge eksik maskelenebilir; sessizce devam edilmez.
async function confirmScanWithoutRules() {
  if (!shouldWarnBeforeScan(state.ruleSource)) return true;
  const unavailable = state.ruleSource?.status === RULE_SOURCE_STATUS.unavailable;
  return askConfirmation({
    eyebrow: "Eksik maskeleme riski",
    title: unavailable
      ? "Kurumsal kurallar yüklenemedi. Yine de devam edilsin mi?"
      : "Kurumsal kurallar güncel olmayabilir. Yine de devam edilsin mi?",
    detail: unavailable
      ? "Şirket veritabanındaki kurallar okunamadığı için firma ve kişi adları belgede maskelenmeden kalabilir."
      : describeRuleSource(state.ruleSource),
    accept: "Yine de tara",
  });
}

function settleQueueConfirmation(accepted) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  elements.confirmLayer.hidden = true;
  resolve(accepted);
}

// Klasör seçiminde işletim sisteminin ve Office'in kendi çöp dosyaları da
// gelir (.DS_Store, Thumbs.db, ~$ ile başlayan kilit dosyaları). Bunları
// "desteklenmeyen tür" diye saymak, kullanıcıya klasöründe olmayan bir sorunu
// bildirmek olurdu.
const IGNORED_FILENAMES = /^(?:\.|~\$)|^(?:Thumbs\.db|desktop\.ini)$/iu;

function baseName(file) {
  return String(file.name || "").split("/").pop();
}

async function buildQueueFromFileList(fileList, { onProgress, signal } = {}) {
  const files = [...fileList].filter((file) => !IGNORED_FILENAMES.test(baseName(file)));
  const acceptedPattern = new RegExp(`(?:${acceptedDocumentExtensions().map((extension) => extension.replace(".", "\\.")).join("|")})$`, "iu");
  const supported = files.filter((file) => acceptedPattern.test(file.name));
  const rejectedByType = files.length - supported.length;
  const withinSize = supported.filter((file) => file.size <= MAX_FILE_SIZE);
  const rejectedBySize = supported.filter((file) => file.size > MAX_FILE_SIZE);
  // Elenenler tek bir özet olarak bildirilir. Ayrı ayrı bildirildiğinde her
  // bildirim bir öncekinin üstüne yazılıyor, kullanıcı yalnız sonuncusunu
  // görüyordu; bir klasörde bu, onlarca dosyanın sessizce düşmesi demekti.
  const skipped = [];
  if (rejectedByType > 0) skipped.push(`${rejectedByType} dosya desteklenmeyen türde`);
  if (rejectedBySize.length) skipped.push(`${rejectedBySize.length} dosya 50 MB sınırının üstünde`);

  const genuine = [];
  const failedValidation = [];
  let processed = files.length - withinSize.length;
  onProgress?.(processed, files.length);
  for (const file of withinSize) {
    if (signal?.aborted) throw signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
    try {
      await validateDocumentBytes(await file.arrayBuffer(), file.name);
      genuine.push(file);
    } catch (error) {
      failedValidation.push(error instanceof Error ? error.message : `${baseName(file)} doğrulanamadı.`);
    }
    processed += 1;
    onProgress?.(processed, files.length);
  }
  if (failedValidation.length === 1) skipped.push(failedValidation[0]);
  else if (failedValidation.length > 1) skipped.push(`${failedValidation.length} dosya içerik doğrulamasından geçmedi`);
  if (skipped.length) showError(`Listeye alınmadı: ${skipped.join(" · ")}.`);

  return genuine.map((file) => ({
    id: makeQueueId(),
    file,
    status: "queued",
    progressText: "",
    progressRatio: 0,
    progressIndeterminate: false,
    findings: [],
    replacementPlan: [],
    selectedFindingIds: [],
  }));
}

// Klasör seçiminde işletim sisteminin penceresi yalnızca klasörleri listeler;
// kullanıcı ne seçtiğini orada göremez ve klasördeki her şey tek hamlede
// alınmış gibi hisseder. Karşılığı burada verilir: klasörden ne alındığı,
// neyin elendiği ve sıraya giren dosyaların tam listesi tarama başlamadan
// önce ekranda durur; istenmeyenler tek tek çıkarılabilir.
function selectFolder(files) {
  const relative = files.find((file) => file.webkitRelativePath)?.webkitRelativePath || "";
  return selectFiles(files, { folderName: relative.split("/")[0] || "", pickedCount: files.length });
}

async function selectFiles(fileList, { folderName = "", pickedCount = 0 } = {}) {
  const { controller, tracker } = beginOperation("scan");
  tracker.start("reading", Math.max(1, fileList.length), folderName
    ? `“${folderName}” klasöründeki ${fileList.length.toLocaleString("tr-TR")} dosyanın türü ve içeriği cihazında doğrulanıyor.`
    : "Dosya türü ve içeriği cihazında doğrulanıyor.");
  await nextPaint();
  let queue;
  try {
    queue = await buildQueueFromFileList(fileList, {
      signal: controller.signal,
      onProgress(current, total) {
        tracker.advance(current, `${total.toLocaleString("tr-TR")} dosyanın türü ve içeriği cihazında doğrulanıyor.`);
      },
    });
  } catch (error) {
    if (error?.name !== "AbortError") showError(error instanceof Error ? error.message : "Dosyalar doğrulanamadı.");
    return;
  } finally {
    setProcessing(false);
    document.title = DEFAULT_DOCUMENT_TITLE;
    finishOperation("scan", controller);
  }
  if (!queue.length) {
    if (folderName) showError(`“${folderName}” klasöründe taranabilecek DOCX, XLSX, PDF, TXT, JPG veya PNG dosyası bulunamadı.`);
    else if (fileList.length) showError("Geçerli bir DOCX, XLSX, PDF, UTF-8 TXT, JPG veya PNG dosyası seçin.");
    return;
  }

  state.queue = queue;
  state.currentQueueItem = null;
  state.activeQueueItem = null;
  state.expandedQueueItemId = null;
  state.cancelledQueueItemId = null;
  state.cancellingAll = false;
  state.batchMode = queue.length > 1;
  elements.processingCancel.textContent = state.batchMode ? "Hepsini İptal Et" : "İptal et";
  const reviewBackIcon = document.createElement("span");
  reviewBackIcon.setAttribute("aria-hidden", "true");
  reviewBackIcon.textContent = "‹";
  elements.reviewBack.replaceChildren(reviewBackIcon, document.createTextNode(" Başka dosya seç"));
  renderQueue();

  const skippedFromFolder = Math.max(0, pickedCount - queue.length);
  const folderNote = folderName
    ? `“${folderName}” klasöründen ${queue.length.toLocaleString("tr-TR")} dosya alındı${skippedFromFolder ? ` · ${skippedFromFolder.toLocaleString("tr-TR")} dosya atlandı` : ""}`
    : "";
  if (queue.length === 1) {
    const file = queue[0].file;
    state.pendingFile = file;
    state.preflightPromise = preflightFile(file);
    elements.selectedFilename.textContent = file.webkitRelativePath || file.name;
    elements.selectedFilenameDetail.textContent = folderNote || "Tarama ayarlarını seç";
    elements.scanButtonLabel.textContent = "Belgeyi tara";
  } else {
    state.pendingFile = null;
    state.preflightPromise = null;
    elements.largeFileWarning.hidden = true;
    elements.largeFileWarning.textContent = "";
    elements.selectedFilename.textContent = folderName
      ? `“${folderName}” · ${queue.length} dosya`
      : `${queue.length} dosya seçildi`;
    elements.selectedFilenameDetail.textContent = folderNote
      ? `${folderNote} · istemediklerini listeden çıkarabilirsin`
      : "Tarama ayarlarını seç · dosyalar sırayla, tek tek işlenecek";
    elements.scanButtonLabel.textContent = `Taramayı başlat (${queue.length} dosya)`;
  }
  elements.scanSetup.hidden = false;
  elements.scanSetup.scrollIntoView({ behavior: REDUCED_MOTION.matches ? "auto" : "smooth", block: "nearest" });
}

function installPressFeedback(element) {
  let pointerId = null;
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointerId = event.pointerId;
    element.setPointerCapture?.(pointerId);
    stopSpring(element);
    element.classList.add("is-pressed");
  });
  element.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    const bounds = element.getBoundingClientRect();
    const inside = event.clientX >= bounds.left - 10 && event.clientX <= bounds.right + 10
      && event.clientY >= bounds.top - 10 && event.clientY <= bounds.bottom + 10;
    element.classList.toggle("is-pressed", inside);
  });
  const release = (event) => {
    if (event.pointerId !== pointerId) return;
    element.classList.remove("is-pressed");
    pointerId = null;
  };
  element.addEventListener("pointerup", release);
  element.addEventListener("pointercancel", release);
}

function updateDragFollower() {
  dragFrame = null;
  elements.dragFollower.style.transform = `translate3d(${dragPosition.x - 34}px, ${dragPosition.y - 34}px, 0)`;
}

function showDragFollower(event) {
  dragPosition = { x: event.clientX, y: event.clientY };
  if (!dragFrame) dragFrame = requestAnimationFrame(updateDragFollower);
  elements.dragFollower.classList.add("is-visible");
  elements.uploadStage.classList.add("is-window-dragging");
  elements.dropZone.classList.add("is-dragging");
}

function hideDragFollower() {
  elements.dragFollower.classList.remove("is-visible");
  elements.uploadStage.classList.remove("is-window-dragging");
  elements.dropZone.classList.remove("is-dragging");
}

document.querySelectorAll(".pressable").forEach(installPressFeedback);
document.querySelectorAll(".danger-outline").forEach(installDangerHover);
elements.ruleAdd.addEventListener("click", addCustomRule);
elements.ruleRefreshButton.addEventListener("click", () => loadCorporateRules());
elements.modelStorageClear.addEventListener("click", async () => {
  elements.modelStorageClear.disabled = true;
  try {
    const removed = await clearNerModelCache();
    showError(removed
      ? `Model bu cihazdan kaldırıldı (${removed} dosya). Sonraki taramada yeniden indirilecek.`
      : "Kaldırılacak model dosyası bulunamadı.");
  } catch {
    showError("Model önbelleği temizlenemedi.");
  } finally {
    elements.modelStorageClear.disabled = false;
    renderModelStorage();
  }
});
loadCorporateRules();
renderModelStorage();
const recommendation = recommendedProfile();
elements.deviceRecommendation.textContent = recommendation === "thorough"
  ? "Bu cihazda Kapsamlı tarama kullanılabilir. Varsayılan seçim: Dengeli."
  : `Bu cihaz için önerilen: ${processingProfiles[recommendation].label}. Varsayılan seçim: Dengeli.`;
for (const input of document.querySelectorAll('input[name="processing-profile"]')) {
  input.addEventListener("change", () => {
    if (input.checked) state.profile = input.value;
  });
}
// Tarama başarısız olduğunda dosya kuyrukta "error" durumunda kalıyor,
// nextQueueItem() da yalnızca "queued" dosyalara bakıyordu: "Belgeyi tara"
// düğmesi sessizce hiçbir şey yapmıyor, kullanıcı sayfayı yenilemeden ikinci
// denemeyi yapamıyordu. Yeniden denemede hatalı dosyalar sıraya geri alınır.
function requeueFailedItems() {
  for (const item of itemsToRequeue(state.queue)) {
    updateQueueRow(item.id, { status: SCANNABLE_STATUS, progressText: "", progressRatio: 0, progressIndeterminate: false });
  }
}

// Kural doğrulaması taramanın içinde patlıyordu: kullanıcı hata mesajını
// görüyor, dosya "hata"ya düşüyor, düzeltip yeniden denemek istediğinde de
// düğme cevap vermiyordu. Doğrulama artık tarama başlamadan yapılır ve eksik
// alan doğrudan odaklanır.
function customRulesReadyForScan() {
  try {
    normalizeCustomRules(state.customRules);
    return true;
  } catch (error) {
    showError(error instanceof Error ? error.message : "Özel kurallar doğrulanamadı.");
    const broken = state.customRules.find((rule) =>
      Boolean(String(rule.find || "").trim()) !== Boolean(String(rule.replacement || "").trim()));
    const row = broken && elements.customRulesList.querySelector(`[data-rule-id="${CSS.escape(broken.id)}"]`);
    if (row) {
      const inputs = [...row.querySelectorAll("input")];
      (inputs.find((input) => !input.value.trim()) || inputs[0])?.focus();
      row.scrollIntoView({ behavior: REDUCED_MOTION.matches ? "auto" : "smooth", block: "center" });
    }
    return false;
  }
}

elements.scanButton.addEventListener("click", async () => {
  if (!canStartScan(state.queue)) return;
  if (state.batchScanning || operationCoordinator.active("scan")) return;
  if (!customRulesReadyForScan()) return;
  requeueFailedItems();
  if (!nextQueueItem()) return;
  if (!(await confirmScanWithoutRules())) return;
  state.cancellingAll = false;
  advanceQueue();
});
elements.changeFile.addEventListener("click", () => elements.fileInput.click());
elements.folderSelectButton.addEventListener("click", () => elements.folderInput.click());
elements.processingCancel.addEventListener("click", () => {
  if (state.batchMode) {
    cancelAllQueue();
    return;
  }
  if (!operationCoordinator.abort("export", new DOMException("İşlem iptal edildi.", "AbortError"))) {
    // Bayrak yalnızca gerçekten bir kuyruk dosyası taranırken kalkar. Dosya
    // DOĞRULAMASI sırasında iptal edildiğinde advanceQueue hiç koşmadığı için
    // bayrak açık kalıyor, bir SONRAKİ başarılı tarama iptal sayılıp çöpe
    // atılıyor ve kullanıcı çıkışsız bir ekranda kalıyordu.
    state.cancelledScan = Boolean(state.currentQueueItem);
    operationCoordinator.abort("scan", new DOMException("İşlem iptal edildi.", "AbortError"));
  }
  setProcessing(false);
  showError("İşlem iptal edildi; kısmi dosya oluşturulmadı.");
});

elements.dropZone.addEventListener("click", () => elements.fileInput.click());
elements.dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    elements.fileInput.click();
  }
});
// Girdi değeri hemen boşaltılır: aksi hâlde aynı dosya ya da aynı klasör
// ikinci kez seçildiğinde "change" hiç tetiklenmez ve uygulama tepkisiz görünür.
function takeSelection(input) {
  const files = [...input.files];
  input.value = "";
  return files;
}

elements.fileInput.addEventListener("change", () => {
  const files = takeSelection(elements.fileInput);
  if (files.length) selectFiles(files);
});
elements.folderInput.addEventListener("change", () => {
  const files = takeSelection(elements.folderInput);
  if (files.length) selectFolder(files);
});

window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth += 1;
  showDragFollower(event);
});
window.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  showDragFollower(event);
});
window.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) hideDragFollower();
});
// İnceleme, bitiş ya da toplu sahnedeyken pencereye dosya bırakmak kuyruğu
// değiştiriyor ama sahne değişmiyordu: kullanıcı eski ekranda, artık var
// olmayan bir kuyrukla, hiçbir düğmesi çalışmayan bir görüntüde kalıyordu.
// Yeni dosya baştan başlamak demektir; kendi kuralların korunur.
async function returnToUploadStage() {
  if (!elements.uploadStage.hidden) return;
  revokeDownloads();
  await closeQueueAccordion();
  await releaseContext();
  state.findings = [];
  state.replacementPlan = [];
  state.activeQueueItem = null;
  state.expandedQueueItemId = null;
  state.batchMode = false;
  state.batchScanning = false;
  state.bulkDownloadComplete = false;
  state.activeFindingCategory = null;
  showScanWarning(null);
  elements.reviewStage.append(elements.reviewControls);
  showStage(elements.uploadStage);
}

window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  hideDragFollower();
  const files = [...event.dataTransfer.files];
  if (!files.length) return;
  returnToUploadStage().then(() => selectFiles(files));
});

elements.selectAll.addEventListener("change", () => {
  if (elements.selectAll.checked) state.selectedFindingIds = new Set(state.findings.map((finding) => finding.id));
  else state.selectedFindingIds.clear();
  for (const input of elements.findingList.querySelectorAll("input[type='checkbox']")) {
    input.checked = state.selectedFindingIds.has(input.value);
    springCheckboxToggle(input.nextElementSibling, 0.36, 1);
  }
  updateSelection();
});
elements.redactButton.addEventListener("click", processSelection);
elements.reviewBack.addEventListener("click", async () => {
  if (state.batchMode) {
    await closeQueueAccordion();
    await releaseContext();
    renderBatchDashboard("files");
  } else await resetApp();
});
elements.brandButton.addEventListener("click", resetApp);
elements.startOver.addEventListener("click", resetApp);
elements.doneBatchBack.addEventListener("click", async () => {
  revokeDownloads();
  await closeQueueAccordion();
  renderBatchDashboard("files");
});
elements.batchBack.addEventListener("click", resetApp);
elements.batchSummaryTab.addEventListener("click", async () => {
  await closeQueueAccordion();
  setBatchView("summary");
});
elements.batchFilesTab.addEventListener("click", () => setBatchView("files"));
elements.queueCancelAll.addEventListener("click", cancelAllQueue);
elements.batchCancelAll.addEventListener("click", cancelAllQueue);
elements.batchDownloadAll.addEventListener("click", downloadAllQueueItems);
elements.confirmDismiss.addEventListener("click", () => settleQueueConfirmation(false));
elements.confirmAccept.addEventListener("click", () => settleQueueConfirmation(true));
elements.confirmLayer.addEventListener("keydown", (event) => {
  if (event.key === "Escape") settleQueueConfirmation(false);
});
elements.downloadButton.addEventListener("click", () => triggerDownload(state.outputUrl, state.outputName));
elements.mappingDownload.addEventListener("click", () => triggerDownload(state.mappingUrl, state.mappingName));
elements.toastClose.addEventListener("click", () => {
  window.clearTimeout(toastTimer);
  elements.toast.hidden = true;
});
elements.fatalErrorReload.addEventListener("click", () => window.location.reload());
installGlobalErrorBoundary({
  isProcessing: processingIsActive,
  onFatal: showFatalErrorFallback,
});
