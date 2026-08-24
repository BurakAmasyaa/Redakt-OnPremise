// Servisin o anki durumu: izleme sistemleri (PRTG, Zabbix, SCOM) bunu
// /api/health üzerinden okur. Prometheus yerine düz JSON tercih edildi;
// kurumsal Windows ortamlarında JSON okuyabilen izleme aracı daha yaygın.

export function createDiagnostics({ now = () => Date.now() } = {}) {
  const startedAt = now();
  const counters = {
    istek: 0,
    kuralIstegi: 0,
    kuralDegismedi: 0,
    hata4xx: 0,
    hata5xx: 0,
    sqlHatasi: 0,
    kuralYenileme: 0,
  };
  const sql = {
    sonBasari: null,
    sonHata: null,
    sonHataMesaji: null,
    ardisikHata: 0,
    saglikli: null,
  };

  return {
    say(name, amount = 1) {
      if (name in counters) counters[name] += amount;
    },

    sqlBasarili() {
      const oncekiDurum = sql.saglikli;
      sql.sonBasari = now();
      sql.ardisikHata = 0;
      sql.saglikli = true;
      // Durum değişimi anlamlıdır; her başarıda log yazmak gürültü olur.
      return oncekiDurum === false;
    },

    sqlBasarisiz(message) {
      const oncekiDurum = sql.saglikli;
      sql.sonHata = now();
      sql.sonHataMesaji = String(message || "").slice(0, 300);
      sql.ardisikHata += 1;
      sql.saglikli = false;
      return oncekiDurum !== false;
    },

    get sqlSaglikli() {
      return sql.saglikli;
    },

    get ardisikSqlHatasi() {
      return sql.ardisikHata;
    },

    anlik(extra = {}) {
      const uptimeMs = now() - startedAt;
      return {
        calismaSuresiSn: Math.round(uptimeMs / 1000),
        baslangic: new Date(startedAt).toISOString(),
        sayaclar: { ...counters },
        sql: {
          saglikli: sql.saglikli,
          ardisikHata: sql.ardisikHata,
          sonBasari: sql.sonBasari ? new Date(sql.sonBasari).toISOString() : null,
          sonHata: sql.sonHata ? new Date(sql.sonHata).toISOString() : null,
          sonHataMesaji: sql.sonHataMesaji,
        },
        bellekMB: Math.round(process.memoryUsage().rss / 1048576),
        ...extra,
      };
    },
  };
}
