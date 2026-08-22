const CATEGORY_META = {
  email: { label: "E-posta", prefix: "EMAIL", confidence: "exact" },
  phone: { label: "Telefon", prefix: "TELEFON", confidence: "probable" },
  iban: { label: "IBAN", prefix: "IBAN", confidence: "exact" },
  tc: { label: "T.C. Kimlik No", prefix: "TC_KIMLIK", confidence: "exact" },
  card: { label: "Kredi Kartı", prefix: "KREDI_KARTI", confidence: "exact" },
  person: { label: "Kişi adı", prefix: "KISI", confidence: "probable" },
  organization: { label: "Kurum / şirket", prefix: "KURUM", confidence: "probable" },
  location: { label: "Adres/Konum", prefix: "KONUM", confidence: "probable" },
  custom: { label: "Kendi kuralın", prefix: "OZEL", confidence: "custom" },
};

const CATEGORY_PRIORITY = { email: 0, iban: 1, tc: 2, card: 3, phone: 4, person: 5, organization: 6, location: 7 };

const TR_PHONE_AREA_CODES = new Set([
  "212", "216", "222", "224", "226", "228", "232", "236", "242", "246", "248", "252", "256", "258",
  "262", "264", "266", "272", "274", "276", "282", "284", "286", "288", "312", "318", "322", "324",
  "326", "328", "332", "338", "342", "344", "346", "348", "352", "354", "356", "358", "362", "364",
  "366", "368", "370", "372", "374", "376", "378", "380", "382", "384", "386", "388", "412", "414",
  "416", "422", "424", "426", "428", "432", "434", "436", "438", "442", "446", "452", "454", "456",
  "458", "462", "464", "466", "472", "474", "476", "478", "482", "484", "486", "488", "501", "505",
  "506", "507", "510", "516", "530", "531", "532", "533", "534", "535", "536", "537", "538", "539",
  "540", "541", "542", "543", "544", "545", "546", "547", "548", "549", "551", "552", "553", "554",
  "555", "559", "561", "570", "571", "572", "573", "574", "575", "800", "850",
]);

const PATTERNS = {
  email: /(?<![A-Z0-9._%+\-])[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,63}(?![A-Z0-9._%+\-])/giu,
  trIban: /(?<![A-Z0-9])TR\s?\d{2}(?:\s?\d{4}){5}\s?\d{2}(?![A-Z0-9])/giu,
  compactIban: /(?<![A-Z0-9])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![A-Z0-9])/giu,
  tc: /(?<!\d)[1-9]\d{10}(?!\d)/gu,
  card: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/gu,
  phone: /(?<!\d)(?:(?:(?:\+|00)90[ .-]?|0)(?:\(\d{3}\)|\d{3})[ .-]?\d{3}[ .-]?\d{2}[ .-]?\d{2}|(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]?\d{2}[ .-]?\d{2})(?!\d)/gu,
};

function digits(value) {
  return value.replace(/\D/gu, "");
}

export function isValidTcKimlik(value) {
  const compact = digits(String(value));
  if (!/^[1-9]\d{10}$/u.test(compact) || new Set(compact).size === 1) return false;
  const numbers = [...compact].map(Number);
  const oddSum = numbers[0] + numbers[2] + numbers[4] + numbers[6] + numbers[8];
  const evenSum = numbers[1] + numbers[3] + numbers[5] + numbers[7];
  const tenth = (oddSum * 7 - evenSum) % 10;
  const eleventh = numbers.slice(0, 10).reduce((sum, number) => sum + number, 0) % 10;
  return tenth === numbers[9] && eleventh === numbers[10];
}

export function isValidLuhn(value) {
  const compact = digits(String(value));
  if (compact.length < 13 || compact.length > 19 || new Set(compact).size === 1) return false;
  const parity = compact.length % 2;
  let total = 0;
  for (let index = 0; index < compact.length; index += 1) {
    let number = Number(compact[index]);
    if (index % 2 === parity) {
      number *= 2;
      if (number > 9) number -= 9;
    }
    total += number;
  }
  return total % 10 === 0;
}

