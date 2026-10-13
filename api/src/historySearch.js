/* History search, shared by the History screen (GET /api/history) and the CSV
   download (GET /api/history/export), so both return exactly the same rows.

   The History screen's 検索条件 panel sends one parameter per field:
     slip_no          伝票番号  - contains
     recipient_name   受取人    - contains (a row without a recipient shows and matches 不明)
     status           処理状態  - Notified | Delivered (通知済み | 受取済み)
     data_type        データ区分 - Identified | Unknown (受取人指定あり | 指定なし（不明）)
     notified_start / notified_end   通知日時 From / To (ISO datetime, inclusive)
   status, data_type and the date ranges are filtered in SQL (sp_history_list_v2);
   slip_no, recipient_name and search_keyword are filtered here, after SQL.

   search_keyword (older app versions) still works: a row matches when the keyword
   is contained in any of the values the History screen shows:
     伝票番号, 受取人, 処理状態, データ区分, 通知日時 (yyyy/mm/dd hh:mm, caller's time zone)

   Text comparison ignores case, full-width / half-width (NFKC) and spaces, so
   "林健太" matches "林 健太" and "２０２６" matches "2026".
   A date keyword (yyyy/mm/dd, also with - or 年月日, optional hh:mm) is rewritten to the
   display format: "2026/9/24" matches that day, "2026/9/24 14:30" that minute.

   Times are stored in UTC; tz_offset is Power Fx TimeZoneOffset() (minutes, UTC minus
   local: -540 for Japan), default Japan. */

const DEFAULT_TZ_OFFSET = -540;

const text = (v) => (v === undefined || v === null ? '' : String(v));
const pad = (n) => String(n).padStart(2, '0');

// Screen labels. Keep in step with the app (srcHistory / cmpPager fetch formulas).
const STATUS_LABEL = { Notified: '通知済み', Delivered: '受取済み' };
const DATA_TYPE_LABEL = { Identified: '受取人指定あり', Unknown: '指定なし（不明）' };
// Labels used before 2026-10-13, still accepted as keywords.
const OLD_LABELS = { Delivered: '荷物受取済み', Unknown: '受取人不明' };

/** Labels the History screen shows for a row. */
const labels = (row) => ({
  recipient: text(row.recipient_name) === '' ? '不明' : text(row.recipient_name),
  status: text(row.delivered_at) === '' && row.status !== 'Delivered' ? STATUS_LABEL.Notified : STATUS_LABEL.Delivered,
  dataType: text(row.data_type).toLowerCase() === 'identified' ? DATA_TYPE_LABEL.Identified : DATA_TYPE_LABEL.Unknown,
});

/** Parses tz_offset (minutes, UTC minus local); falls back to Japan. */
function tzOffsetOrDefault(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? n : DEFAULT_TZ_OFFSET;
}

/** yyyy/mm/dd hh:mm in local time, like the screen; '' when empty. */
function formatTime(v, tzOffset) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(+d)) return '';
  const l = new Date(d.getTime() - tzOffset * 60 * 1000);
  return `${l.getUTCFullYear()}/${pad(l.getUTCMonth() + 1)}/${pad(l.getUTCDate())} ${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}`;
}

const normalize = (v) => text(v).normalize('NFKC').toLowerCase().replace(/\s+/g, '');

