import JSZip from "jszip";
import * as XLSX from "xlsx";
import {
  aggregateFindings,
  createReplacementMap,
  NUMERIC_SAFE_CATEGORIES,
  replaceText,
  replacementsForText,
} from "./pii.js";
import { redactEmbeddedImages, scanEmbeddedImages } from "./office-images.js";

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_MIME = "application/pdf";

function extensionOf(filename) {
  const match = /\.[^.]+$/u.exec(filename.toLowerCase());
  return match ? match[0] : "";
}

function requireXmlTools() {
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    throw new Error("Bu tarayıcı Office XML dosyalarını işlemek için gereken desteği sunmuyor.");
  }
}

function parseWordXml(xml) {
  requireXmlTools();
  const document = new DOMParser().parseFromString(xml.replace(/^\uFEFF/u, ""), "application/xml");
  if (document.getElementsByTagName("parsererror").length) {
    throw new Error("Word belgesinin metin yapısı okunamadı.");
  }
  return document;
}

function wordParagraphs(xmlDocument) {
  return Array.from(xmlDocument.getElementsByTagNameNS(WORD_NAMESPACE, "p"));
}

function textNodesInParagraph(paragraph) {
  return Array.from(paragraph.getElementsByTagNameNS(WORD_NAMESPACE, "t"));
}

function paragraphText(paragraph) {
  return textNodesInParagraph(paragraph).map((node) => node.textContent || "").join("");
}

function preserveWhitespace(node) {
  const text = node.textContent || "";
  if (/^\s|\s$/u.test(text)) node.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
}

function replaceWordParagraph(paragraph, replacementMap) {
  const nodes = textNodesInParagraph(paragraph);
  if (!nodes.length) return;
  const original = nodes.map((node) => node.textContent || "").join("");
  const replacements = replacementsForText(original, replacementMap);
  if (!replacements.length) return;

  const starts = [];
  let cursor = 0;
  for (const node of nodes) {
    starts.push(cursor);
    cursor += (node.textContent || "").length;
  }

  const locate = (position) => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (starts[index] <= position) return [index, position - starts[index]];
    }
    return [0, position];
  };

  for (const match of [...replacements].reverse()) {
    const [startNodeIndex, startOffset] = locate(match.start);
    const [endNodeIndex, finalCharacterOffset] = locate(match.end - 1);
    const endOffset = finalCharacterOffset + 1;
    const startNode = nodes[startNodeIndex];
    const endNode = nodes[endNodeIndex];

    if (startNodeIndex === endNodeIndex) {
      const text = startNode.textContent || "";
      startNode.textContent = text.slice(0, startOffset) + match.placeholder + text.slice(endOffset);
      preserveWhitespace(startNode);
      continue;
    }

    const prefix = (startNode.textContent || "").slice(0, startOffset);
    const suffix = (endNode.textContent || "").slice(endOffset);
    startNode.textContent = prefix + match.placeholder;
    for (let index = startNodeIndex + 1; index < endNodeIndex; index += 1) {
      nodes[index].textContent = "";
    }
    endNode.textContent = suffix;
    preserveWhitespace(startNode);
    preserveWhitespace(endNode);
  }
}

function cellText(cell) {
  if (!cell || cell.f) return null;
  if (typeof cell.v === "string") return { text: cell.v, numeric: false };
  if (typeof cell.v === "number" && Number.isSafeInteger(cell.v)) return { text: String(cell.v), numeric: true };
  return null;
}

function workbookCells(workbook) {
  const cells = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet["!ref"]) continue;
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const cell = sheet[address];
        const result = cellText(cell);
        if (result) cells.push({ cell, text: result.text, numeric: result.numeric, address, sheetName });
      }
    }
  }
  return cells;
}

function appendImageUnits(units, images, kind) {
  for (const image of images) {
    if (!image.text.trim()) continue;
    image.unitIndex = units.length;
    units.push({
      text: image.text,
      location: { kind: "office-image", documentKind: kind, mediaPath: image.path },
    });
  }
}

export async function scanDocx(arrayBuffer, filename, options = {}) {
  const zip = await JSZip.loadAsync(arrayBuffer, { checkCRC32: true });
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("Bu dosya geçerli bir DOCX belgesi değil.");
  const xml = await entry.async("string");
  const xmlDocument = parseWordXml(xml);
  const paragraphs = wordParagraphs(xmlDocument);
  const units = paragraphs
    .map((paragraph, paragraphIndex) => ({ text: paragraphText(paragraph), location: { kind: "docx", paragraphIndex } }))
    .filter((unit) => unit.text);
  const ocrImages = await scanEmbeddedImages(zip, "word/media", options);
  appendImageUnits(units, ocrImages, "docx");
  const texts = units.map((unit) => unit.text);
  const findings = aggregateFindings(units);
  return {
    context: { kind: "docx", filename, zip, xmlDocument, texts, units, ocrImages, ocrImageCount: ocrImages.length },
    findings,
  };
}

