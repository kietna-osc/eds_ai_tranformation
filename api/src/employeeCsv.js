/* Employee CSV import (POST /api/employees/import): file checks, row validation and the
   response the app shows as it is. Cases and texts: ErrorDesign 50-56 (messages.js).

   Response body (every status code):
     status    'success' | 'partial' | 'error'
     title     popup title
     message   popup text, one sentence or one error row per line
     error     null, or { code, reason, rowCount, rows }: rows = the error rows listed in
               the message (at most MAX_LISTED_ROWS), each { line, employee_id, errors:
               [{ column, value, message }] }
     errorFile null, or { fileName, url }: CSV of every error (one line per cell) when
               there are more error rows than the message lists
     summary   { total, inserted, updated, skipped }
     messages  [{ id, text }] the ErrorDesign ids that make up the message */
const { CsvParseError, parseCsvRows, toCsv } = require('./csv');
const { TITLES, message, sentences } = require('./messages');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;
// Error rows listed in the popup; with more, the rows go to the error file instead.
const MAX_LISTED_ROWS = 5;
// Codes listed in message 54; the rest become "ほかN件".
const MAX_LISTED_CODES = 10;

const fmt = (n) => n.toLocaleString('en-US');

/* Causes shown as 原因：… under message 50 / 55, so the user knows what to fix. */
const REASONS = {
  notCsv: (name) => `CSVファイル（.csv）ではありません（${name}）`,
  empty: 'ファイルが空です',
  noData: 'ヘッダー行のみで、データ行がありません',
  noHeader: 'ヘッダー行がありません',
  missingColumns: (names) => `必須列がありません：${names.join('、')}`,
  quote: 'CSVの形式が正しくありません（閉じられていない「"」があります）',
  encoding: '文字コードがUTF-8ではありません',
  tooLarge: (bytes) => `ファイルサイズ ${(bytes / 1024 / 1024).toFixed(1)}MB（上限 ${MAX_BYTES / 1024 / 1024}MB）`,
  tooManyRows: (n) => `データ行数 ${fmt(n)}行（上限 ${fmt(MAX_ROWS)}行）`,
};

/** A file that cannot be imported at all: ErrorDesign code 50 / 55 / 56, HTTP status, cause. */
class ImportError extends Error {
  constructor(code, httpStatus, reason, log) {
    super(log || reason || `import error ${code}`);
    this.name = 'ImportError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.reason = reason || null;
  }
}

const COLUMNS = {
  employee_id: { label: '社員番号', names: ['社員番号', 'employee_id'] },
  full_name: { label: '社員氏名', names: ['社員氏名', 'full_name'] },
  email: { label: 'メール', names: ['メール', 'email'] },
  department_name: { label: '部署', names: ['部署', 'department_name'] },
};

/* Same rules as the employee create popup in the app (cmpEmpModal, IsMatch = whole text). */
const EMPLOYEE_ID = /^[A-Za-z0-9]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;

/** Problems of one row: [{ column, value, message }] (empty when the row is valid). */
function rowProblems(item) {
  const problems = [];
  const add = (key, text) => problems.push({ column: COLUMNS[key].label, value: item[key], message: text });
  if (!item.employee_id) add('employee_id', '社員番号は必須です');
  else if (!EMPLOYEE_ID.test(item.employee_id)) add('employee_id', '社員番号は半角英数字のみ使用できます');
  else if (item.employee_id.length > 50) add('employee_id', '社員番号は50文字以内で入力してください');
  if (!item.full_name) add('full_name', '社員氏名は必須です');
  else if (item.full_name.length > 200) add('full_name', '社員氏名は200文字以内で入力してください');
  if (!item.email) add('email', 'メールは必須です');
  else if (!EMAIL.test(item.email)) add('email', 'メールアドレスの形式が正しくありません');
  else if (item.email.length > 320) add('email', 'メールは320文字以内で入力してください');
  if (!item.department_name) add('department_name', '部署は必須です');
  else if (item.department_name.length > 200) add('department_name', '部署は200文字以内で入力してください');
  return problems;
}

/** Checks of the file as a whole (50 / 55), before the rows are read. */
function checkFile(fileName, csvText) {
  if (fileName && !/\.csv$/i.test(fileName.trim())) throw new ImportError(50, 400, REASONS.notCsv(fileName), 'not a .csv file');
  if (!csvText) throw new ImportError(50, 400, REASONS.empty, 'empty file');
  const bytes = Buffer.byteLength(csvText, 'utf8');
  if (bytes > MAX_BYTES) throw new ImportError(55, 413, REASONS.tooLarge(bytes), `file too large (${bytes} bytes)`);
  // A file saved as Shift-JIS (Excel's plain "CSV") decodes to U+FFFD characters.
  if (csvText.includes('�')) throw new ImportError(50, 400, REASONS.encoding, 'not UTF-8');
}

