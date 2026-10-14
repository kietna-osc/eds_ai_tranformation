/* End-to-end simulation: app (Power Fx query builder) -> flow EDS-APIManagement1
   (Parse JSON + HTTP URI with @{...} expressions) -> Function handler -> fake database.

   - appHistoryContent / appEmployeeContent reproduce the msapp formulas that build
     `content` (gblHsQuery / gblEsQuery in the 検索条件 panels).
   - FLOW_URI holds the exact URIs given for the HTTP actions (docs/search-panel-filters.md);
     evalFlow() evaluates their @{...} expressions (body()?[], coalesce, encodeUriComponent)
     the way Power Automate does.
   - The scenarios are the ones reported on 2026-10-13: a date range of one day returning
     other days, データ区分 = 指定なし（不明） returning 受取人指定あり.
   Run: cd api && npm test */
const test = require('node:test');
const assert = require('node:assert/strict');
const { data, stored, call, csvLines } = require('./harness');

/* ---------------------------------------------------------------- app side (Power Fx) */

const TZ = -540; // TimeZoneOffset() in Japan
/** Local (JST) date-time -> Date. */
const jst = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, s) + TZ * 60000);
/** Text(dt, DateTimeFormat.UTC) */
const utc = (dt) => dt.toISOString();

/** gblHsQuery on desktop, wrapped as the fetch does: {"page":..,"pageSize":.. & gblHsQuery & "}" */
function appHistoryContent(p, { page = 1, pageSize = 50, list = true } = {}) {
  const m = {};
  if (list) { m.page = page; m.pageSize = pageSize; }
  if (p.slip) m.slip_no = p.slip;
  if (p.recipient) m.recipient_name = p.recipient;
  if (p.status) m.status = p.status === '受取済み' ? 'Delivered' : 'Notified';
  if (p.dtype) m.data_type = p.dtype === '受取人指定あり' ? 'Identified' : 'Unknown';
  if (p.from) m.notified_start = utc(p.from);
  if (p.to) m.notified_end = utc(new Date(p.to.getTime() + 59 * 1000)); // DateAdd(To, 59, Seconds)
  m.tz_offset = TZ;
  return JSON.stringify(m);
}

/** gblEsQuery on desktop. */
function appEmployeeContent(p, { page = 1, pageSize = 50, list = true } = {}) {
  const m = {};
  if (list) { m.page = page; m.pageSize = pageSize; }
  if (p.id) m.employee_id = p.id;
  if (p.name) m.full_name = p.name;
  if (p.mail) m.email = p.mail;
  if (p.dept) m.department_name = p.dept;
  if (p.from) m.created_start = utc(p.from);
  if (p.to) m.created_end = utc(new Date(p.to.getTime() + 59 * 1000));
  m.tz_offset = TZ;
  return JSON.stringify(m);
}

/* ---------------------------------------------------------------- flow side */

