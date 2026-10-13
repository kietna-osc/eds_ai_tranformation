/* SQL runner for the deploy scripts. Signs in with the `az login` account.

   node sql.js migrate <server> <database> <scriptsDir> <vars.json> [--baseline]
       Runs every NN_*.sql in scriptsDir that dbo.deploy_log does not list yet,
       in number order, each in its own transaction, and records it.
       --baseline records them without running them (scripts already applied by hand).
   node sql.js run <server> <database> <file.sql> <vars.json>
       Runs one file, in a transaction.
   node sql.js ping <server> <database>
       Connects (waking a paused database) and prints TABLES=<number of user tables>.
   node sql.js copy-grants <srcServer> <srcDb> <srcUser> <dstServer> <dstDb> <dstUser>
       Gives dstUser in the destination every object/schema permission and database
       role that srcUser has in the source. dstUser must exist.

   vars.json: { "tokens": { "NAME": "value" }, "replace": { "old": "new" } }
       "replace" pairs are literal replacements, applied first; then every $(NAME)
       is replaced by its token. An unknown $(NAME) is an error.
   A file whose first line is "-- deploy: no-transaction" runs without a transaction.
   Batches are separated by lines containing only GO.

   Exit code 3 with a CLIENT_IP=<ip> line: the server firewall blocks this machine. */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function loadMssql() {
  const root = path.resolve(__dirname, '..', '..');
  for (const dir of ['tools', 'api']) {
    try { return require(path.join(root, dir, 'node_modules', 'mssql')); } catch (_) { /* try next */ }
  }
  console.error('mssql is not installed. Run "npm ci" in tools/ once.');
  process.exit(1);
}
const sql = loadMssql();

const readText = (f) => fs.readFileSync(f, 'utf8').replace(/^﻿/, '');

function applyVars(text, vars, file) {
  for (const [from, to] of Object.entries(vars.replace || {})) text = text.split(from).join(to);
  return text.replace(/\$\((\w+)\)/g, (m, name) => {
    if (!(name in (vars.tokens || {}))) throw new Error(`${file} uses ${m}, which is not configured`);
    return vars.tokens[name];
  });
}

const batches = (text) => text.split(/^\s*GO\s*$/im).map((s) => s.trim()).filter(Boolean);
const noTransaction = (text) => /^\s*--\s*deploy:\s*no-transaction/i.test(text);

