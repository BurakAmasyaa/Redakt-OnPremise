import { getPool } from "./db.js";

const SAFE_TABLE_NAME = /^\[?[A-Za-z_][\w]*\]?\.\[?[A-Za-z_][\w]*\]?$/u;

function qualifiedTable(name) {
  if (!SAFE_TABLE_NAME.test(name)) throw new Error(`Geçersiz tablo adı: ${name}`);
  return name;
}

// TamEslesme kolonu isteğe bağlıdır: mevcut kurulumlarda tablo onsuz da
// çalışmalı. Kolon yoksa tüm kurallar eski davranışı sürdürür (bulanık eşleşme).
const EXACT_COLUMN = "TamEslesme";

function tableParts(name) {
  const [schema, table] = name.split(".").map((part) => part.replace(/^\[|\]$/gu, ""));
  return { schema, table };
}

export function createRulesRepository({ dbConfig, table, cacheTtlMs = 60000, logger = null }) {
  const source = qualifiedTable(table);
  const { schema, table: tableName } = tableParts(source);
  let cache = null;
  let hasExactColumn = null;

  async function detectExactColumn() {
    if (hasExactColumn !== null) return hasExactColumn;
    const pool = await getPool(dbConfig);
    const result = await pool.request()
      .input("schema", schema)
      .input("table", tableName)
      .input("column", EXACT_COLUMN)
      .query(`
        SELECT 1 AS present FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table AND COLUMN_NAME = @column`);
    hasExactColumn = result.recordset.length > 0;
    logger?.info(hasExactColumn
      ? `${EXACT_COLUMN} kolonu bulundu; kural bazında tam eşleşme etkin`
      : `${EXACT_COLUMN} kolonu yok; tüm kurallar bulanık eşleşmeyle çalışıyor`);
    return hasExactColumn;
  }

  async function readVersion() {
    const pool = await getPool(dbConfig);
    const exact = await detectExactColumn();
    // Etag bayrağı da kapsamalı; yoksa TamEslesme değişince istemci
    // 304 alıp eski kural listesini kullanmaya devam eder.
    const checksumColumns = `Id, AranacakIfade, YerineDeger, Kategori, Aktif${exact ? `, ${EXACT_COLUMN}` : ""}`;
    const result = await pool.request().query(`
      SELECT
        COUNT_BIG(*) AS total,
        SUM(CASE WHEN Aktif = 1 THEN 1 ELSE 0 END) AS active,
        CHECKSUM_AGG(BINARY_CHECKSUM(${checksumColumns})) AS checksum
      FROM ${source}`);
    const row = result.recordset[0];
    return {
      total: Number(row.total ?? 0),
      active: Number(row.active ?? 0),
      etag: `"${row.active ?? 0}-${row.checksum ?? 0}"`,
    };
  }

  async function readRules() {
    const pool = await getPool(dbConfig);
    const exact = await detectExactColumn();
    const result = await pool.request().query(`
      SELECT Id, AranacakIfade, YerineDeger, Kategori, Notlar${exact ? `, ${EXACT_COLUMN}` : ""}
      FROM ${source}
      WHERE Aktif = 1 AND AranacakIfade IS NOT NULL AND YerineDeger IS NOT NULL
      ORDER BY Id`);
    return result.recordset
      .map((row) => ({
        id: `sql_${row.Id}`,
        find: String(row.AranacakIfade).trim(),
        replacement: String(row.YerineDeger).trim(),
        category: row.Kategori ? String(row.Kategori) : null,
        notes: row.Notlar ? String(row.Notlar) : null,
        exact: exact ? Boolean(row[EXACT_COLUMN]) : false,
      }))
      .filter((rule) => rule.find && rule.replacement);
  }

  function findDuplicates(rules) {
    const seen = new Map();
    const duplicates = [];
    for (const rule of rules) {
      const key = rule.find.toLocaleLowerCase("tr-TR");
      const previous = seen.get(key);
      if (previous && previous.replacement !== rule.replacement) {
        duplicates.push({ find: rule.find, ids: [previous.id, rule.id] });
      }
      seen.set(key, rule);
    }
    return duplicates;
  }

  async function refresh() {
    const version = await readVersion();
    if (cache?.etag === version.etag) {
      cache.checkedAt = Date.now();
      return cache;
    }
    const rules = await readRules();
    cache = {
      etag: version.etag,
      total: version.total,
      exactColumn: hasExactColumn,
      rules,
      duplicates: findDuplicates(rules),
      fetchedAt: Date.now(),
      checkedAt: Date.now(),
    };
    return cache;
  }

  return {
    async get({ force = false } = {}) {
      const fresh = cache && !force && Date.now() - cache.checkedAt < cacheTtlMs;
      if (fresh) return { ...cache, stale: false };
      try {
        return { ...(await refresh()), stale: false };
      } catch (error) {
        if (!cache) throw error;
        return { ...cache, stale: true, error: error.message };
      }
    },
    peek() {
      return cache;
    },
  };
}