const FLOW_URI = {
  historyList: "https://apim-eds-dev.azure-api.net/eds/history?page=@{coalesce(body('Parse_list_params')?['page'], 1)}&pageSize=@{coalesce(body('Parse_list_params')?['pageSize'], body('Parse_list_params')?['page_size'], 50)}&status=@{encodeUriComponent(coalesce(body('Parse_list_params')?['status'], ''))}&data_type=@{encodeUriComponent(coalesce(body('Parse_list_params')?['data_type'], ''))}&slip_no=@{encodeUriComponent(coalesce(body('Parse_list_params')?['slip_no'], ''))}&recipient_name=@{encodeUriComponent(coalesce(body('Parse_list_params')?['recipient_name'], ''))}&notified_start=@{encodeUriComponent(coalesce(body('Parse_list_params')?['notified_start'], ''))}&notified_end=@{encodeUriComponent(coalesce(body('Parse_list_params')?['notified_end'], ''))}&search_keyword=@{encodeUriComponent(coalesce(body('Parse_list_params')?['search_keyword'], ''))}&tz_offset=@{coalesce(body('Parse_list_params')?['tz_offset'], -540)}",
  historyExport: "https://apim-eds-dev.azure-api.net/eds/history/export?status=@{encodeUriComponent(coalesce(body('Parse_export_params')?['status'], ''))}&data_type=@{encodeUriComponent(coalesce(body('Parse_export_params')?['data_type'], ''))}&slip_no=@{encodeUriComponent(coalesce(body('Parse_export_params')?['slip_no'], ''))}&recipient_name=@{encodeUriComponent(coalesce(body('Parse_export_params')?['recipient_name'], ''))}&notified_start=@{encodeUriComponent(coalesce(body('Parse_export_params')?['notified_start'], ''))}&notified_end=@{encodeUriComponent(coalesce(body('Parse_export_params')?['notified_end'], ''))}&search_keyword=@{encodeUriComponent(coalesce(body('Parse_export_params')?['search_keyword'], ''))}&tz_offset=@{coalesce(body('Parse_export_params')?['tz_offset'], -540)}",
  employeeList: "https://apim-eds-dev.azure-api.net/eds/employees?page=@{coalesce(body('Parse_list_params_1')?['page'], 1)}&pageSize=@{coalesce(body('Parse_list_params_1')?['pageSize'], body('Parse_list_params_1')?['page_size'], 50)}&employee_id=@{encodeUriComponent(coalesce(body('Parse_list_params_1')?['employee_id'], ''))}&full_name=@{encodeUriComponent(coalesce(body('Parse_list_params_1')?['full_name'], ''))}&email=@{encodeUriComponent(coalesce(body('Parse_list_params_1')?['email'], ''))}&department_name=@{encodeUriComponent(coalesce(body('Parse_list_params_1')?['department_name'], ''))}&created_start=@{encodeUriComponent(coalesce(body('Parse_list_params_1')?['created_start'], ''))}&created_end=@{encodeUriComponent(coalesce(body('Parse_list_params_1')?['created_end'], ''))}&search_keyword=@{encodeUriComponent(coalesce(body('Parse_list_params_1')?['search_keyword'], ''))}&tz_offset=@{coalesce(body('Parse_list_params_1')?['tz_offset'], -540)}",
  employeeExport: "https://apim-eds-dev.azure-api.net/eds/employees/export?employee_id=@{encodeUriComponent(coalesce(body('Parse_export_params_emp')?['employee_id'], ''))}&full_name=@{encodeUriComponent(coalesce(body('Parse_export_params_emp')?['full_name'], ''))}&email=@{encodeUriComponent(coalesce(body('Parse_export_params_emp')?['email'], ''))}&department_name=@{encodeUriComponent(coalesce(body('Parse_export_params_emp')?['department_name'], ''))}&search_keyword=@{encodeUriComponent(coalesce(body('Parse_export_params_emp')?['search_keyword'], ''))}&tz_offset=@{coalesce(body('Parse_export_params_emp')?['tz_offset'], -540)}",
};
// The Query_history URI before the panel change: forwards status and search_keyword only.
const OLD_FLOW_HISTORY_LIST = "https://apim-eds-dev.azure-api.net/eds/history?page=@{coalesce(body('Parse_list_params')?['page'], 1)}&pageSize=@{coalesce(body('Parse_list_params')?['pageSize'], 50)}&status=@{coalesce(body('Parse_list_params')?['status'], '')}&search_keyword=@{coalesce(body('Parse_list_params')?['search_keyword'], '')}&tz_offset=@{coalesce(body('Parse_list_params')?['tz_offset'], -540)}";

const PARSE = {
  historyList: 'Parse_list_params', historyExport: 'Parse_export_params',
  employeeList: 'Parse_list_params_1', employeeExport: 'Parse_export_params_emp',
};

/** Evaluates one workflow expression: coalesce, encodeUriComponent, body('X')?['k'], 'str', number. */
function evalExpr(src, bodies) {
  let i = 0;
  const ws = () => { while (/\s/.test(src[i])) i++; };
  function value() {
    ws();
    if (src[i] === "'") {
      let s = ''; i++;
      while (src[i] !== "'" || src[i + 1] === "'") { if (src[i] === "'") i++; s += src[i++]; }
      i++; return s;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { i += num[0].length; return Number(num[0]); }
    const name = /^[A-Za-z]+/.exec(src.slice(i))[0];
    i += name.length; ws();
    if (src[i] !== '(') throw new Error(`bad expr at ${i}: ${src}`);
    i++;
    const args = [];
    ws();
    while (src[i] !== ')') { args.push(value()); ws(); if (src[i] === ',') i++; ws(); }
    i++;
    let v;
    if (name === 'coalesce') v = args.find((a) => a !== null && a !== undefined) ?? null;
    else if (name === 'encodeUriComponent') v = encodeURIComponent(String(args[0]));
    else if (name === 'body') v = bodies[args[0]];
    else throw new Error(`unknown function ${name}`);
    // ?['key'] accessors
    for (;;) {
      ws();
      const m = /^\?\['([^']+)'\]/.exec(src.slice(i));
      if (!m) break;
      i += m[0].length;
      v = v == null ? null : (v[m[1]] ?? null);
    }
    return v;
  }
  const v = value();
  ws();
  if (i !== src.length) throw new Error(`trailing input in ${src}`);
  return v;
}

