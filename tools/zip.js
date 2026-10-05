/* Builds the deployment zip with POSIX separators.
   PowerShell's Compress-Archive writes backslashes, which Linux hosts cannot
   read as directories - the Functions worker then never finds src/index.js. */
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ROOT = 'D:/eds/database/api';
const OUT = 'D:/eds/database/api-full.zip';
const INCLUDE = ['package.json', 'host.json', 'src', 'node_modules'];

const output = fs.createWriteStream(OUT);
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
  console.log(`wrote ${OUT} (${(archive.pointer() / 1e6).toFixed(1)} MB)`);
});
archive.on('warning', (e) => console.warn('WARN', e.message));
archive.on('error', (e) => { throw e; });
archive.pipe(output);

for (const item of INCLUDE) {
  const full = path.join(ROOT, item);
  if (!fs.existsSync(full)) { console.warn(`missing: ${item}`); continue; }
  if (fs.statSync(full).isDirectory()) archive.directory(full, item);
  else archive.file(full, { name: item });
}

archive.finalize();