/** Reads and validates the rows: { total, valid, errors }. errors: [{ line, employee_id, errors }]. */
function validateImport(csvText) {
  let rows;
  try {
    rows = parseCsvRows(csvText);
  } catch (e) {
    if (e instanceof CsvParseError) throw new ImportError(50, 400, REASONS.quote, `invalid CSV: ${e.message}`);
    throw e;
  }
  if (!rows.length) throw new ImportError(50, 400, REASONS.noHeader, 'no header');

  const header = rows[0].cells.map((h) => h.trim());
  const col = {};
  const missing = [];
  for (const [key, { label, names }] of Object.entries(COLUMNS)) {
    col[key] = names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
    if (col[key] < 0) missing.push(label);
  }
  if (missing.length) throw new ImportError(50, 400, REASONS.missingColumns(missing), `missing column ${missing.join(', ')}`);

  const total = rows.length - 1;
  if (!total) throw new ImportError(50, 400, REASONS.noData, 'no data rows');
  if (total > MAX_ROWS) throw new ImportError(55, 413, REASONS.tooManyRows(total), `too many rows (${total})`);

  const items = rows.slice(1).map(({ line, cells }) => {
    const item = { line };
    for (const key of Object.keys(COLUMNS)) item[key] = (cells[col[key]] || '').trim();
    item.problems = rowProblems(item);
    return item;
  });

  /* A 社員番号 repeated in the file: the upsert needs unique ids and we cannot tell which
     row is right, so every row with that id is skipped, naming the other lines. */
  const linesById = new Map();
  for (const item of items) {
    if (!item.problems.length) linesById.set(item.employee_id, [...(linesById.get(item.employee_id) || []), item.line]);
  }
  for (const item of items) {
    const lines = item.problems.length ? [] : linesById.get(item.employee_id);
    if (lines.length > 1) {
      item.problems.push({
        column: COLUMNS.employee_id.label,
        value: item.employee_id,
        message: `社員番号がファイル内で重複しています（${lines.map((l) => `${l}行目`).join('、')}）`,
      });
    }
  }

  const valid = [];
  const errors = [];
  for (const { line, problems, ...item } of items) {
    if (problems.length) errors.push({ line, employee_id: item.employee_id, errors: problems });
    else valid.push(item);
  }
  return { total, valid, errors };
}

/** Error file: one line per problem, so the user sees the row and the column. UTF-8 BOM for Excel. */
function errorCsv(errors) {
  return toCsv([['行番号', '社員番号', '列名', '入力値', 'エラー内容']].concat(errors.flatMap((r) =>
    r.errors.map((p) => [r.line, r.employee_id, p.column, p.value, p.message]))));
}

/** Error file name (ASCII, for the download link) in local time. tzOffset is Power Fx
 *  TimeZoneOffset() (minutes, JST = -540); JST when the flow does not send it. */
function errorFileName(now = new Date(), tzOffset = -540) {
  const t = new Date(now.getTime() - tzOffset * 60 * 1000).toISOString();
  return `employee_import_errors_${t.slice(0, 10).replace(/-/g, '')}${t.slice(11, 19).replace(/:/g, '')}.csv`;
}

/** True when the error rows go to a file instead of the popup. */
const needsErrorFile = (checked) => checked.errors.length > MAX_LISTED_ROWS;

const rowLine = (r) => `・${r.line}行目：${r.errors.map((p) => p.message).join('、')}`;

const codeList = (ids) => (ids.length > MAX_LISTED_CODES
  ? `${ids.slice(0, MAX_LISTED_CODES).join('、')} ほか${ids.length - MAX_LISTED_CODES}件`
  : ids.join('、'));

/** Body for a file that could not be imported (50 / 55 / 56 / unexpected). */
function failure(code, reason = null) {
  const msg = message(code);
  return {
    status: 'error',
    title: TITLES.error,
    message: [...sentences(msg.text), ...(reason ? [`原因：${reason}`] : [])].join('\n'),
    error: { code, reason, rowCount: 0, rows: [] },
    errorFile: null,
    summary: { total: 0, inserted: 0, updated: 0, skipped: 0 },
    messages: [msg],
  };
}

/** Body after the rows were checked (and the valid ones upserted). errorFile = { fileName, url }
 *  when the error rows were stored as a file; without it they are listed (first 5, ほかN行). */
function importResult(checked, upserted, errorFile = null) {
  const inserted = upserted.filter((r) => r.action === 'INSERT').length;
  const updatedIds = upserted.filter((r) => r.action === 'UPDATE').map((r) => r.employee_id);
  const skipped = checked.errors.length;

  let status;
  const messages = [];
  if (!checked.valid.length) {
    status = 'error';
    messages.push(message(53, { X: checked.total }));
  } else if (skipped) {
    status = 'partial';
    messages.push(message(51, { X: inserted, Y: skipped }));
  } else {
    status = 'success';
    messages.push(message(52, { X: inserted }));
  }
  if (updatedIds.length) messages.push(message(54, { X: updatedIds.length, LIST: codeList(updatedIds) }));

  const listed = errorFile ? [] : checked.errors.slice(0, MAX_LISTED_ROWS);
  const details = [];
  if (errorFile) {
    details.push(`エラー行が${fmt(skipped)}行あるため、「確認」を押すとエラー詳細ファイル（CSV）をダウンロードします。`);
  } else if (skipped) {
    details.push('エラー内容：', ...listed.map(rowLine));
    if (skipped > listed.length) details.push(`ほか${fmt(skipped - listed.length)}行`);
  }

  return {
    status,
    title: TITLES[status],
    message: [...messages.flatMap((m) => sentences(m.text)), ...details].join('\n'),
    error: skipped ? { code: messages[0].id, reason: null, rowCount: skipped, rows: listed } : null,
    errorFile,
    summary: { total: checked.total, inserted, updated: updatedIds.length, skipped },
    messages,
  };
}

module.exports = {
  ImportError,
  REASONS,
  MAX_LISTED_ROWS,
  checkFile,
  validateImport,
  needsErrorFile,
  errorCsv,
  errorFileName,
  failure,
  importResult,
};
