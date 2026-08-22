import { env, pipeline } from "@huggingface/transformers";
import { categoryMeta, matchKey, normalizeValue } from "./pii.js";
import { createModelDownloadAggregator } from "./model-cache.js";
import ortWasmModuleUrl from "./vendor/ort-wasm-simd-threaded.jsep.mjs?url";
import { processingConfig } from "./profiles.js";

const MODEL_ID = "redakt-turkish-ner";
const MIN_ENTITY_SCORE = 0.84;
const MAX_CHUNK_LENGTH = 1200;
const ENTITY_CATEGORIES = Object.freeze({ PER: "person", ORG: "organization", LOC: "location" });
const IS_BROWSER = typeof window !== "undefined" || typeof WorkerGlobalScope !== "undefined";
const BASE_URL = import.meta.env?.BASE_URL || (IS_BROWSER ? "/" : "public/");

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = IS_BROWSER;
env.localModelPath = `${BASE_URL}models/`;
if (IS_BROWSER) {
  const runtimeOrigin = globalThis.location?.origin || "http://127.0.0.1";
  env.backends.onnx.wasm.wasmPaths = {
    mjs: new URL(ortWasmModuleUrl, runtimeOrigin).href,
    wasm: new URL("./vendor/ort-wasm-simd-threaded.jsep.wasm", import.meta.url).href,
  };
}

let modelPromise = null;

export function configureNerRuntime({ modelPath } = {}) {
  if (modelPromise) return;
  if (modelPath) env.localModelPath = modelPath.endsWith("/") ? modelPath : `${modelPath}/`;
}

function loadModel(progressCallback) {
  if (!modelPromise) {
    const downloadProgress = createModelDownloadAggregator();
    modelPromise = pipeline("token-classification", MODEL_ID, {
      device: IS_BROWSER ? "wasm" : "cpu",
      dtype: "q4",
      progress_callback(progress) {
        const aggregate = downloadProgress.update(progress);
        if (aggregate) progressCallback?.(aggregate);
      },
    }).then((classifier) => {
      progressCallback?.(downloadProgress.complete());
      return classifier;
    }).catch((error) => {
      modelPromise = null;
      throw error;
    });
  }
  return modelPromise;
}

function foldForAlignment(value) {
  return String(value).normalize("NFC").toLocaleLowerCase("tr-TR");
}

function findAlignedPiece(text, token, cursor) {
  const continuation = token.startsWith("##");
  const piece = token.replace(/^##/u, "");
  if (!piece || piece === "[UNK]") return null;

  let searchStart = cursor;
  if (!continuation) {
    while (/\s/u.test(text[searchStart] || "")) searchStart += 1;
  }

  const foldedText = foldForAlignment(text);
  const foldedPiece = foldForAlignment(piece);
  const direct = foldedText.slice(searchStart, searchStart + foldedPiece.length);
  let start = direct === foldedPiece
    ? searchStart
    : foldedText.indexOf(foldedPiece, searchStart);

  if (start < 0 || start - searchStart > 64) return null;
  return { start, end: start + piece.length, continuation, piece };
}

function cleanEntitySpan(text, start, end) {
  const leading = /^[\s“”"()\[\]{},;:]+/u.exec(text.slice(start, end));
  const trailing = /[\s“”"()\[\]{},;:]+$/u.exec(text.slice(start, end));
  return {
    start: start + (leading?.[0].length || 0),
    end: end - (trailing?.[0].length || 0),
  };
}

function meaningfulCharacterCount(value) {
  return [...value].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
}

function lineAt(text, position) {
  const start = text.lastIndexOf("\n", Math.max(0, position - 1)) + 1;
  const newline = text.indexOf("\n", position);
  const end = newline < 0 ? text.length : newline;
  return { start, end, text: text.slice(start, end) };
}

function hasPostalStructure(value) {
  return /(?:\b[A-Z]{2}[- ]\d{4,6}\b|\b\d{2,3}-\d{3}\b)/iu.test(value);
}

function isAddressLikeFragment(text, start, end, value, type) {
  if (type === "LOC" || value.includes("\n")) return false;
  const line = lineAt(text, start);
  const relativeStart = Math.max(0, start - line.start);
  const relativeEnd = Math.min(line.text.length, end - line.start);
  const surroundingText = `${line.text.slice(0, relativeStart)} ${line.text.slice(relativeEnd)}`;
  const nextLine = line.end < text.length ? lineAt(text, line.end + 1).text : "";
  const embeddedAmongOtherWords = (surroundingText.match(/[\p{L}]{2,}/gu) || []).length >= 2;
  const currentLineHasAddressNumbers = hasPostalStructure(line.text)
    || /\b\d{1,5}\s*[,/]\s*\d{2,6}\b/u.test(line.text);
  return currentLineHasAddressNumbers || (embeddedAmongOtherWords && hasPostalStructure(nextLine));
}

export function groupNerTokens(text, tokens, threshold = MIN_ENTITY_SCORE) {
  const entities = [];
  let cursor = 0;
  let current = null;

  const flush = () => {
    if (!current) return;
    const span = cleanEntitySpan(text, current.start, current.end);
    const value = text.slice(span.start, span.end);
    const score = current.scores.reduce((sum, item) => sum + item, 0) / current.scores.length;
    const category = ENTITY_CATEGORIES[current.type];
    if (category
      && meaningfulCharacterCount(value) >= 2
      && !isAddressLikeFragment(text, span.start, span.end, value, current.type)
      && score >= threshold) {
      entities.push({
        category,
        start: span.start,
        end: span.end,
        raw: value,
        normalized: normalizeValue(category, value),
        score,
      });
    }
    current = null;
  };

  for (const token of tokens) {
    const aligned = findAlignedPiece(text, token.word, cursor);
    if (!aligned) {
      flush();
      continue;
    }
    cursor = aligned.end;

    if (token.entity === "O") {
      flush();
      continue;
    }

    const [bio, type] = String(token.entity).split("-");
    if (!ENTITY_CATEGORIES[type]) {
      flush();
      continue;
    }

    const startsAnother = current
      && (current.type !== type || (bio === "B" && !aligned.continuation));
    if (startsAnother) flush();
    if (!current) current = { type, start: aligned.start, end: aligned.end, scores: [] };
    current.end = aligned.end;
    current.scores.push(Number(token.score) || 0);
  }
  flush();
  return entities;
}

export function chunkText(text, maxLength = MAX_CHUNK_LENGTH, overlap = 0) {
  if (text.length <= maxLength) return [{ text, offset: 0 }];
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + maxLength, text.length);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf(". ", end),
        text.lastIndexOf("! ", end),
        text.lastIndexOf("? ", end),
        text.lastIndexOf("; ", end),
        text.lastIndexOf(" ", end)
      );
      if (boundary > offset + Math.floor(maxLength * 0.58)) end = boundary + 1;
    }
    chunks.push({ text: text.slice(offset, end), offset });
    if (end >= text.length) break;
    offset = Math.max(offset + 1, end - overlap);
    while (/\s/u.test(text[offset] || "")) offset += 1;
  }
  return chunks;
}

