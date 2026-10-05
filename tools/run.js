const fs = require('fs'), sql = require('mssql'), { execSync } = require('child_process');

const token = JSON.parse(execSync(
  'az account get-access-token --resource https://database.windows.net/ -o json',
  { encoding: 'utf8', maxBuffer: 1 << 24 }
)).accessToken;

const cfg = {
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DB,
  authentication: { type: 'azure-active-directory-access-token', options: { token } },
  options: { encrypt: true, trustServerCertificate: false },
  requestTimeout: 180000,
};

// Split on GO batch separators (line containing only GO).
const batches = (text) =>
  text.split(/^\s*GO\s*$/im).map(s => s.trim()).filter(Boolean);

(async () => {
  const pool = await sql.connect(cfg);
  for (const file of process.argv.slice(2)) {
    const bs = batches(fs.readFileSync(file, 'utf8'));
    process.stdout.write(`\n=== ${file} (${bs.length} batches) ===\n`);
    for (let i = 0; i < bs.length; i++) {
      try {
        const r = await pool.request().batch(bs[i]);
        if (r.recordset) console.log(JSON.stringify(r.recordset.slice(0, 25)));
      } catch (e) {
        console.error(`BATCH ${i + 1} FAILED: ${e.message}`);
        console.error(bs[i].slice(0, 300));
        process.exitCode = 1;
      }
    }
    console.log('done');
  }
  await pool.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
