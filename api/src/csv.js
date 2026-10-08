/* Minimal RFC 4180 CSV reader / writer. toCsv is used by the History download
   (historyCsv.js); parseCsv is kept for reading CSV files back. */

class CsvParseError extends Error {}

/** Parses CSV text into an array of records (arrays of strings).
 *  Handles a UTF-8 BOM, quoted fields with "" escapes and embedded newlines,
 *  and CRLF / LF line endings. Throws CsvParseError on an unclosed quote. */
function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { record.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      record.push(field); records.push(record); record = []; field = '';
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (quoted) throw new CsvParseError('unclosed quoted field');
  if (field !== '' || record.length) { record.push(field); records.push(record); }
  return records;
}

const quote = (v) => {
  const t = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** Writes rows (arrays) as CSV with CRLF line endings and a UTF-8 BOM, so Excel
 *  opens Japanese text correctly. */
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';

module.exports = { parseCsv, toCsv, CsvParseError };
