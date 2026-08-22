import sql from "mssql";

let poolPromise = null;

export async function getPool(config) {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config).connect().catch((error) => {
      poolPromise = null;
      throw describeConnectionError(error);
    });
  }
  return poolPromise;
}

export async function closePool() {
  if (!poolPromise) return;
  const pool = await poolPromise.catch(() => null);
  poolPromise = null;
  await pool?.close();
}

function describeConnectionError(error) {
  const message = error.originalError?.message || error.message || "";
  if (/ServerName .* is not permitted|servername/iu.test(message)) {
    return new Error("SQL bağlantısı kurulamadı: şifreli bağlantıda IP adresi kullanılamaz, SQL_HOST'a sunucunun DNS adını yazın.");
  }
  if (/Login failed/iu.test(message)) {
    return new Error("SQL bağlantısı kurulamadı: kullanıcı adı veya şifre hatalı.");
  }
  if (/self.signed|certificate/iu.test(message)) {
    return new Error("SQL bağlantısı kurulamadı: sunucu sertifikası doğrulanamadı. Kurum sertifikası yoksa SQL_TRUST_CERT=true kullanın.");
  }
  if (/ETIMEOUT|ESOCKET|ECONNREFUSED|getaddrinfo/iu.test(message)) {
    return new Error(`SQL sunucusuna ulaşılamıyor. Adres, port ve güvenlik duvarı kurallarını kontrol edin. (${message})`);
  }
  return new Error(`SQL bağlantısı kurulamadı: ${message}`);
}

export async function checkConnection(config) {
  const pool = await getPool(config);
  const result = await pool.request().query(`
    SELECT
      CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS version,
      CAST(SERVERPROPERTY('Edition') AS nvarchar(128))       AS edition,
      SUSER_SNAME()                                          AS login,
      DB_NAME()                                              AS database_name,
      (SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID) AS encryption`);
  return result.recordset[0];
}