function aggregateEntities(entities) {
  const aggregate = new Map();
  for (const entity of entities) {
    const key = matchKey(entity.category, entity.normalized);
    const current = aggregate.get(key);
    if (current) {
      current.count += 1;
      current.score = Math.max(current.score, entity.score);
      current.variants.add(entity.raw);
    } else {
      aggregate.set(key, { ...entity, count: 1, variants: new Set([entity.raw]), locations: [] });
    }
    aggregate.get(key).locations.push({ unitIndex: entity.textIndex, start: entity.start, end: entity.end });
  }

  const categoryCounts = { person: 0, organization: 0, location: 0 };
  return [...aggregate.values()].map((item, index) => {
    categoryCounts[item.category] += 1;
    const meta = categoryMeta[item.category];
    return {
      id: `ner_${index + 1}`,
      source: "ner",
      category: item.category,
      label: meta.label,
      value: item.raw,
      originalText: item.raw,
      variants: [...item.variants],
      normalized: item.normalized,
      count: item.count,
      score: item.score,
      confidence: "probable",
      placeholder: `[${meta.prefix}_${categoryCounts[item.category]}]`,
      replacementText: `[${meta.prefix}_${categoryCounts[item.category]}]`,
      locations: item.locations,
    };
  });
}

export async function detectNamedEntities(texts, {
  onProgress,
  profile = "balanced",
  signal,
  inferenceBatchSize = 1,
  interBatchDelayMs = 0,
} = {}) {
  const sourceTexts = texts.map(String).filter((text) => text.trim().length > 0);
  if (!sourceTexts.length) return [];

  const classifier = await loadModel((progress) => onProgress?.({ phase: "model", ...progress }));
  const config = processingConfig(profile);
  const work = sourceTexts.flatMap((text, textIndex) =>
    chunkText(text, config.ner.maxChunkLength, config.ner.overlap).map((chunk) => ({ ...chunk, textIndex }))
  );
  const uniqueEntities = new Map();

  const safeBatchSize = Math.max(1, Math.min(32, Number(inferenceBatchSize) || 1));
  const safeDelayMs = Math.max(0, Math.min(20, Number(interBatchDelayMs) || 0));
  for (let index = 0; index < work.length; index += safeBatchSize) {
    if (signal?.aborted) throw signal.reason || new DOMException("İşlem iptal edildi.", "AbortError");
    const inferenceWork = work.slice(index, index + safeBatchSize);
    const outputs = await classifier(
      inferenceWork.length === 1 ? inferenceWork[0].text : inferenceWork.map((chunk) => chunk.text),
      { ignore_labels: [], truncation: true, max_length: 512 }
    );
    const tokenGroups = inferenceWork.length === 1 ? [outputs] : outputs;
    for (let batchIndex = 0; batchIndex < inferenceWork.length; batchIndex += 1) {
      const chunk = inferenceWork[batchIndex];
      for (const entity of groupNerTokens(chunk.text, tokenGroups[batchIndex] || [])) {
        const detected = {
          ...entity,
          start: entity.start + chunk.offset,
          end: entity.end + chunk.offset,
          textIndex: chunk.textIndex,
        };
        const key = `${detected.textIndex}:${detected.start}:${detected.end}:${detected.category}`;
        const existing = uniqueEntities.get(key);
        if (!existing || detected.score > existing.score) uniqueEntities.set(key, detected);
      }
    }
    onProgress?.({ phase: "inference", current: Math.min(index + inferenceWork.length, work.length), total: work.length });
    if (safeDelayMs > 0 && index + safeBatchSize < work.length) {
      await new Promise((resolve) => setTimeout(resolve, safeDelayMs));
    }
  }
  return aggregateEntities([...uniqueEntities.values()]);
}

export const nerModel = Object.freeze({
  id: "akdeniz27/bert-base-turkish-cased-ner",
  runtime: "Transformers.js · ONNX Runtime Web",
  dtype: "q4",
  threshold: MIN_ENTITY_SCORE,
});
