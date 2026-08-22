import dgram from "node:dgram";
import net from "node:net";
import { loadDatabaseConfig, loadEnvFile, loadServerConfig } from "./config.js";
import { checkConnection, closePool, getPool } from "./db.js";
import { createRulesRepository } from "./rules-repository.js";

loadEnvFile();

const results = [];
function report(ok, title, detail) {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${title}`);
  if (detail) console.log(`   ${String(detail).replaceAll("\n", "\n   ")}`);
}

function tcpProbe(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeout);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

function browserProbe(host, timeout = 4000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); resolve(null); }, timeout);
    socket.on("message", (message) => {
      clearTimeout(timer);
      socket.close();
      const instances = [];
      for (const block of message.subarray(3).toString("ascii").split(";;")) {
        const parts = block.split(";");
        const map = {};
        for (let i = 0; i + 1 < parts.length; i += 2) map[parts[i]] = parts[i + 1];
        if (map.InstanceName) instances.push({ name: map.InstanceName, port: map.tcp, version: map.Version });
      }
      resolve(instances);
    });
    socket.on("error", () => { clearTimeout(timer); resolve(null); });
    socket.send(Buffer.from([0x02]), 1434, host);
  });
}

console.log("Redakt On-Premise kurulum kontrolü\n");

let dbConfig;
try {
  dbConfig = loadDatabaseConfig();
  report(true, "Yapılandırma okundu", `${dbConfig.server}${dbConfig.port ? `:${dbConfig.port}` : ""} · ${dbConfig.database} · auth=${dbConfig.authentication.type}`);
} catch (error) {
  report(false, "Yapılandırma hatalı", error.message);
  process.exit(1);
}

if (net.isIP(dbConfig.server)) {
  report(false, "SQL_HOST bir IP adresi", "Şifreli bağlantı için DNS adı gerekir.");
} else {
  report(true, "SQL_HOST ad olarak verilmiş", dbConfig.server);
}

const instances = await browserProbe(dbConfig.server);
if (instances) {
  const lines = instances.map((i) => `${i.name} · sürüm ${i.version} · tcp ${i.port || "yok (TCP/IP kapalı)"}`);
  report(true, "SQL Browser yanıt veriyor (UDP 1434)", lines.join("\n"));
  const named = instances.find((i) => i.name === dbConfig.options.instanceName);
  if (dbConfig.port && named?.port && String(dbConfig.port) !== named.port) {
    report(false, "Yapılandırılan port instance portuyla uyuşmuyor", `.env: ${dbConfig.port} · gerçek: ${named.port} — port dinamik olabilir.`);
  }
} else {
  report(!dbConfig.options.instanceName, "SQL Browser yanıt vermiyor (UDP 1434)",
    dbConfig.options.instanceName
      ? "SQL_INSTANCE kullanıyorsunuz; bu ayar SQL Browser'a ihtiyaç duyar. Sabit port (SQL_PORT) kullanmayı düşünün."
      : "Sabit port kullanıldığı için gerekli değil.");
}

if (dbConfig.port) {
  report(await tcpProbe(dbConfig.server, dbConfig.port), `TCP ${dbConfig.port} erişilebilir`);
}

try {
  const info = await checkConnection(dbConfig);
  report(true, "SQL bağlantısı", `${info.edition} ${info.version} · login=${info.login} · db=${info.database_name} · şifreleme=${info.encryption}`);
  if (info.encryption !== "TRUE") report(false, "Bağlantı şifrelenmemiş", "SQL_ENCRYPT=true yapın; kural listesi hassas veri içerir.");
} catch (error) {
  report(false, "SQL bağlantısı", error.message);
  await closePool();
  process.exit(1);
}

try {
  const pool = await getPool(dbConfig);
  const ports = await pool.request().query(`
    SELECT value_name, value_data FROM sys.dm_server_registry
    WHERE registry_key LIKE '%IPAll%' AND value_name IN ('TcpPort','TcpDynamicPorts')`);
  const dynamic = ports.recordset.find((r) => r.value_name === "TcpDynamicPorts")?.value_data;
  const staticPort = ports.recordset.find((r) => r.value_name === "TcpPort")?.value_data;
  if (staticPort) report(true, "Sabit port tanımlı", `TcpPort=${staticPort} — servis yeniden başlasa da değişmez.`);
  else report(false, "Port DİNAMİK", `TcpDynamicPorts=${dynamic} — SQL servisi her yeniden başladığında port değişir.\nSQL Server Configuration Manager'dan sabit port atayın veya SQL_INSTANCE kullanın.`);
} catch (error) {
  report(true, "Port tipi okunamadı (yetki yok)", "VIEW SERVER STATE yetkisi gerekiyor; kritik değil.");
}

const serverConfig = loadServerConfig();
const repository = createRulesRepository({ dbConfig, table: serverConfig.rulesTable, cacheTtlMs: 0 });
try {
  const snapshot = await repository.get({ force: true });
  report(true, "Kural tablosu okundu", `${snapshot.rules.length} aktif kural (toplam ${snapshot.total}) · etag=${snapshot.etag}`);
  const categories = new Map();
  for (const rule of snapshot.rules) categories.set(rule.category || "(yok)", (categories.get(rule.category || "(yok)") || 0) + 1);
  console.log(`   Kategoriler: ${[...categories].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  if (snapshot.duplicates.length) {
    report(false, "Çakışan kurallar var", snapshot.duplicates.map((d) => `"${d.find}" → ${d.ids.join(", ")}`).join("\n"));
  } else {
    report(true, "Çakışan kural yok");
  }
} catch (error) {
  report(false, "Kural tablosu okunamadı", error.message);
}

await closePool();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${failed ? `${failed} kontrol başarısız.` : "Tüm kontroller başarılı."}`);
process.exit(failed ? 1 : 0);