export function isValidIban(value) {
  const compact = String(value).replace(/\s/gu, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/u.test(compact) || compact.length < 15 || compact.length > 34) {
    return false;
  }
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const expanded = /[A-Z]/u.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of expanded) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function isValidPhone(value) {
  let compact = digits(String(value));
  if (compact.startsWith("0090")) compact = compact.slice(4);
  else if (compact.startsWith("90") && compact.length === 12) compact = compact.slice(2);
  else if (compact.startsWith("0") && compact.length === 11) compact = compact.slice(1);
  if (!/^\d{10}$/u.test(compact)) return false;
  return TR_PHONE_AREA_CODES.has(compact.slice(0, 3));
}

export function normalizeValue(category, value) {
  const raw = String(value);
  if (category === "email") return raw.toLocaleLowerCase("tr-TR");
  if (category === "iban") return raw.replace(/\s/gu, "").toUpperCase();
  if (category === "tc" || category === "card") return digits(raw);
  if (category === "phone") {
    let compact = digits(raw);
    if (compact.startsWith("0090")) compact = compact.slice(2);
    if (compact.startsWith("0") && compact.length === 11) compact = `90${compact.slice(1)}`;
    else if (compact.length === 10) compact = `90${compact}`;
    return `+${compact}`;
  }
  if (["person", "organization", "location"].includes(category)) {
    return raw.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("tr-TR");
  }
  return raw;
}

export function matchKey(category, normalized) {
  return `${category}\u0000${normalized}`;
}

export const NUMERIC_SAFE_CATEGORIES = Object.freeze(["tc", "card"]);