/** Runs a flow case: Parse JSON of `content`, then builds the HTTP URI like Power Automate. */
function runFlow(action, content, uri = FLOW_URI[action]) {
  const bodies = { [PARSE[action]]: JSON.parse(content) };
  const url = uri.replace(/@\{(.*?)\}(?=&|$)/g, (_, expr) => {
    const v = evalExpr(expr, bodies);
    return v === null || v === undefined ? '' : String(v);
  });
  return new URL(url).searchParams;
}

/** App -> flow -> API. */
const e2e = (action, content, uri) => call(action, runFlow(action, content, uri));

/* ---------------------------------------------------------------- data */

let id = 0;
const h = (notifiedJst, extra = {}) => {
  id += 1;
  return {
    history_id: id,
    slip_no: `SL-${String(id).padStart(3, '0')}`,
    recipient_name: extra.data_type === 'Unknown' ? '' : `受取人${id}`,
    status: 'Notified',
    data_type: 'Identified',
    notified_at: notifiedJst.toISOString(),
    delivered_at: null,
    created_at: notifiedJst.toISOString(),
    image_url: null,
    ...extra,
  };
};
data.history = [
  h(jst(2026, 10, 1, 9)),                                        // 1  10/01 outside the default week
  h(jst(2026, 10, 7, 23, 30), { data_type: 'Unknown' }),         // 2  10/07 late evening
  h(jst(2026, 10, 8, 0, 0)),                                     // 3  10/08 00:00 (start edge)
  h(jst(2026, 10, 8, 10), { data_type: 'Unknown' }),             // 4  10/08
  h(jst(2026, 10, 8, 23, 59, 30)),                               // 5  10/08 23:59:30 (end edge)
  h(jst(2026, 10, 9, 0, 0, 30), { data_type: 'Unknown' }),       // 6  10/09 just after midnight
  h(jst(2026, 10, 9, 14)),                                       // 7  10/09
  h(jst(2026, 10, 12, 9), { data_type: 'Unknown' }),             // 8  10/12
  h(jst(2026, 10, 12, 18), { status: 'Delivered', delivered_at: jst(2026, 10, 13, 9).toISOString() }), // 9
  h(jst(2026, 10, 13, 8), { status: 'Delivered', delivered_at: jst(2026, 10, 13, 9).toISOString(), data_type: 'Unknown' }), // 10
];
data.employees = [
  { employee_id: 'E001', full_name: '林 健太', email: 'hayashi@example.com', department_name: '第１営業本部', created_at: jst(2026, 10, 1, 9).toISOString(), updated_at: null },
  { employee_id: 'E002', full_name: '佐藤 花子', email: 'sato@example.com', department_name: '第２営業本部', created_at: jst(2026, 10, 8, 9).toISOString(), updated_at: null },
  { employee_id: 'E003', full_name: '田中 一郎', email: 'tanaka@example.com', department_name: 'DX推進部', created_at: jst(2026, 10, 12, 9).toISOString(), updated_at: null },
];

const ids = (r) => r.jsonBody.value.map((v) => v.history_id).sort((a, b) => a - b);
const day = (y, mo, d) => ({ from: jst(y, mo, d, 0, 0), to: jst(y, mo, d, 23, 59) }); // picker From 00:00, To 23:59

/* ---------------------------------------------------------------- History list */

test('e2e 通知日時 = 10/08 ～ 10/08 returns only 10/08 rows (both minute edges included)', async () => {
  const r = await e2e('historyList', appHistoryContent(day(2026, 10, 8)));
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), [3, 4, 5]);
});

test('e2e 通知日時 From only (10/08 ～ blank) returns 10/08 and later', async () => {
  const r = await e2e('historyList', appHistoryContent({ from: jst(2026, 10, 8, 0, 0) }));
  assert.deepEqual(ids(r), [3, 4, 5, 6, 7, 8, 9, 10]);
});

test('e2e データ区分 = 指定なし（不明） returns Unknown rows only', async () => {
  const r = await e2e('historyList', appHistoryContent({ dtype: '指定なし（不明）' }));
  assert.deepEqual(ids(r), [2, 4, 6, 8, 10]);
  assert.ok(r.jsonBody.value.every((v) => v.data_type === 'Unknown'));
});

test('e2e データ区分 = 受取人指定あり returns Identified rows only', async () => {
  const r = await e2e('historyList', appHistoryContent({ dtype: '受取人指定あり' }));
  assert.deepEqual(ids(r), [1, 3, 5, 7, 9]);
});

