const sql = require('mssql');

/* Authenticates as the Function App's system-assigned managed identity.
   There is no connection string and no password anywhere in configuration. */
const config = {
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DATABASE,
  authentication: { type: 'azure-active-directory-default' },
  options: { encrypt: true, trustServerCertificate: false },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  connectionTimeout: 60000,
  requestTimeout: 60000,
};

let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config).connect()
      .catch((e) => { poolPromise = null; throw e; });
  }
  return poolPromise;
}

// eds-db is serverless with a 60-minute auto-pause. The first call after an idle
// period arrives while the database is still resuming and fails; that is normal
// and transient, so retry it rather than surfacing a 500 to the app.
const RETRYABLE_CODES = new Set(['ETIMEOUT', 'ESOCKET', 'ECONNCLOSED', 'ELOGIN']);
const RETRYABLE_SQL = /\b(40613|40197|40501|49918|49919|49920|4060|10928|10929)\b/;

const isRetryable = (e) =>
  RETRYABLE_CODES.has(e.code) || RETRYABLE_SQL.test(e.message || '');

/** Executes a stored procedure.
 *  @param params array of [name, sqlType, value] - bound, never interpolated.
 *  Types are explicit because mssql cannot infer one from a null value. */
async function exec(procName, params = [], log) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const pool = await getPool();
      const req = pool.request();
      for (const [name, type, value] of params) {
        req.input(name, type, value === undefined ? null : value);
      }
      const result = await req.execute(procName);
      return result.recordset || [];
    } catch (e) {
      lastErr = e;
      if (!isRetryable(e) || attempt === 4) break;
      poolPromise = null; // drop the dead pool so the next attempt reconnects
      const waitMs = attempt * 5000;
      log?.warn(`${procName}: ${e.code || 'error'} "${e.message}" - retry ${attempt}/3 in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

module.exports = { exec, sql, isRetryable };
