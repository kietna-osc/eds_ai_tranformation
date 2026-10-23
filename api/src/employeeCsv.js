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
// Error rows listed in the popup (5 included); with more, the rows go to the error file instead.
const MAX_LISTED_ROWS = 5;

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

/* csv_base64 as the flow sends it. Besides plain base64 (the trigger's contentBytes), accept
   the shapes a flow body easily ends up with, so a different expression does not turn every
   file into 「文字コードがUTF-8ではありません」: a data URI, the whole file object (or its JSON
   text) with contentBytes / $content, and the CSV text itself. Returns { text, form }. */
const BASE64 = /^[A-Za-z0-9+/\s]+={0,2}\s*$/;

function decodeUpload(value) {
  if (value && typeof value === 'object') {
    const inner = value.contentBytes ?? value.$content ?? value.content;
    return inner === undefined ? { text: '', form: 'object without content' } : { ...decodeUpload(inner), form: 'file object' };
  }
  if (typeof value !== 'string') return { text: '', form: 'missing' };
  const v = value.replace(/^\uFEFF/, '').trim();
  if (!v) return { text: '', form: 'empty' };
  if (v.startsWith('{')) {
    try {
      return { ...decodeUpload(JSON.parse(v)), form: 'file object (JSON text)' };
    } catch { /* not JSON: fall through */ }
  }
  const uri = v.match(/^data:[^,]*?;base64,(.*)$/s);
  if (uri) return { text: Buffer.from(uri[1], 'base64').toString('utf8'), form: 'data URI' };
  if (BASE64.test(v)) return { text: Buffer.from(v, 'base64').toString('utf8'), form: 'base64' };
  return { text: value, form: 'text' };
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
     row is right, so every row with that id is skipped, naming the other lines. Compared
     case-insensitively, like the database (default collation): abc1 and ABC1 are one id. */
  const idKey = (id) => id.toLowerCase();
  const linesById = new Map();
  for (const item of items) {
    if (!item.problems.length) linesById.set(idKey(item.employee_id), [...(linesById.get(idKey(item.employee_id)) || []), item.line]);
  }
  for (const item of items) {
    const lines = item.problems.length ? [] : linesById.get(idKey(item.employee_id));
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
  for (const { problems, ...item } of items) {
    if (problems.length) errors.push({ line: item.line, employee_id: item.employee_id, errors: problems });
    else valid.push(item);
  }
  return { total, valid, errors };
}

/** The rows sp_employee_upsert receives (valid rows without their line number). */
const upsertRows = (checked) => checked.valid.map(({ line, ...row }) => row);

/* ErrorDesign 47 (Create/Update — email重複チェック), applied to the import like the create
   popup does: an email used twice in the file, or used by another employee in the database.
   Employees that are in the file do not count as "another": their email is replaced. */
function markEmailConflicts(checked, dbRows) {
  const key = (v) => String(v ?? '').trim().toLowerCase();
  const inFile = new Set(checked.valid.map((r) => key(r.employee_id)));
  const dbOwner = new Map();
  for (const r of dbRows) {
    if (!inFile.has(key(r.employee_id)) && key(r.email)) dbOwner.set(key(r.email), String(r.employee_id));
  }
  const linesByEmail = new Map();
  for (const r of checked.valid) linesByEmail.set(key(r.email), [...(linesByEmail.get(key(r.email)) || []), r.line]);

  const keep = [];
  for (const r of checked.valid) {
    const lines = linesByEmail.get(key(r.email));
    let text = null;
    if (lines.length > 1) text = `メールアドレスがファイル内で重複しています（${lines.map((l) => `${l}行目`).join('、')}）`;
    else if (dbOwner.has(key(r.email))) text = `このメールアドレスは既に他の従業員に使用されています（社員番号：${dbOwner.get(key(r.email))}）`;
    if (text) checked.errors.push({ line: r.line, employee_id: r.employee_id, errors: [{ column: COLUMNS.email.label, value: r.email, message: text }] });
    else keep.push(r);
  }
  checked.valid = keep;
  checked.errors.sort((a, b) => a.line - b.line);
  return checked;
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
  const updated = upserted.filter((r) => r.action === 'UPDATE').length;
  const skipped = checked.errors.length;
  // 成功 = added + updated rows (codes already in the DB are updated).
  const counts = { OK: fmt(inserted + updated), Y: fmt(skipped) };

  let status;
  let msg;
  if (!checked.valid.length) {
    status = 'error';
    msg = message(53, counts);
  } else if (skipped) {
    status = 'partial';
    msg = message(51, counts);
  } else {
    status = 'success';
    msg = message(52, counts);
  }

  const listed = errorFile ? [] : checked.errors.slice(0, MAX_LISTED_ROWS);
  const details = [];
  if (errorFile) {
    details.push('エラー詳細はダウンロードされるファイル（CSV）をご確認ください。');
  } else if (skipped) {
    details.push('エラー内容：', ...listed.map(rowLine));
    if (skipped > listed.length) details.push(`ほか${fmt(skipped - listed.length)}件`);
  }

  return {
    status,
    title: TITLES[status],
    message: [...sentences(msg.text), ...details].join('\n'),
    error: skipped ? { code: msg.id, reason: null, rowCount: skipped, rows: listed } : null,
    errorFile,
    summary: { total: checked.total, inserted, updated, skipped },
    messages: [msg],
  };
}

module.exports = {
  ImportError,
  REASONS,
  MAX_LISTED_ROWS,
  decodeUpload,
  checkFile,
  validateImport,
  markEmailConflicts,
  upsertRows,
  needsErrorFile,
  errorCsv,
  errorFileName,
  failure,
  importResult,
};
