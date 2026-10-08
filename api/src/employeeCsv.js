/* Employee CSV import / export (Function_Design_Messages 51-58).

   File format (import and export are the same, so an exported file can be
   edited and imported again):
     社員番号,社員氏名,メール,部署
   - 社員番号 (employee_code) and 社員氏名 (full_name) are required.
   - メール and 部署 are optional. "Eメール" and the DB column names
     (employee_code, full_name, email, department_name) are accepted as headers.
   - UTF-8, with or without BOM. Blank lines are ignored. */
const { parseCsv, toCsv } = require('./csv');
const { message } = require('./messages');

const MAX_IMPORT_BYTES = Number(process.env.CSV_IMPORT_MAX_BYTES) || 2 * 1024 * 1024;
const MAX_IMPORT_ROWS = Number(process.env.CSV_IMPORT_MAX_ROWS) || 10000;
const LIST_LIMIT = 20; // codes shown in message 54 before "他N件"

const COLUMNS = [
  { key: 'employee_code', label: '社員番号', max: 50, required: true, aliases: ['employee_code'] },
  { key: 'full_name', label: '社員氏名', max: 200, required: true, aliases: ['full_name'] },
  { key: 'email', label: 'メール', max: 320, required: false, aliases: ['eメール', 'email'] },
  { key: 'department_name', label: '部署', max: 200, required: false, aliases: ['department_name'] },
];
const HEADER = COLUMNS.map((c) => c.label);
const headerKey = (h) => String(h ?? '').normalize('NFKC').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class ImportFormatError extends Error {}

/** Size checks for message 55: bytes before parsing, data rows after. */
const tooLarge = (csvText) => Buffer.byteLength(csvText, 'utf8') > MAX_IMPORT_BYTES;
const tooManyRows = (total) => total > MAX_IMPORT_ROWS;

/** Parses and validates every row independently.
 *  Returns { total, valid: [{line, employee_code, ...}], errors: [{line, employee_code, full_name, reasons}] }.
 *  `line` is the record number in the file (header = 1; blank lines keep their number).
 *  Throws ImportFormatError when the file has no usable header or no data rows. */
function validateImport(csvText) {
  const numbered = parseCsv(csvText)
    .map((rec, i) => ({ rec, line: i + 1 }))
    .filter(({ rec }) => rec.some((v) => v.trim() !== ''));
  if (!numbered.length) throw new ImportFormatError('CSV is empty');
  const records = numbered.map((n) => n.rec);

  const header = records[0].map(headerKey);
  const index = {};
  for (const col of COLUMNS) {
    const names = [headerKey(col.label), ...col.aliases];
    const at = header.findIndex((h) => names.includes(h));
    if (at >= 0) index[col.key] = at;
    else if (col.required) throw new ImportFormatError(`missing column ${col.label}`);
  }
  if (records.length < 2) throw new ImportFormatError('CSV has no data rows');

  const valid = [];
  const errors = [];
  const seen = new Map(); // employee_code -> first line
  numbered.slice(1).forEach(({ rec, line }) => {
    const row = { line };
    const reasons = [];
    if (rec.length !== records[0].length) reasons.push('列数がヘッダーと一致しません');
    for (const col of COLUMNS) {
      const v = index[col.key] === undefined ? '' : String(rec[index[col.key]] ?? '').trim();
      row[col.key] = v;
      if (col.required && !v) reasons.push(`${col.label}が未入力です`);
      else if (v.length > col.max) reasons.push(`${col.label}は${col.max}文字以内で入力してください`);
    }
    if (row.email && row.email.length <= 320 && !EMAIL.test(row.email)) reasons.push('メールの形式が正しくありません');
    if (row.employee_code) {
      if (seen.has(row.employee_code)) {
        reasons.push(`社員番号がファイル内で重複しています（${seen.get(row.employee_code)}行目と同じ）`);
      } else if (!reasons.length) {
        seen.set(row.employee_code, line);
      }
    }
    if (reasons.length) errors.push({ line, employee_code: row.employee_code, full_name: row.full_name, reasons });
    else valid.push(row);
  });
  return { total: records.length - 1, valid, errors };
}

const errorFileCsv = (errors) => toCsv([
  ['行番号', '社員番号', '社員氏名', 'エラー内容'],
  ...errors.map((e) => [e.line, e.employee_code, e.full_name, e.reasons.join('／')]),
]);

const stamp = (d = new Date()) => {
  const t = new Date(d.getTime() + 9 * 3600 * 1000); // JST
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}_${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
};

const codeList = (codes) => (codes.length > LIST_LIMIT
  ? `${codes.slice(0, LIST_LIMIT).join('、')} 他${codes.length - LIST_LIMIT}件`
  : codes.join('、'));

/** Builds the import response body from validation + the procedure's result rows.
 *  upserted: [{employee_code, action: 'inserted' | 'updated'}] (empty when nothing was written). */
function importResult({ total, valid, errors }, upserted) {
  const inserted = upserted.filter((r) => r.action === 'inserted').map((r) => r.employee_code);
  const updated = upserted.filter((r) => r.action === 'updated').map((r) => r.employee_code);
  const messages = [];
  if (!valid.length) {
    messages.push(message(53, { X: total }));
  } else {
    messages.push(errors.length
      ? message(51, { X: inserted.length, Y: errors.length })
      : message(52, { X: inserted.length }));
    if (updated.length) messages.push(message(54, { X: updated.length, リスト: codeList(updated) }));
  }
  return {
    success: valid.length > 0,
    totalRows: total,
    insertedCount: inserted.length,
    updatedCount: updated.length,
    skippedCount: errors.length,
    inserted,
    updated,
    errors: errors.map((e) => ({ line: e.line, employee_code: e.employee_code, reasons: e.reasons })),
    errorFile: errors.length
      ? { fileName: `employee_import_errors_${stamp()}.csv`, contentType: 'text/csv', content: errorFileCsv(errors) }
      : null,
    messages,
  };
}

/** Export file: every employee, same columns as the import file. */
const exportResult = (rows) => ({
  rowCount: rows.length,
  file: {
    fileName: `employees_${stamp()}.csv`,
    contentType: 'text/csv',
    content: toCsv([HEADER, ...rows.map((r) => [r.employee_code, r.full_name, r.email, r.department_name])]),
  },
  messages: [message(57)],
});

module.exports = {
  MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, HEADER,
  ImportFormatError, tooLarge, tooManyRows, validateImport, importResult, exportResult,
};
