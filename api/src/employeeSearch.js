/* Employee search, shared by the Employee screen (GET /api/employees) and the CSV
   download (GET /api/employees/export), so both return exactly the same rows.

   The Employee screen's 検索条件 panel sends one parameter per field, each a
   "contains" match (NFKC, case and spaces ignored, like the History search):
     employee_id      社員番号
     full_name        社員氏名
     email            メール
     department_name  部署
     created_start / created_end   登録日時 From / To (ISO datetime, inclusive)
   search_keyword is the single search box of the result screen (受取人 / CC): it is split on
   spaces and every word must be in 社員番号, 社員氏名, メール or 部署 (any of them). 登録日時 /
   更新日時 are not searched: a short employee id such as "10" would match almost every date.
   Keyword results are ranked (exact match, then prefix, then contains), so the best match
   stays inside the page the app fetches. */

const { toCsv } = require('./csv');
const { normalize, tzOffsetOrDefault, dateParam } = require('./historySearch');

const text = (v) => (v === undefined || v === null ? '' : String(v));
const pad = (n) => String(n).padStart(2, '0');

const trimmed = (v, max = 200) => {
  const t = text(v).trim();
  return t === '' ? null : t.slice(0, max);
};

/**
 * Reads the Employee filters from the request query (`get(name)` returns a string or null).
 * Returns `{ error }` for an invalid value, else the filters.
 */
function parseFilters(get) {
  const createdStart = dateParam(get('created_start'));
  if (createdStart === undefined) return { error: 'created_start must be a valid datetime' };
  const createdEnd = dateParam(get('created_end'));
  if (createdEnd === undefined) return { error: 'created_end must be a valid datetime' };
  if (createdStart && createdEnd && createdStart > createdEnd) {
    return { error: 'created_start must not be after created_end' };
  }
  return {
    employeeId: trimmed(get('employee_id'), 50),
    fullName: trimmed(get('full_name')),
    email: trimmed(get('email'), 320),
    departmentName: trimmed(get('department_name')),
    createdStart,
    createdEnd,
    keyword: trimmed(get('search_keyword')),
    tzOffset: tzOffsetOrDefault(get('tz_offset')),
  };
}

/** True when any filter is set (all of them run here, after SQL). */
const hasFilter = (f) => Boolean(f.employeeId || f.fullName || f.email || f.departmentName
  || f.createdStart || f.createdEnd || f.keyword);

/** search_keyword words, each normalized; full-width spaces split too (NFKC). */
const keywordWords = (keyword) => text(keyword).normalize('NFKC').split(/\s+/).map(normalize).filter(Boolean);

/** 社員番号, 社員氏名, メール, 部署 of a row, normalized. */
const keywordFields = (row) => [row.employee_id, row.full_name, row.email, row.department_name].map(normalize);

/** Rows matching every filter that is set. */
function applyFilters(rows, f) {
  if (!hasFilter(f)) return rows;
  const contains = [
    ['employee_id', f.employeeId], ['full_name', f.fullName],
    ['email', f.email], ['department_name', f.departmentName],
  ].filter(([, v]) => v).map(([col, v]) => [col, normalize(v)]);
  const words = f.keyword ? keywordWords(f.keyword) : [];
  return rows.filter((row) => {
    for (const [col, v] of contains) if (!normalize(row[col]).includes(v)) return false;
    if (f.createdStart || f.createdEnd) {
      const c = row.created_at ? new Date(row.created_at) : null;
      if (!c || Number.isNaN(+c)) return false;
      if (f.createdStart && c < f.createdStart) return false;
      if (f.createdEnd && c > f.createdEnd) return false;
    }
    if (words.length) {
      const fields = keywordFields(row);
      if (!words.every((w) => fields.some((v) => v.includes(w)))) return false;
    }
    return true;
  });
}

/* ---------------------------------------------------------------- Order */

// employee_id is text (e.g. 2012, 10000000004, test-3), so it is compared as a number:
// a plain string sort would put "9" above "10".
const byNumber = new Intl.Collator('en', { numeric: true });
const isNumeric = (v) => /^\d+$/.test(text(v).trim());

/** Newest employee first: employee_id descending, numeric ids before any others. */
const compareIdDesc = (a, b) => (isNumeric(b.employee_id) - isNumeric(a.employee_id))
  || byNumber.compare(text(b.employee_id).trim(), text(a.employee_id).trim());

const sortByIdDesc = (rows) => [...rows].sort(compareIdDesc);

/** 0: 社員番号, 社員氏名 or メール equals the keyword, 1: a field starts with it, 2: contains. */
function keywordRank(row, kw) {
  const [id, name, email, dept] = keywordFields(row);
  if (id === kw || name === kw || email === kw) return 0;
  return [id, name, email, dept].some((v) => v.startsWith(kw)) ? 1 : 2;
}

/** Order of the filtered rows: best keyword match first, else (and within a rank) newest
    employee_id first. */
function sortRows(rows, f) {
  const kw = f.keyword ? normalize(f.keyword) : '';
  if (!kw) return sortByIdDesc(rows);
  return rows.map((row) => ({ row, rank: keywordRank(row, kw) }))
    .sort((a, b) => a.rank - b.rank || compareIdDesc(a.row, b.row))
    .map((x) => x.row);
}

/* ---------------------------------------------------------------- CSV download */

// The same 4 columns as the import file (employeeCsv.js), so a download can be edited
// and imported again. 登録日時 / 更新日時 are not included.
const HEADER = ['社員番号', '社員氏名', 'メール', '部署'];

// A cell starting with = + - @ would run as a formula in Excel, so it is prefixed with '.
const safeCell = (v) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/** CSV text (UTF-8 BOM, CRLF), one row per employee. */
const buildCsv = (rows) => toCsv([HEADER, ...rows.map((row) =>
  [row.employee_id, row.full_name, row.email, row.department_name].map((v) => safeCell(text(v))))]);

/** employee_yyyymmdd_hhmmss.csv in the caller's time zone. */
function fileName(now, tzOffset) {
  const l = new Date(now.getTime() - tzOffset * 60 * 1000);
  return `employee_${l.getUTCFullYear()}${pad(l.getUTCMonth() + 1)}${pad(l.getUTCDate())}_`
    + `${pad(l.getUTCHours())}${pad(l.getUTCMinutes())}${pad(l.getUTCSeconds())}.csv`;
}

module.exports = { parseFilters, hasFilter, applyFilters, sortByIdDesc, sortRows, buildCsv, fileName, HEADER };