// After normalize() the date and time are joined without a space.
const DATE_KEYWORD = /^(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?(?:(\d{1,2})[:時](\d{1,2})分?)?$/;
function canonicalKeyword(keyword) {
  const m = DATE_KEYWORD.exec(keyword);
  if (!m) return keyword;
  const [, y, mo, d, h, mi] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return keyword;
  if (h !== undefined && (+h > 23 || +mi > 59)) return keyword;
  return `${y}/${pad(mo)}/${pad(d)}${h !== undefined ? `${pad(h)}:${pad(mi)}` : ''}`;
}

/** Normalized keyword, or '' when there is none. */
const prepareKeyword = (keyword) => canonicalKeyword(normalize(keyword));

/** True when any field contains the keyword (from prepareKeyword or normalize). */
const matchesKeyword = (keyword, fields) => fields.some((f) => normalize(f).includes(keyword));

/* ---------------------------------------------------------------- query parameters */

// Accepted spellings (compared after normalize) -> stored value.
const STATUS_IN = {
  notified: 'Notified', delivered: 'Delivered',
  通知済み: 'Notified', 受取済み: 'Delivered', 荷物受取済み: 'Delivered',
};
const DATA_TYPE_IN = {
  identified: 'Identified', unknown: 'Unknown',
  受取人指定あり: 'Identified', [normalize('指定なし（不明）')]: 'Unknown', 指定なし: 'Unknown', 受取人不明: 'Unknown',
};

const trimmed = (v, max = 200) => {
  const t = text(v).trim();
  return t === '' ? null : t.slice(0, max);
};

/** Parses an ISO datetime; undefined when the value is set but invalid. */
function dateParam(v) {
  if (v === undefined || v === null || text(v).trim() === '') return null;
  const d = new Date(text(v).trim());
  return Number.isNaN(+d) ? undefined : d;
}

/**
 * Reads the History filters from the request query (`get(name)` returns a string or null).
 * Returns `{ error }` for an invalid value, else the filters:
 *   status, dataType, employeeId, notifiedStart, notifiedEnd, deliveredStart, deliveredEnd (SQL)
 *   slipNo, recipientName, keyword, tzOffset (filtered here)
 */
function parseFilters(get) {
  let status = trimmed(get('status'), 20);
  let dataType = trimmed(get('data_type'), 20);

  // Before data_type existed, status carried Identified | Unknown.
  if (status && DATA_TYPE_IN[normalize(status)] && !STATUS_IN[normalize(status)]) {
    dataType = dataType || status;
    status = null;
  }
  if (status) {
    status = STATUS_IN[normalize(status)];
    if (!status) return { error: 'status must be one of Notified, Delivered' };
  }
  if (dataType) {
    dataType = DATA_TYPE_IN[normalize(dataType)];
    if (!dataType) return { error: 'data_type must be one of Identified, Unknown' };
  }

  const dates = {};
  for (const [key, name] of [['notifiedStart', 'notified_start'], ['notifiedEnd', 'notified_end'],
    ['deliveredStart', 'delivered_start'], ['deliveredEnd', 'delivered_end']]) {
    dates[key] = dateParam(get(name));
    if (dates[key] === undefined) return { error: `${name} must be a valid datetime` };
  }
  if (dates.notifiedStart && dates.notifiedEnd && dates.notifiedStart > dates.notifiedEnd) {
    return { error: 'notified_start must not be after notified_end' };
  }

  return {
    status: status || null,
    dataType: dataType || null,
    employeeId: trimmed(get('employee_id'), 50),
    ...dates,
    slipNo: trimmed(get('slip_no')),
    recipientName: trimmed(get('recipient_name')),
    keyword: trimmed(get('search_keyword')),
    tzOffset: tzOffsetOrDefault(get('tz_offset')),
  };
}

/** True when some filter has to run here rather than in SQL. */
const needsRowFilter = (f) => Boolean(f.slipNo || f.recipientName || f.keyword);

/** Rows matching slip_no, recipient_name and search_keyword (all rows when none is set). */
function applyRowFilters(rows, f) {
  const slip = f.slipNo ? normalize(f.slipNo) : '';
  const recipient = f.recipientName ? normalize(f.recipientName) : '';
  const kw = f.keyword ? prepareKeyword(f.keyword) : '';
  if (!slip && !recipient && !kw) return rows;
  const tzOffset = f.tzOffset ?? DEFAULT_TZ_OFFSET;
  return rows.filter((row) => {
    const l = labels(row);
    if (slip && !normalize(row.slip_no).includes(slip)) return false;
    if (recipient && !normalize(l.recipient).includes(recipient)) return false;
    if (kw) {
      const old = [
        l.status === STATUS_LABEL.Delivered ? OLD_LABELS.Delivered : '',
        l.dataType === DATA_TYPE_LABEL.Unknown ? OLD_LABELS.Unknown : '',
      ];
      if (!matchesKeyword(kw, [row.slip_no, l.recipient, l.status, l.dataType,
        formatTime(row.notified_at, tzOffset), ...old])) return false;
    }
    return true;
  });
}

/** Rows matching the keyword (all rows when the keyword is empty). Kept for older callers. */
const filterRows = (rows, keyword, tzOffset = DEFAULT_TZ_OFFSET) =>
  applyRowFilters(rows, { keyword, tzOffset });

module.exports = {
  parseFilters,
  needsRowFilter,
  applyRowFilters,
  filterRows,
  prepareKeyword,
  matchesKeyword,
  normalize,
  dateParam,
  labels,
  formatTime,
  tzOffsetOrDefault,
  DEFAULT_TZ_OFFSET,
  STATUS_LABEL,
  DATA_TYPE_LABEL,
};