export function detectText(text, options = {}) {
  const source = String(text);
  const candidates = [];
  const allow = options.categories ? new Set(options.categories) : null;

  const collect = (pattern, category, validator = null) => {
    if (allow && !allow.has(category)) return;
    for (const result of source.matchAll(pattern)) {
      if (validator && !validator(result[0])) continue;
      candidates.push({
        category,
        start: result.index,
        end: result.index + result[0].length,
        raw: result[0],
        normalized: normalizeValue(category, result[0]),
      });
    }
  };

  collect(PATTERNS.email, "email");
  collect(PATTERNS.trIban, "iban", isValidIban);
  collect(PATTERNS.compactIban, "iban", isValidIban);
  collect(PATTERNS.tc, "tc", isValidTcKimlik);
  collect(PATTERNS.card, "card", isValidLuhn);
  collect(PATTERNS.phone, "phone", isValidPhone);

  candidates.sort((a, b) =>
    a.start - b.start ||
    CATEGORY_PRIORITY[a.category] - CATEGORY_PRIORITY[b.category] ||
    (b.end - b.start) - (a.end - a.start)
  );

  const accepted = [];
  for (const candidate of candidates) {
    const overlaps = accepted.some((item) => candidate.start < item.end && candidate.end > item.start);
    if (!overlaps) accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

export function aggregateFindings(texts) {
  const aggregate = new Map();
  for (let unitIndex = 0; unitIndex < texts.length; unitIndex += 1) {
    const input = texts[unitIndex];
    const text = typeof input === "string" ? input : String(input.text || "");
    const location = typeof input === "string" ? { kind: "text", unitIndex } : input.location;
    const categories = typeof input === "object" ? input.categories : null;
    for (const match of detectText(text, categories ? { categories } : {})) {
      const key = matchKey(match.category, match.normalized);
      const current = aggregate.get(key);
      const occurrence = { unitIndex, start: match.start, end: match.end, location };
      if (current) {
        current.count += 1;
        current.locations.push(occurrence);
      } else aggregate.set(key, { ...match, count: 1, locations: [occurrence] });
    }
  }

  const categoryCounts = Object.fromEntries(Object.keys(CATEGORY_META).map((category) => [category, 0]));
  return [...aggregate.values()].map((item, index) => {
    categoryCounts[item.category] += 1;
    const meta = CATEGORY_META[item.category];
    return {
      id: `f_${index + 1}`,
      source: "pattern",
      category: item.category,
      label: meta.label,
      value: item.raw,
      originalText: item.raw,
      normalized: item.normalized,
      count: item.count,
      confidence: meta.confidence,
      placeholder: `[${meta.prefix}_${categoryCounts[item.category]}]`,
      replacementText: `[${meta.prefix}_${categoryCounts[item.category]}]`,
      locations: item.locations,
    };
  });
}

export function createReplacementMap(findings, selectedIds) {
  const selected = new Set(selectedIds);
  const replacementMap = new Map(
    findings
      .filter((finding) => selected.has(finding.id))
      .map((finding) => [matchKey(finding.category, finding.normalized), finding.placeholder])
  );
  Object.defineProperty(replacementMap, "entityFindings", {
    value: findings.filter((finding) =>
      selected.has(finding.id)
      && (finding.source === "ner" || (!finding.source && ["person", "organization", "location"].includes(finding.category)))
    ),
  });
  const entitiesByUnitIndex = new Map();
  for (const finding of replacementMap.entityFindings) {
    for (const location of finding.locations || []) {
      if (!entitiesByUnitIndex.has(location.unitIndex)) entitiesByUnitIndex.set(location.unitIndex, []);
      entitiesByUnitIndex.get(location.unitIndex).push(finding);
    }
  }
  Object.defineProperty(replacementMap, "entitiesByUnitIndex", { value: entitiesByUnitIndex });
  Object.defineProperty(replacementMap, "literalFindings", {
    value: findings.filter((finding) => selected.has(finding.id) && ["custom", "imported-rule"].includes(finding.source)),
  });
  return replacementMap;
}

export function replacementsForText(text, replacementMap, options = {}) {
  const candidates = detectText(text, options)
    .map((match) => ({
      ...match,
      placeholder: replacementMap.get(matchKey(match.category, match.normalized)),
      priority: 1,
    }))
    .filter((match) => Boolean(match.placeholder));

  const entityFindings = options.unitIndex === undefined
    ? replacementMap.entityFindings || []
    : replacementMap.entitiesByUnitIndex?.get(options.unitIndex) || [];
  for (const finding of entityFindings) {
    for (const variant of finding.variants || [finding.value]) {
      let cursor = 0;
      while (cursor < text.length) {
        const start = text.indexOf(variant, cursor);
        if (start < 0) break;
        const end = start + variant.length;
        const before = text[start - 1] || "";
        const after = text[end] || "";
        if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) {
          candidates.push({
            category: finding.category,
            start,
            end,
            raw: variant,
            normalized: finding.normalized,
            placeholder: finding.placeholder,
            priority: 2,
          });
        }
        cursor = Math.max(end, start + 1);
      }
    }
  }

  for (const finding of replacementMap.literalFindings || []) {
    for (const variant of finding.variants || [finding.value]) {
      let cursor = 0;
      while (cursor <= text.length - variant.length) {
        const start = text.indexOf(variant, cursor);
        if (start < 0) break;
        candidates.push({
          category: "custom",
          start,
          end: start + variant.length,
          raw: variant,
          normalized: finding.normalized,
          placeholder: finding.replacementText,
          priority: 0,
        });
        cursor = start + Math.max(variant.length, 1);
      }
    }
  }

  candidates.sort((a, b) =>
    a.priority - b.priority
    || (b.end - b.start) - (a.end - a.start)
    || a.start - b.start
    || (CATEGORY_PRIORITY[a.category] ?? 99) - (CATEGORY_PRIORITY[b.category] ?? 99)
  );
  const accepted = [];
  for (const candidate of candidates) {
    if (!accepted.some((item) => candidate.start < item.end && candidate.end > item.start)) {
      accepted.push(candidate);
    }
  }
  return accepted.sort((a, b) => a.start - b.start);
}

export function replaceText(text, replacementMap, options = {}) {
  let output = String(text);
  const replacements = replacementsForText(output, replacementMap, options);
  for (const match of [...replacements].reverse()) {
    output = output.slice(0, match.start) + match.placeholder + output.slice(match.end);
  }
  return output;
}

export const categoryMeta = CATEGORY_META;
