/* History keyword search, shared by the History screen (GET /api/history) and the
   CSV download (GET /api/history/export), so both return exactly the same rows.

   A row matches when the keyword is contained in any of the values the History
   screen shows:
     伝票番号, 受取人 (不明 when empty), 処理状況 (通知済み | 荷物受取済み),
     データ区分 (受取人指定あり | 受取人不明), 通知日時 (yyyy/mm/dd hh:mm, caller's time zone)

   Comparison ignores case, full-width / half-width (NFKC) and spaces, so
   "林健太" matches "林 健太" and "２０２６" matches "2026".
   A date keyword (yyyy/mm/dd, also with - or 年月日, optional hh:mm) is rewritten to the
   display format: "2026/9/24" matches that day, "2026/9/24 14:30" that minute.

   Times are stored in UTC; tz_offset is Power Fx TimeZoneOffset() (minutes, UTC minus
   local: -540 for Japan), default Japan. */

const DEFAULT_TZ_OFFSET = -540;

const text = (v) => (v === undefined || v === null ? '' : String(v));
const pad = (n) => String(n).padStart(2, '0');

/** Labels the History screen shows for a row. */
const labels = (row) => ({
  recipient: text(row.recipient_name) === '' ? '不明' : text(row.recipient_name),
  status: text(row.delivered_at) === '' ? '通知済み' : '荷物受取済み',
  dataType: row.status === 'Identified' ? '受取人指定あり' : '受取人不明',
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

/** Rows matching the keyword (all rows when the keyword is empty). */
function filterRows(rows, keyword, tzOffset = DEFAULT_TZ_OFFSET) {
  const kw = prepareKeyword(keyword);
  if (!kw) return rows;
  return rows.filter((row) => {
    const l = labels(row);
    return [row.slip_no, l.recipient, l.status, l.dataType, formatTime(row.notified_at, tzOffset)]
      .some((f) => normalize(f).includes(kw));
  });
}

module.exports = { filterRows, prepareKeyword, labels, formatTime, tzOffsetOrDefault, DEFAULT_TZ_OFFSET };
