import { getPool } from "./db.js";

const SAFE_TABLE_NAME = /^\[?[A-Za-z_][\w]*\]?\.\[?[A-Za-z_][\w]*\]?$/u;

function qualifiedTable(name) {
  if (!SAFE_TABLE_NAME.test(name)) throw new Error(`Geçersiz tablo adı: ${name}`);
  return name;
}

export function createRulesRepository({ dbConfig, table, cacheTtlMs = 60000 }) {
  const source = qualifiedTable(table);
  let cache = null;

  async function readVersion() {
    const pool = await getPool(dbConfig);
    const result = await pool.request().query(`
      SELECT
        COUNT_BIG(*) AS total,
        SUM(CASE WHEN Aktif = 1 THEN 1 ELSE 0 END) AS active,
        CHECKSUM_AGG(BINARY_CHECKSUM(Id, AranacakIfade, YerineDeger, Kategori, Aktif)) AS checksum
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
    const result = await pool.request().query(`
      SELECT Id, AranacakIfade, YerineDeger, Kategori, Notlar
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