test('e2e 処理状態 = 受取済み / 通知済み', async () => {
  assert.deepEqual(ids(await e2e('historyList', appHistoryContent({ status: '受取済み' }))), [9, 10]);
  assert.deepEqual(ids(await e2e('historyList', appHistoryContent({ status: '通知済み' }))), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('e2e screen default / クリア (通知済み, today-7 00:00 ～ today 23:59, today = 10/13)', async () => {
  const r = await e2e('historyList', appHistoryContent({
    status: '通知済み', from: jst(2026, 10, 6, 0, 0), to: jst(2026, 10, 13, 23, 59),
  }));
  assert.deepEqual(ids(r), [2, 3, 4, 5, 6, 7, 8]);
});

test('e2e all conditions combined: 10/08-10/12, 指定なし（不明）, 通知済み, 受取人 = 不明', async () => {
  const r = await e2e('historyList', appHistoryContent({
    from: jst(2026, 10, 8), to: jst(2026, 10, 12, 23, 59), dtype: '指定なし（不明）', status: '通知済み', recipient: '不明',
  }));
  assert.deepEqual(ids(r), [4, 6, 8]);
});

test('e2e 伝票番号 (contains, full-width) and paging keep the filter', async () => {
  const p1 = await e2e('historyList', appHistoryContent({ slip: 'ＳＬ-00' }, { page: 1, pageSize: 4 }));
  assert.equal(p1.jsonBody.totalCount, 9); // SL-001..SL-009
  assert.equal(p1.jsonBody.count, 4);
  const p3 = await e2e('historyList', appHistoryContent({ slip: 'ＳＬ-00' }, { page: 3, pageSize: 4 }));
  assert.equal(p3.jsonBody.count, 1);
});

test('e2e Japanese / special characters survive encodeUriComponent', async () => {
  const r = await e2e('historyList', appHistoryContent({ recipient: '受取人4 & x' }));
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.totalCount, 0);
  const ok = await e2e('historyList', appHistoryContent({ recipient: '受取人７' }));
  assert.deepEqual(ids(ok), [7]);
});

/* ---------------------------------------------------------------- History export */

test('e2e ダウンロード uses the same conditions as the list', async () => {
  stored.length = 0;
  const cond = { ...day(2026, 10, 8), dtype: '指定なし（不明）' };
  const list = await e2e('historyList', appHistoryContent(cond));
  const r = await e2e('historyExport', appHistoryContent(cond, { list: false }));
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.rowCount, list.jsonBody.totalCount);
  const lines = csvLines(stored[0].text);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('指定なし（不明）') && lines[0].includes('2026/10/08 10:00'));
});

/* ---------------------------------------------------------------- what the reported symptoms come from */

test('cause check: an old app that sends only search_keyword ignores 通知日時 and データ区分', async () => {
  // The panel before the wiring sent {"page":1,"pageSize":50,"search_keyword":<伝票番号>,"tz_offset":-540}
  const r = await e2e('historyList', JSON.stringify({ page: 1, pageSize: 50, tz_offset: TZ }));
  assert.equal(r.jsonBody.totalCount, 10); // 10/09 and 10/12 included although 10/08 was picked
});

test('cause check: the old Query_history URI (status + search_keyword only) ignores the new conditions', async () => {
  const content = appHistoryContent({ ...day(2026, 10, 8), dtype: '指定なし（不明）' });
  const r = await e2e('historyList', content, OLD_FLOW_HISTORY_LIST);
  assert.equal(r.jsonBody.totalCount, 10);
  assert.ok(ids(r).includes(7) && ids(r).includes(8)); // 10/09 and 10/12, Identified rows too
});

/* ---------------------------------------------------------------- Employees */

test('e2e Employee list: 部署 contains + 登録日時 range', async () => {
  const r = await e2e('employeeList', appEmployeeContent({ dept: '営業', from: jst(2026, 10, 8), to: jst(2026, 10, 8, 23, 59) }));
  assert.deepEqual(r.jsonBody.value.map((v) => v.employee_id), ['E002']);
});

test('e2e Employee ダウンロード: 4 columns, 登録日時 ignored', async () => {
  stored.length = 0;
  const r = await e2e('employeeExport', appEmployeeContent({ dept: '営業', from: jst(2026, 10, 8), to: jst(2026, 10, 8, 23, 59) }, { list: false }));
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.rowCount, 2); // E001 + E002: the date range is ignored
  const text = stored[0].text.replace(/^﻿/, '');
  assert.equal(text.split('\r\n')[0], '社員番号,社員氏名,メール,部署');
  assert.ok(!/2026/.test(text));
});