export async function scanXlsx(arrayBuffer, filename, options = {}) {
  const workbook = XLSX.read(arrayBuffer, {
    type: "array",
    cellStyles: true,
    cellFormula: true,
    cellDates: true,
    bookVBA: true,
  });
  const originalZip = await JSZip.loadAsync(arrayBuffer, { checkCRC32: true });
  if (!originalZip.file("xl/workbook.xml")) throw new Error("Bu dosya geçerli bir XLSX çalışma kitabı değil.");
  const cells = workbookCells(workbook);
  const units = cells.map(({ text, address, sheetName, numeric }) => ({
    text,
    location: { kind: "xlsx", sheetName, address },
    categories: numeric ? NUMERIC_SAFE_CATEGORIES : null,
  }));
  const ocrImages = await scanEmbeddedImages(originalZip, "xl/media", options);
  appendImageUnits(units, ocrImages, "xlsx");
  const texts = units.map((unit) => unit.text);
  const findings = aggregateFindings(units);
  return {
    context: { kind: "xlsx", filename, workbook, originalZip, texts, units, ocrImages, ocrImageCount: ocrImages.length },
    findings,
  };
}

export async function estimateXlsxRows(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const worksheetEntries = Object.values(zip.files).filter((entry) =>
    !entry.dir && /^xl\/worksheets\/sheet\d+\.xml$/u.test(entry.name)
  );
  let totalRows = 0;
  for (const entry of worksheetEntries) {
    const xml = await entry.async("string");
    const dimension = /<(?:\w+:)?dimension\b[^>]*\bref="(?:[^:"]+:)?[A-Z]+(\d+)"/iu.exec(xml);
    if (dimension) totalRows += Number(dimension[1]) || 0;
    else totalRows += (xml.match(/<(?:\w+:)?row\b/gu) || []).length;
  }
  return totalRows;
}

export async function scanOffice(arrayBuffer, filename, options = {}) {
  const extension = extensionOf(filename);
  if (extension === ".docx") return scanDocx(arrayBuffer, filename, options);
  if (extension === ".xlsx") return scanXlsx(arrayBuffer, filename, options);
  if (extension === ".pdf") {
    const { scanPdf } = await import("./pdf.js");
    return scanPdf(arrayBuffer, filename, options);
  }
  throw new Error("Yalnızca .docx, .xlsx ve metin katmanlı .pdf dosyaları destekleniyor.");
}

export async function scanOfficeNamedEntities(context, options = {}) {
  const { detectNamedEntities } = await import("./ner.js");
  return detectNamedEntities(context.texts || [], options);
}

export async function disposeOfficeContext(context) {
  context.xmlDocument = null;
  context.workbook = null;
  context.originalZip = null;
  context.zip = null;
  context.texts = [];
  context.units = [];
  context.ocrImages = [];
}

export async function redactDocx(context, replacementMap, options = {}) {
  for (const paragraph of wordParagraphs(context.xmlDocument)) {
    replaceWordParagraph(paragraph, replacementMap);
  }
  const xml = new XMLSerializer().serializeToString(context.xmlDocument);
  context.zip.file("word/document.xml", xml);
  await redactEmbeddedImages(context.zip, context.ocrImages, replacementMap, options);
  return context.zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: DOCX_MIME,
  });
}