async function connect(server, database) {
  const token = JSON.parse(execSync(
    'az account get-access-token --resource https://database.windows.net/ -o json',
    { encoding: 'utf8', maxBuffer: 1 << 24 })).accessToken;
  const cfg = {
    server, database,
    authentication: { type: 'azure-active-directory-access-token', options: { token } },
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 60000, requestTimeout: 600000,
  };
  // A serverless database that is auto-paused fails the first logins while it resumes.
  for (let attempt = 1; ; attempt++) {
    try {
      return await new sql.ConnectionPool(cfg).connect();
    } catch (e) {
      const ip = /IP address '([\d.]+)'/.exec(e.message || '');
      if (ip) { console.log(`CLIENT_IP=${ip[1]}`); process.exit(3); }
      if (attempt >= 6 || !/40613|not currently available|ETIMEOUT|ESOCKET/.test(`${e.code} ${e.message}`)) throw e;
      console.log(`Database is resuming, retry ${attempt}/5 in 15s`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

/** Runs the file's batches; inside `tx` when given. Prints result sets. */
async function runBatches(pool, tx, text, file) {
  const bs = batches(text);
  for (let i = 0; i < bs.length; i++) {
    try {
      const r = await (tx ? new sql.Request(tx) : pool.request()).batch(bs[i]);
      for (const rs of r.recordsets || []) if (rs.length) console.log(JSON.stringify(rs.slice(0, 25)));
    } catch (e) {
      e.message = `${file}, batch ${i + 1} of ${bs.length}: ${e.message}\n--- batch starts with:\n${bs[i].slice(0, 400)}`;
      throw e;
    }
  }
}

async function runFile(pool, file, vars, afterRun) {
  const text = applyVars(readText(file), vars, path.basename(file));
  if (noTransaction(text)) {
    await runBatches(pool, null, text, path.basename(file));
    if (afterRun) await afterRun(pool.request());
    return;
  }
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await runBatches(pool, tx, text, path.basename(file));
    if (afterRun) await afterRun(new sql.Request(tx));
    await tx.commit();
  } catch (e) {
    try { await tx.rollback(); } catch (_) { /* already rolled back by the server */ }
    throw e;
  }
}

const scriptOrder = (a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b);

async function migrate(pool, dir, vars, baseline) {
  const exists = (await pool.request().query(
    "SELECT OBJECT_ID(N'dbo.deploy_log', N'U') AS id")).recordset[0].id !== null;
  if (!exists && !baseline) {
    throw new Error('dbo.deploy_log does not exist yet, so it is unknown which scripts this database already has. '
      + 'Run once with -BaselineSql to record the current scripts as applied.');
  }
  if (!exists) {
    await pool.request().batch(`CREATE TABLE dbo.deploy_log (
      script_name NVARCHAR(260) NOT NULL CONSTRAINT PK_deploy_log PRIMARY KEY,
      mode        NVARCHAR(10)  NOT NULL,  -- 'run' or 'baseline'
      applied_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_deploy_log_applied_at DEFAULT SYSUTCDATETIME(),
      applied_by  NVARCHAR(128) NOT NULL CONSTRAINT DF_deploy_log_applied_by DEFAULT SUSER_SNAME())`);
    console.log('Created dbo.deploy_log');
  }
  const done = new Set((await pool.request().query('SELECT script_name FROM dbo.deploy_log'))
    .recordset.map((r) => r.script_name.toLowerCase()));
  const pending = fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/i.test(f))
    .sort(scriptOrder).filter((f) => !done.has(f.toLowerCase()));
  if (!pending.length) { console.log('No new SQL scripts.'); return; }

  const record = (mode, name) => (req) => req
    .input('n', sql.NVarChar(260), name).input('m', sql.NVarChar(10), mode)
    .query('INSERT dbo.deploy_log (script_name, mode) VALUES (@n, @m)');
  for (const f of pending) {
    if (baseline) {
      await record('baseline', f)(pool.request());
      console.log(`recorded as applied: ${f}`);
    } else {
      console.log(`running: ${f}`);
      await runFile(pool, path.join(dir, f), vars, record('run', f));
      console.log(`applied: ${f}`);
    }
  }
}

async function copyGrants(src, srcUser, dst, dstUser) {
  const q = (s) => s.replace(/]/g, ']]');
  // System catalog columns use a different collation than the database; COLLATE
  // DATABASE_DEFAULT keeps the UNION ALL branches compatible.
  const rows = (await src.request().input('u', sql.NVarChar(128), srcUser).query(`
    SELECT (N'GRANT ' + p.permission_name + N' ON OBJECT::' + QUOTENAME(OBJECT_SCHEMA_NAME(p.major_id))
           + N'.' + QUOTENAME(OBJECT_NAME(p.major_id))) COLLATE DATABASE_DEFAULT AS stmt
    FROM sys.database_permissions p
    WHERE p.grantee_principal_id = DATABASE_PRINCIPAL_ID(@u) AND p.class = 1 AND p.state = 'G'
    UNION ALL
    SELECT (N'GRANT ' + p.permission_name + N' ON SCHEMA::' + QUOTENAME(SCHEMA_NAME(p.major_id))) COLLATE DATABASE_DEFAULT
    FROM sys.database_permissions p
    WHERE p.grantee_principal_id = DATABASE_PRINCIPAL_ID(@u) AND p.class = 3 AND p.state = 'G'
    UNION ALL
    SELECT (N'ALTER ROLE ' + QUOTENAME(r.name) + N' ADD MEMBER') COLLATE DATABASE_DEFAULT
    FROM sys.database_role_members m JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
    WHERE m.member_principal_id = DATABASE_PRINCIPAL_ID(@u)`)).recordset;
  if (!rows.length) throw new Error(`${srcUser} has no permissions in the source database`);
  for (const { stmt } of rows) {
    const full = stmt.startsWith('ALTER ROLE') ? `${stmt} [${q(dstUser)}]` : `${stmt} TO [${q(dstUser)}]`;
    await dst.request().batch(full);
  }
  console.log(`${dstUser}: ${rows.length} permissions copied from ${srcUser}`);
}

(async () => {
  const a = process.argv.slice(2);
  const cmd = a[0];
  if (cmd === 'ping' && a.length === 3) {
    const pool = await connect(a[1], a[2]);
    try {
      const n = (await pool.request().query("SELECT COUNT(*) AS n FROM sys.tables WHERE is_ms_shipped = 0")).recordset[0].n;
      console.log(`TABLES=${n}`);
    } finally { await pool.close(); }
    return;
  }
  if (cmd === 'copy-grants' && a.length === 7) {
    const src = await connect(a[1], a[2]);
    const dst = await connect(a[4], a[5]);
    try { await copyGrants(src, a[3], dst, a[6]); } finally { await src.close(); await dst.close(); }
    return;
  }
  const [, server, database, target, varsFile, flag] = a;
  if (!['migrate', 'run'].includes(cmd) || !varsFile) {
    console.error('usage: node sql.js migrate|run <server> <database> <dir|file> <vars.json> [--baseline]\n'
      + '       node sql.js ping <server> <database>\n'
      + '       node sql.js copy-grants <srcServer> <srcDb> <srcUser> <dstServer> <dstDb> <dstUser>');
    process.exit(2);
  }
  const vars = JSON.parse(readText(varsFile));
  const pool = await connect(server, database);
  try {
    if (cmd === 'migrate') await migrate(pool, target, vars, flag === '--baseline');
    else { await runFile(pool, target, vars); console.log(`done: ${path.basename(target)}`); }
  } finally { await pool.close(); }
})().catch((e) => { console.error(`SQL FAILED: ${e.message}`); process.exit(1); });
