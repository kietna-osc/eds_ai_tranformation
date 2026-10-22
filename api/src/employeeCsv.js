const { CsvParseError, parseCsvRows, toCsv } = require('./csv');
const { message, withDetails } = require('./messages');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;

/* reason is the Japanese cause shown under message 50 (原因：…). */
class ImportFormatError extends Error {
  constructor(messageText, reason) {
    super(messageText);
    this.name = 'ImportFormatError';
    this.reason = reason;
  }
}

/* Causes shown under message 50, so the user knows what to fix in the file. */
const REASONS = {
  empty: 'ファイルが空です',
  noData: 'ヘッダー行のみで、データ行がありません',
  tooLarge: `ファイルサイズが上限（${MAX_BYTES / 1024 / 1024}MB）を超えています`,
  tooManyRows: (n) => `データ行数が上限（${MAX_ROWS.toLocaleString('en-US')}行）を超えています（${n.toLocaleString('en-US')}行）`,
  encoding: '文字コードがUTF-8ではありません（CSV UTF-8形式で保存してください）',
  quote: 'CSVの形式が正しくありません（閉じられていない「"」があります）',
  noHeader: 'ヘッダー行がありません',
  missingColumns: (names) => `必須列がありません：${names.join('、')}`,
};

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

/* A file saved as Shift-JIS (Excel's plain "CSV") decodes to U+FFFD characters. */
const notUtf8 = (csvText) => csvText.includes('\uFFFD');

function validateImport(csvText) {
  if (notUtf8(csvText)) throw new ImportFormatError('not UTF-8', REASONS.encoding);
  let rows;
  try {
    rows = parseCsvRows(csvText);
  } catch (e) {
    if (e instanceof CsvParseError) throw new ImportFormatError(`invalid CSV: ${e.message}`, REASONS.quote);
    throw e;
  }
  if (!rows.length) throw new ImportFormatError('CSV has no header', REASONS.noHeader);

  const header = rows[0].cells;
  const col = {};
  const missing = [];
  for (const [key, names] of Object.entries(HEADERS)) {
    col[key] = headerIndex(header, names);
    if (col[key] < 0) missing.push(names[0]);
  }
  if (missing.length) {
    throw new ImportFormatError(`missing column ${missing.join(', ')}`, REASONS.missingColumns(missing));
  }

  const items = rows.slice(1).map(({ line, cells }) => ({
    line,
    employee_id: (cells[col.employee_id] || '').trim(),
    full_name: (cells[col.full_name] || '').trim(),
    email: (cells[col.email] || '').trim(),
    department_name: (cells[col.department_name] || '').trim(),
    problems: [],
  }));
  for (const item of items) item.problems = rowProblems(item);

  /* A 社員番号 repeated in the file: the upsert needs unique ids and we cannot tell which
     row is right, so every row with that id is skipped, naming the other lines. */
  const linesById = new Map();
  for (const item of items) {
    if (!item.problems.length) linesById.set(item.employee_id, [...(linesById.get(item.employee_id) || []), item.line]);
  }
  for (const item of items) {
    const lines = linesById.get(item.employee_id);
    if (!item.problems.length && lines.length > 1) {
      item.problems.push(`社員番号がファイル内で重複しています（${lines.map((l) => `${l}行目`).join('、')}）`);
    }
  }

  const valid = [];
  const errors = [];
  for (const { problems, line, ...item } of items) {
    if (problems.length) errors.push({ line, ...item, error: problems.join('、') });
    else valid.push(item);
  }
  return { total: items.length, valid, errors };
}

// At most this many codes are listed in message 54; the rest become "ほかN件".
const MAX_LISTED_CODES = 10;
// At most this many error rows are listed under message 51 / 53; the rest are in the error file.
const MAX_LISTED_ROWS = 5;

const codeList = (ids) => (ids.length > MAX_LISTED_CODES
  ? `${ids.slice(0, MAX_LISTED_CODES).join('、')} ほか${ids.length - MAX_LISTED_CODES}件`
  : ids.join('、'));

/** Response when the file could not be imported at all (message 50, plus 原因：reason
 *  when the cause is known). Same fields as importResult, so the flow's Parse_JSON
 *  accepts it for every status code. */
function uploadFailed(total = 0, reason = '') {
  return {
    success: false,
    total,
    inserted: 0,
    updated: 0,
    skipped: 0,
    messages: [withDetails(message(50), reason ? [`原因：${reason}`] : [])],
    errorFile: null,
    errorFileName: null,
    errorFileUrl: null,
  };
}

/** The first rows of the error file as popup lines: "・3行目：メールアドレスの形式が…". */
function errorLines(errors) {
  const lines = errors.slice(0, MAX_LISTED_ROWS).map((e) => `・${e.line}行目：${e.error}`);
  if (errors.length > MAX_LISTED_ROWS) {
    lines.push(`ほか${errors.length - MAX_LISTED_ROWS}行（すべての行はエラー詳細ファイルをご確認ください）`);
  }
  return lines;
}

const ERROR_FILE_HEADER = ['行番号', '社員番号', '社員氏名', 'メール', '部署', 'エラー内容'];

/** Error file name (ASCII, for the download link) in local time. tzOffset is Power Fx
 *  TimeZoneOffset() (minutes, JST = -540); the flow does not send it, so JST is the default. */
function errorFileName(now = new Date(), tzOffset = -540) {
  const t = new Date(now.getTime() - tzOffset * 60 * 1000).toISOString();
  return `employee_import_errors_${t.slice(0, 10).replace(/-/g, '')}${t.slice(11, 19).replace(/:/g, '')}.csv`;
}

function importResult(checked, upserted) {
  const inserted = upserted.filter((r) => r.action === 'INSERT').length;
  const updatedIds = upserted.filter((r) => r.action === 'UPDATE').map((r) => r.employee_id);
  const skipped = checked.errors.length;
  const messages = [];
  if (!checked.valid.length) messages.push(withDetails(message(53, { X: checked.total }), errorLines(checked.errors)));
  else if (skipped) messages.push(withDetails(message(51, { X: inserted, Y: skipped }), errorLines(checked.errors)));
  else messages.push(message(52, { X: inserted }));
  if (updatedIds.length) messages.push(message(54, { X: updatedIds.length, LIST: codeList(updatedIds) }));

  return {
    success: checked.valid.length > 0,
    total: checked.total,
    inserted,
    updated: updatedIds.length,
    skipped,
    messages,
    // CSV (UTF-8 with BOM) of every skipped row; the handler stores it and adds errorFileUrl.
    errorFile: skipped
      ? toCsv([ERROR_FILE_HEADER].concat(checked.errors.map((e) =>
        [e.line, e.employee_id, e.full_name, e.email, e.department_name, e.error])))
      : null,
    errorFileName: null,
    errorFileUrl: null,
  };
}

module.exports = {
  ImportFormatError,
  REASONS,
  tooLarge,
  tooManyRows,
  validateImport,
  uploadFailed,
  importResult,
  errorFileName,
};