function normalizeZipPath(base, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = `${base}/${target}`.split("/");
  const normalized = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function elementsByLocalName(xmlDocument, localName) {
  return Array.from(xmlDocument.getElementsByTagNameNS("*", localName));
}

async function sheetPartMap(zip) {
  const workbookEntry = zip.file("xl/workbook.xml");
  const relationshipsEntry = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookEntry || !relationshipsEntry) throw new Error("Excel sayfa ilişkileri okunamadı.");
  const workbookDocument = parseWordXml(await workbookEntry.async("string"));
  const relationshipsDocument = parseWordXml(await relationshipsEntry.async("string"));
  const targets = new Map(
    elementsByLocalName(relationshipsDocument, "Relationship").map((relationship) => [
      relationship.getAttribute("Id"),
      normalizeZipPath("xl", relationship.getAttribute("Target")),
    ])
  );
  return new Map(
    elementsByLocalName(workbookDocument, "sheet").map((sheet) => [
      sheet.getAttribute("name"),
      targets.get(sheet.getAttribute("r:id") || sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")),
    ])
  );
}

function cellsByAddress(xmlDocument) {
  return new Map(
    elementsByLocalName(xmlDocument, "c")
      .map((cell) => [cell.getAttribute("r"), cell])
      .filter(([address]) => Boolean(address))
  );
}

function transplantCellValue(originalCell, generatedCell) {
  const generatedType = generatedCell.getAttribute("t");
  if (generatedType) originalCell.setAttribute("t", generatedType);
  else originalCell.removeAttribute("t");

  for (const child of Array.from(originalCell.childNodes)) {
    if (child.nodeType === 1 && ["v", "is"].includes(child.localName || child.nodeName.split(":").pop())) {
      originalCell.removeChild(child);
    }
  }
  for (const child of Array.from(generatedCell.childNodes)) {
    if (child.nodeType === 1 && ["v", "is"].includes(child.localName || child.nodeName.split(":").pop())) {
      originalCell.appendChild(child.cloneNode(true));
    }
  }
}

async function preserveOriginalXlsxPackage(originalZip, generatedBytes, modifiedBySheet) {
  const generatedZip = await JSZip.loadAsync(generatedBytes);
  const originalParts = await sheetPartMap(originalZip);
  const generatedParts = await sheetPartMap(generatedZip);

  for (const [sheetName, addresses] of modifiedBySheet) {
    const originalPath = originalParts.get(sheetName);
    const generatedPath = generatedParts.get(sheetName);
    const originalEntry = originalZip.file(originalPath);
    const generatedEntry = generatedZip.file(generatedPath);
    if (!originalEntry || !generatedEntry) throw new Error("Excel sayfa içeriği yeniden yazılamadı.");
    const originalDocument = parseWordXml(await originalEntry.async("string"));
    const generatedDocument = parseWordXml(await generatedEntry.async("string"));
    const originalCells = cellsByAddress(originalDocument);
    const generatedCells = cellsByAddress(generatedDocument);

    for (const address of addresses) {
      const originalCell = originalCells.get(address);
      const generatedCell = generatedCells.get(address);
      if (!originalCell || !generatedCell) throw new Error(`Excel hücresi güncellenemedi: ${address}`);
      transplantCellValue(originalCell, generatedCell);
    }
    originalZip.file(originalPath, new XMLSerializer().serializeToString(originalDocument));
  }

  return originalZip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    mimeType: XLSX_MIME,
  });
}

export async function redactXlsx(context, replacementMap, options = {}) {
  const modifiedBySheet = new Map();
  const cells = workbookCells(context.workbook);
  for (let unitIndex = 0; unitIndex < cells.length; unitIndex += 1) {
    const { cell, text, address, sheetName, numeric } = cells[unitIndex];
    const replaced = replaceText(text, replacementMap, {
      unitIndex,
      ...(numeric ? { categories: NUMERIC_SAFE_CATEGORIES } : {}),
    });
    if (replaced === text) continue;
    cell.v = replaced;
    cell.t = "s";
    delete cell.w;
    delete cell.r;
    delete cell.h;
    if (!modifiedBySheet.has(sheetName)) modifiedBySheet.set(sheetName, new Set());
    modifiedBySheet.get(sheetName).add(address);
  }
  const generatedBytes = XLSX.write(context.workbook, {
    bookType: "xlsx",
    type: "array",
    cellStyles: true,
    bookSST: false,
    compression: true,
  });
  await redactEmbeddedImages(context.originalZip, context.ocrImages, replacementMap, options);
  return preserveOriginalXlsxPackage(context.originalZip, generatedBytes, modifiedBySheet);
}

export async function redactOffice(context, findings, selectedIds, options = {}) {
  if (!selectedIds.length) throw new Error("En az bir öğe seçin.");
  const replacementMap = createReplacementMap(findings, selectedIds);
  let bytes;
  if (context.kind === "docx") bytes = await redactDocx(context, replacementMap, options);
  else if (context.kind === "xlsx") bytes = await redactXlsx(context, replacementMap, options);
  else if (context.kind === "pdf") {
    const { redactPdf } = await import("./pdf.js");
    bytes = await redactPdf(context, replacementMap, options);
  } else throw new Error("Belge türü desteklenmiyor.");
  return {
    bytes,
    mimeType: context.kind === "docx" ? DOCX_MIME : context.kind === "xlsx" ? XLSX_MIME : PDF_MIME,
    filename: outputFilename(context.filename),
  };
}

export function outputFilename(filename) {
  return filename.replace(/(\.[^.]+)$/u, "_redakte$1");
}

export const docxAdapter = Object.freeze({
  id: "docx",
  extensions: [".docx"],
  mimeType: DOCX_MIME,
  canHandle: (filename) => extensionOf(filename) === ".docx",
  extract: scanDocx,
  applyChanges: redactDocx,
  outputFilename,
});

export const xlsxAdapter = Object.freeze({
  id: "xlsx",
  extensions: [".xlsx"],
  mimeType: XLSX_MIME,
  canHandle: (filename) => extensionOf(filename) === ".xlsx",
  extract: scanXlsx,
  applyChanges: redactXlsx,
  outputFilename,
});
