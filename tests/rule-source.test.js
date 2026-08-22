import assert from "node:assert/strict";
import test from "node:test";
import {
  describeRuleSource,
  fetchCorporateRules,
  RULE_SOURCE_STATUS,
  shouldWarnBeforeScan,
} from "../src/rule-source.js";

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("sunucudan gelen kuralları normalize eder", async () => {
  const result = await fetchCorporateRules({
    fetchImpl: async () => jsonResponse({
      rules: [
        { id: "sql_1", find: " Ahmet Yilmaz ", replacement: "[KISI_1] ", category: "Kisi" },
        { id: "sql_2", find: "Yilmaz Insaat Ltd. Sti.", replacement: "[SIRKET_1]", category: "Sirket" },
      ],
      stale: false,
    }),
  });

  assert.equal(result.status, RULE_SOURCE_STATUS.ready);
  assert.deepEqual(result.rules.map((rule) => rule.find), ["Ahmet Yilmaz", "Yilmaz Insaat Ltd. Sti."]);
  assert.equal(result.rules[0].replacement, "[KISI_1]");
  assert.equal(result.rules[0].category, "Kisi");
});

test("eksik alanı olan kuralları atar", async () => {
  const result = await fetchCorporateRules({
    fetchImpl: async () => jsonResponse({
      rules: [
        { id: "1", find: "Gecerli", replacement: "[X]" },
        { id: "2", find: "", replacement: "[Y]" },
        { id: "3", find: "Eksik", replacement: "   " },
      ],
    }),
  });

  assert.equal(result.rules.length, 1);
  assert.equal(result.rules[0].find, "Gecerli");
});

test("sunucu eski kopya döndürdüğünde bayat olarak işaretlenir", async () => {
  const result = await fetchCorporateRules({
    fetchImpl: async () => jsonResponse({
      rules: [{ id: "1", find: "A", replacement: "[A]" }],
      stale: true,
      warning: "Kurallar yenilenemedi.",
    }),
  });

  assert.equal(result.status, RULE_SOURCE_STATUS.stale);
  assert.equal(result.message, "Kurallar yenilenemedi.");
  assert.equal(shouldWarnBeforeScan(result), true);
});

test("SQL erişilemediğinde kural listesi boş döner ve uyarı gerekir", async () => {
  const result = await fetchCorporateRules({
    fetchImpl: async () => jsonResponse(
      { rules: null, message: "Kurumsal kural listesi yüklenemedi.", detail: "SQL kapalı" },
      { status: 503 },
    ),
  });

  assert.equal(result.status, RULE_SOURCE_STATUS.unavailable);
  assert.deepEqual(result.rules, []);
  assert.equal(result.detail, "SQL kapalı");
  assert.equal(shouldWarnBeforeScan(result), true);
});

test("uygulama servis dışından açıldığında anlaşılır mesaj verir", async () => {
  const result = await fetchCorporateRules({ fetchImpl: async () => jsonResponse(null, { status: 404 }) });
  assert.equal(result.status, RULE_SOURCE_STATUS.unavailable);
  assert.match(result.message, /On-Premise servisi/u);
});

test("ağ hatasında çökmez, uyarılabilir durum döner", async () => {
  const result = await fetchCorporateRules({
    fetchImpl: async () => { throw new TypeError("Failed to fetch"); },
  });
  assert.equal(result.status, RULE_SOURCE_STATUS.unavailable);
  assert.match(result.message, /ulaşılamıyor/u);
  assert.equal(shouldWarnBeforeScan(result), true);
});

test("kurallar başarıyla yüklendiğinde tarama öncesi uyarı gerekmez", async () => {
  const result = await fetchCorporateRules({
    fetchImpl: async () => jsonResponse({ rules: [{ id: "1", find: "A", replacement: "[A]" }] }),
  });
  assert.equal(shouldWarnBeforeScan(result), false);
  assert.match(describeRuleSource(result), /1 kurumsal kural etkin/u);
});

test("istek gövdesiz GET'tir ve yalnızca /api/rules adresine gider", async () => {
  const calls = [];
  await fetchCorporateRules({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ rules: [] });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/rules");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.credentials, "same-origin");
});
