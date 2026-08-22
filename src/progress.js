const PHASE_LABELS = Object.freeze({
  reading: "Dosya okunuyor",
  extracting: "İçerik çıkarılıyor",
  model: "Yerel model hazırlanıyor",
  ocr: "Taranmış sayfalar işleniyor",
  rules: "Kaydedilen kurallar karşılaştırılıyor",
  detecting: "Hassas bilgiler aranıyor",
  reviewPreparation: "Bulgular hazırlanıyor",
  redacting: "Seçilen bilgiler maskeleniyor",
  exporting: "Güvenli çıktı hazırlanıyor",
});

const UNIT_LABELS = Object.freeze({
  reading: "dosya okundu",
  extracting: "belge ayrıştırıldı",
  ocr: "sayfa OCR ile okundu",
  rules: "kayıt karşılaştırıldı",
  detecting: "satır tarandı",
  reviewPreparation: "inceleme hazırlandı",
  redacting: "sayfa düzleştirildi",
  exporting: "çıktı hazırlandı",
});

const ETA_SAMPLE_WINDOW = 5;

export function formatRemaining(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 10) return "Kalan süre: < 10 saniye";
  if (seconds < 60) return `Kalan süre: ~${seconds} saniye`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `Kalan süre: ~${minutes} dk ${remainder} sn` : `Kalan süre: ~${minutes} dakika`;
}

export function unitLabel(phase) {
  return UNIT_LABELS[phase] || "";
}

/**
 * Tracks progress for one countable phase at a time using real item counts
 * only (no phase-weighted percentage guessing). Switching phases (start())
 * honestly resets to that phase's own total instead of blending unrelated
 * units into one fabricated number. Within a phase, completed only ever
 * moves forward. The ETA is a rolling average over the last few samples
 * (~5 batches), not a single-sample extrapolation.
 */
export class ProgressTracker {
  constructor(onUpdate, now = () => performance.now()) {
    this.onUpdate = onUpdate;
    this.now = now;
    this.startedAt = now();
    this.phase = null;
    this.completed = 0;
    this.total = 0;
    this.samples = [];
  }

  start(phase, total = 0, detail = "") {
    this.phase = phase;
    this.total = Math.max(0, Math.round(total));
    this.completed = 0;
    this.samples = [{ timestamp: this.now(), completed: 0 }];
    return this.emit(detail);
  }

  advance(completed, detail = "") {
    const timestamp = this.now();
    const numericCompleted = Number(completed);
    if (Number.isFinite(numericCompleted)) {
      this.completed = Math.max(this.completed, Math.min(this.total, Math.max(0, numericCompleted)));
    }
    this.samples.push({ timestamp, completed: this.completed });
    if (this.samples.length > ETA_SAMPLE_WINDOW + 1) this.samples.shift();
    return this.emit(detail);
  }

  estimateRemainingMs() {
    if (this.samples.length < 4) return undefined;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const itemsDone = last.completed - first.completed;
    const elapsedMs = last.timestamp - first.timestamp;
    if (itemsDone <= 0 || elapsedMs <= 0) return undefined;
    const msPerItem = elapsedMs / itemsDone;
    const remainingItems = Math.max(0, this.total - this.completed);
    return msPerItem * remainingItems;
  }

  emit(detail = "") {
    const timestamp = this.now();
    const progress = this.total > 0 ? this.completed / this.total : 0;
    const payload = {
      phase: this.phase,
      phaseLabel: PHASE_LABELS[this.phase] || "İşleniyor",
      unitLabel: UNIT_LABELS[this.phase] || "",
      completedUnits: this.completed,
      totalUnits: this.total,
      progress,
      elapsedMs: timestamp - this.startedAt,
      estimatedRemainingMs: this.estimateRemainingMs(),
      detail,
    };
    this.onUpdate?.(payload);
    return payload;
  }
}

export function createProgressTracker(onUpdate, now) {
  return new ProgressTracker(onUpdate, now);
}
