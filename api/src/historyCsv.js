/* History CSV download (GET /api/history/export).

   The keyword filter is the History screen's own search, so the file holds exactly
   the rows the screen shows (srcHistory → galHistory.Items):
     Lower(keyword) in Lower(slip & " " & recipient & " " & status & " " & dataType)
   with recipient "不明" when empty, status 通知済み / 荷物受取済み (from delivered_at)
   and dataType 受取人指定あり / 受取人不明 (from status). No keyword: every row.

   Times are stored in UTC. They are written in the caller's time zone, given as
   Power Fx TimeZoneOffset() (minutes, UTC minus local: -540 for Japan), so the file
   shows the same times as the screen. */

const { toCsv } = require('./csv');

const DEFAULT_TZ_OFFSET = -540; // Japan, when the caller does not send one

const HEADER = ['履歴ID', '伝票番号', '処理状況', 'データ区分', '受取人', '受取部署',
  '品名', '送り主', '送り主住所', '通知日時', '受取日時', '受取担当者'];

const text = (v) => (v === undefined || v === null ? '' : String(v));

const labels = (row) => ({
  recipient: text(row.recipient_name) === '' ? '不明' : text(row.recipient_name),
  status: text(row.delivered_at) === '' ? '通知済み' : '荷物受取済み',
  dataType: row.status === 'Identified' ? '受取人指定あり' : '受取人不明',
});

/** Rows matching the keyword, the way the History screen searches. */
function filterRows(rows, keyword) {
  const kw = text(keyword).trim().toLowerCase();
  if (!kw) return rows;
  return rows.filter((row) => {
    const l = labels(row);
    return `${text(row.slip_no)} ${l.recipient} ${l.status} ${l.dataType}`.toLowerCase().includes(kw);
  });
}

/** Parses tz_offset (minutes, UTC minus local); falls back to Japan. */
function tzOffsetOrDefault(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? n : DEFAULT_TZ_OFFSET;
}

const pad = (n) => String(n).padStart(2, '0');

/** yyyy/mm/dd hh:mm in local time, like the screen; '' when empty. */
function formatTime(v, tzOffset) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(+d)) return '';
  const l = new Date(d.getTime() - tzOffset * 60 * 1000);
  return `${l.getUTCFullYear()}/${pad(l.getUTCMonth() + 1)}/${pad(l.getUTCDate())} ${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}`;
}

/* Names and addresses come from OCR. A cell starting with = + - @ would run as a
   formula when the file is opened in Excel, so it is prefixed with ' . */
const safeCell = (v) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/** CSV text (UTF-8 BOM, CRLF, so Japanese Excel opens it directly). */
function buildCsv(rows, tzOffset) {
  return toCsv([HEADER, ...rows.map((row) => {
    const l = labels(row);
    return [
      text(row.history_id), text(row.slip_no), l.status, l.dataType, l.recipient,
      text(row.recipient_department_name), text(row.sender_content), text(row.sender_name),
      text(row.sender_address), formatTime(row.notified_at, tzOffset),
      formatTime(row.delivered_at, tzOffset), text(row.delivered_by),
    ].map(safeCell);
  })]);
}

/** history_yyyymmdd_hhmmss.csv in the caller's time zone (ASCII, for the download header). */
function fileName(now, tzOffset) {
  const l = new Date(now.getTime() - tzOffset * 60 * 1000);
  return `history_${l.getUTCFullYear()}${pad(l.getUTCMonth() + 1)}${pad(l.getUTCDate())}_`
    + `${pad(l.getUTCHours())}${pad(l.getUTCMinutes())}${pad(l.getUTCSeconds())}.csv`;
}

module.exports = { filterRows, buildCsv, fileName, tzOffsetOrDefault, HEADER };
