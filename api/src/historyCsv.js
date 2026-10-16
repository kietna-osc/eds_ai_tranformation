/* History CSV download (GET /api/history/export).

   The filters are the History search (historySearch.js), so the file holds exactly
   the rows the screen shows for the same 検索条件. No filter: every row.

   Times are stored in UTC. They are written in the caller's time zone, given as
   Power Fx TimeZoneOffset() (minutes, UTC minus local: -540 for Japan), so the file
   shows the same times as the screen. */

const { toCsv } = require('./csv');
const { filterRows, applyRowFilters, labels, formatTime, tzOffsetOrDefault } = require('./historySearch');

const HEADER = ['履歴ID', '伝票番号', '処理状態', 'データ区分', '受取人', '受取部署',
  '品名', '送り主', '送り主住所', '通知日時', '受取日時'];

const text = (v) => (v === undefined || v === null ? '' : String(v));
const pad = (n) => String(n).padStart(2, '0');

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
      formatTime(row.delivered_at, tzOffset),
    ].map(safeCell);
  })]);
}

/** history_yyyymmdd_hhmmss.csv in the caller's time zone (ASCII, for the download header). */
function fileName(now, tzOffset) {
  const l = new Date(now.getTime() - tzOffset * 60 * 1000);
  return `history_${l.getUTCFullYear()}${pad(l.getUTCMonth() + 1)}${pad(l.getUTCDate())}_`
    + `${pad(l.getUTCHours())}${pad(l.getUTCMinutes())}${pad(l.getUTCSeconds())}.csv`;
}

module.exports = { filterRows, applyRowFilters, buildCsv, fileName, tzOffsetOrDefault, HEADER };
