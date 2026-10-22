class CsvParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/** Parse a CSV text into { line, cells } rows: line is the file line (1-based) the row
 *  starts on, so error messages match the row numbers Excel shows even when blank lines
 *  are skipped. Supports quotes, commas, and CRLF. */
function parseCsvRows(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let lineNo = 1;
  let rowLine = 1;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') lineNo++;
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
      rows.push({ line: rowLine, cells: row });
      row = [];
      field = '';
      rowLine = lineNo;
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (inQuotes) throw new CsvParseError('unterminated quote');
  if (field.length || row.length) {
    row.push(field);
    rows.push({ line: rowLine, cells: row });
  }
  return rows.filter((r) => r.cells.some((cell) => cell.trim() !== ''));
}

/** Parse a CSV text into rows of strings (see parseCsvRows). */
const parseCsv = (text) => parseCsvRows(text).map((r) => r.cells);

const quote = (v) => {
  const t = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** Writes rows (arrays) as CSV with CRLF line endings and a UTF-8 BOM, so Excel
 *  opens Japanese text correctly. Used by the History download (historyCsv.js). */
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';

module.exports = { CsvParseError, parseCsv, parseCsvRows, toCsv };
