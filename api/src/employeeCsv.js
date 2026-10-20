const { CsvParseError, parseCsv } = require('./csv');
const { message } = require('./messages');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;

class ImportFormatError extends Error {
  constructor(messageText) {
    super(messageText);
    this.name = 'ImportFormatError';
  }
}

const HEADERS = {
  employee_id: ['社員番号', 'employee_id'],
  full_name: ['社員氏名', 'full_name'],
  email: ['メール', 'email'],
  department_name: ['部署', 'department_name'],
};

function tooLarge(csvText) {
  return Buffer.byteLength(csvText, 'utf8') > MAX_BYTES;
}

function tooManyRows(total) {
  return total > MAX_ROWS;
}

function headerIndex(header, names) {
  const cells = header.map((h) => h.trim());
  return names.map((name) => cells.indexOf(name)).find((i) => i >= 0) ?? -1;
}

/* Same rules as the employee create popup in the app (cmpEmpModal, IsMatch = whole text):
   社員番号 half-width letters and digits only, メール like a@b.cc. The texts go to the
   error file's "error" column. */
const EMPLOYEE_ID = /^[A-Za-z0-9]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;

/** Problems of one row, as Japanese texts (empty when the row is valid). */
function rowProblems(item) {
  const problems = [];
  if (!item.employee_id) problems.push('社員番号は必須です');
  else if (!EMPLOYEE_ID.test(item.employee_id)) problems.push('社員番号は半角英数字のみ使用できます');
  else if (item.employee_id.length > 50) problems.push('社員番号は50文字以内で入力してください');
  if (!item.full_name) problems.push('社員氏名は必須です');
  else if (item.full_name.length > 200) problems.push('社員氏名は200文字以内で入力してください');
  if (!item.email) problems.push('メールは必須です');
  else if (!EMAIL.test(item.email)) problems.push('メールアドレスの形式が正しくありません');
  else if (item.email.length > 320) problems.push('メールは320文字以内で入力してください');
  if (!item.department_name) problems.push('部署は必須です');
  else if (item.department_name.length > 200) problems.push('部署は200文字以内で入力してください');
  return problems;
}

function validateImport(csvText) {
  let rows;
  try {
    rows = parseCsv(csvText);
  } catch (e) {
    if (e instanceof CsvParseError) throw e;
    throw new CsvParseError(e.message);
  }
  if (!rows.length) throw new ImportFormatError('CSV has no header');

  const header = rows[0];
  const col = {};
  for (const [key, names] of Object.entries(HEADERS)) {
    col[key] = headerIndex(header, names);
    if (col[key] < 0) throw new ImportFormatError(`missing column ${names[0]}`);
  }

  const valid = [];
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const line = rows[i];
    const item = {
      employee_id: (line[col.employee_id] || '').trim(),
      full_name: (line[col.full_name] || '').trim(),
      email: (line[col.email] || '').trim(),
      department_name: (line[col.department_name] || '').trim(),
    };
    const problems = rowProblems(item);
    if (problems.length) errors.push({ line: i + 1, ...item, error: problems.join('、') });
    else valid.push(item);
  }

  return { total: rows.length - 1, valid, errors };
}

// At most this many codes are listed in message 54; the rest become "ほかN件".
const MAX_LISTED_CODES = 10;

/** Valid rows whose 社員番号 appears more than once in the file (the upsert needs unique ids). */
function duplicateIds(valid) {
  const seen = new Set();
  const dup = new Set();
  for (const r of valid) {
    if (seen.has(r.employee_id)) dup.add(r.employee_id);
    seen.add(r.employee_id);
  }
  return [...dup];
}

const codeList = (ids) => (ids.length > MAX_LISTED_CODES
  ? `${ids.slice(0, MAX_LISTED_CODES).join('、')} ほか${ids.length - MAX_LISTED_CODES}件`
  : ids.join('、'));

/** Response when the file could not be imported at all (message 50). Same fields as
 *  importResult, so the flow's Parse_JSON accepts it for every status code. */
function uploadFailed(total = 0) {
  return {
    success: false,
    total,
    inserted: 0,
    updated: 0,
    skipped: 0,
    messages: [message(50)],
    errorFile: null,
  };
}

function importResult(checked, upserted) {
  const inserted = upserted.filter((r) => r.action === 'INSERT').length;
  const updatedIds = upserted.filter((r) => r.action === 'UPDATE').map((r) => r.employee_id);
  const skipped = checked.errors.length;
  const messages = [];
  if (!checked.valid.length) messages.push(message(53, { X: checked.total }));
  else if (skipped) messages.push(message(51, { X: inserted, Y: skipped }));
  else messages.push(message(52, { X: inserted }));
  if (updatedIds.length) messages.push(message(54, { X: updatedIds.length, LIST: codeList(updatedIds) }));

  return {
    success: checked.valid.length > 0,
    total: checked.total,
    inserted,
    updated: updatedIds.length,
    skipped,
    messages,
    errorFile: skipped
      ? ['line,社員番号,社員氏名,メール,部署,error']
        .concat(checked.errors.map((e) =>
          [e.line, e.employee_id, e.full_name, e.email, e.department_name, e.error]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))
        .join('\r\n')
      : null,
  };
}

module.exports = {
  ImportFormatError,
  tooLarge,
  tooManyRows,
  validateImport,
  duplicateIds,
  uploadFailed,
  importResult,
};
