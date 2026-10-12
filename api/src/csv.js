class CsvParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/** Parse a CSV text into rows of strings. Supports quotes, commas, and CRLF. */
function parseCsv(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (inQuotes) throw new CsvParseError('unterminated quote');
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const quote = (v) => {
  const t = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** Writes rows (arrays) as CSV with CRLF line endings and a UTF-8 BOM, so Excel
 *  opens Japanese text correctly. Used by the History download (historyCsv.js). */
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';

module.exports = { CsvParseError, parseCsv, toCsv };
