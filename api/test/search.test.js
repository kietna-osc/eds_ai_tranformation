/* Unit tests for the History / Employee search filters and the Employee CSV.
   Run: cd api && node --test */
const test = require('node:test');
const assert = require('node:assert/strict');
const hs = require('../src/historySearch');
const es = require('../src/employeeSearch');
const historyCsv = require('../src/historyCsv');

const query = (o) => (name) => (name in o ? o[name] : null);

/* ---------------------------------------------------------------- History parameters */

test('history: status accepts codes in any case and the screen labels', () => {
  for (const [v, want] of [['Notified', 'Notified'], ['notified', 'Notified'], ['DELIVERED', 'Delivered'],
    ['通知済み', 'Notified'], ['受取済み', 'Delivered'], ['荷物受取済み', 'Delivered']]) {
    assert.equal(hs.parseFilters(query({ status: v })).status, want, v);
  }
  assert.match(hs.parseFilters(query({ status: 'Done' })).error, /status/);
});

test('history: data_type accepts codes in any case and the screen labels', () => {
  for (const [v, want] of [['Identified', 'Identified'], ['unknown', 'Unknown'], ['受取人指定あり', 'Identified'],
    ['指定なし（不明）', 'Unknown'], ['指定なし(不明)', 'Unknown'], ['受取人不明', 'Unknown']]) {
    assert.equal(hs.parseFilters(query({ data_type: v })).dataType, want, v);
  }
  assert.match(hs.parseFilters(query({ data_type: 'x' })).error, /data_type/);
});

test('history: legacy status=Identified|Unknown means data_type', () => {
  const f = hs.parseFilters(query({ status: 'Unknown' }));
  assert.equal(f.status, null);
  assert.equal(f.dataType, 'Unknown');
});

test('history: dates parse, invalid or reversed ranges are rejected', () => {
  const f = hs.parseFilters(query({ notified_start: '2026-10-06T00:00:00.000Z', notified_end: '2026-10-13T14:59:59Z' }));
  assert.equal(f.notifiedStart.toISOString(), '2026-10-06T00:00:00.000Z');
  assert.match(hs.parseFilters(query({ notified_start: 'yesterday' })).error, /notified_start/);
  assert.match(hs.parseFilters(query({ notified_start: '2026-10-13', notified_end: '2026-10-01' })).error, /after/);
});

test('history: blank parameters are ignored', () => {
  const f = hs.parseFilters(query({ status: '', data_type: ' ', slip_no: '', recipient_name: '', search_keyword: '' }));
  assert.equal(f.status, null);
  assert.equal(f.dataType, null);
  assert.equal(hs.needsRowFilter(f), false);
});

/* ---------------------------------------------------------------- History row filters */

const H = [
  { history_id: 1, slip_no: 'AB-1001', recipient_name: '林 健太', status: 'Notified', data_type: 'Identified', notified_at: '2026-10-05T01:00:00Z', delivered_at: null },
  { history_id: 2, slip_no: 'AB-1002', recipient_name: '', status: 'Notified', data_type: 'Unknown', notified_at: '2026-10-06T01:00:00Z', delivered_at: null },
  { history_id: 3, slip_no: 'CD-2001', recipient_name: '佐藤花子', status: 'Delivered', data_type: 'Identified', notified_at: '2026-10-07T01:00:00Z', delivered_at: '2026-10-08T01:00:00Z' },
];
const ids = (rows) => rows.map((r) => r.history_id);

test('history labels follow the screen', () => {
  assert.deepEqual(hs.labels(H[0]), { recipient: '林 健太', status: '通知済み', dataType: '受取人指定あり' });
  assert.deepEqual(hs.labels(H[1]), { recipient: '不明', status: '通知済み', dataType: '指定なし（不明）' });
  assert.equal(hs.labels(H[2]).status, '受取済み');
  assert.equal(hs.labels({ data_type: 'IDENTIFIED' }).dataType, '受取人指定あり');
});

test('history: slip_no and recipient_name are contains matches (NFKC, case, spaces)', () => {
  assert.deepEqual(ids(hs.applyRowFilters(H, { slipNo: 'ab-10' })), [1, 2]);
  assert.deepEqual(ids(hs.applyRowFilters(H, { slipNo: 'ＣＤ' })), [3]);
  assert.deepEqual(ids(hs.applyRowFilters(H, { recipientName: '林健太' })), [1]);
  assert.deepEqual(ids(hs.applyRowFilters(H, { recipientName: '不明' })), [2]);
  assert.deepEqual(ids(hs.applyRowFilters(H, { slipNo: 'AB', recipientName: '林' })), [1]);
  assert.deepEqual(ids(hs.applyRowFilters(H, {})), [1, 2, 3]);
});

test('history: keyword matches new and old labels and dates', () => {
  assert.deepEqual(ids(hs.applyRowFilters(H, { keyword: '受取済み' })), [3]);
  assert.deepEqual(ids(hs.applyRowFilters(H, { keyword: '荷物受取済み' })), [3]);
  assert.deepEqual(ids(hs.applyRowFilters(H, { keyword: '指定なし' })), [2]);
  assert.deepEqual(ids(hs.applyRowFilters(H, { keyword: '受取人不明' })), [2]);
  assert.deepEqual(ids(hs.applyRowFilters(H, { keyword: '2026/10/6', tzOffset: -540 })), [2]);
  assert.deepEqual(ids(hs.filterRows(H, 'cd-2001')), [3]);
});

test('history CSV header uses 処理状態 and the new labels', () => {
  const csv = historyCsv.buildCsv(H, -540);
  assert.ok(csv.split('\r\n')[0].includes('処理状態'));
  assert.ok(csv.includes('受取済み') && csv.includes('指定なし（不明）'));
  assert.ok(!csv.includes('荷物受取済み'));
});

/* ---------------------------------------------------------------- Employees */

const E = [
  { employee_id: 'E001', full_name: '林 健太', email: 'hayashi@example.com', department_name: '第１営業本部', created_at: '2026-10-01T03:00:00Z', updated_at: '2026-10-02T03:00:00Z' },
  { employee_id: 'E002', full_name: '佐藤花子', email: 'sato@example.com', department_name: 'DX推進部', created_at: '2026-10-05T03:00:00Z', updated_at: '2026-10-05T03:00:00Z' },
  { employee_id: 'X100', full_name: '=SUM(A1)', email: 'x@example.com', department_name: '経営企画部', created_at: '2026-10-10T03:00:00Z', updated_at: null },
];
const eids = (rows) => rows.map((r) => r.employee_id);

test('employee: each field is a contains match, combined with AND', () => {
  const apply = (o) => eids(es.applyFilters(E, es.parseFilters(query(o))));
  assert.deepEqual(apply({}), ['E001', 'E002', 'X100']);
  assert.deepEqual(apply({ employee_id: 'e00' }), ['E001', 'E002']);
  assert.deepEqual(apply({ full_name: '林健太' }), ['E001']);
  assert.deepEqual(apply({ email: 'SATO' }), ['E002']);
  assert.deepEqual(apply({ department_name: '第1営業' }), ['E001']);
  assert.deepEqual(apply({ employee_id: 'E', department_name: 'DX' }), ['E002']);
  assert.deepEqual(apply({ search_keyword: '経営' }), ['X100']);
});

test('employee: search_keyword matches 社員番号 / 社員氏名 / メール / 部署, not the dates', () => {
  const apply = (kw) => eids(es.applyFilters(E, es.parseFilters(query({ search_keyword: kw }))));
  assert.deepEqual(apply('x100'), ['X100']);
  assert.deepEqual(apply('林健太'), ['E001']);
  assert.deepEqual(apply('SATO@'), ['E002']);
  assert.deepEqual(apply('ＤＸ'), ['E002']);
  assert.deepEqual(apply('10'), ['X100']); // 2026-10-.. dates are not searched
  assert.deepEqual(apply('2026/10/05'), []);
});

test('employee: search_keyword words are ANDed, each in any field', () => {
  const apply = (kw) => eids(es.applyFilters(E, es.parseFilters(query({ search_keyword: kw }))));
  assert.deepEqual(apply('林 営業'), ['E001']);
  assert.deepEqual(apply('林　第1'), ['E001']); // full-width space
  assert.deepEqual(apply('林 DX'), []);
  assert.deepEqual(apply('林 健太'), ['E001']);
});

test('employee: search_keyword results are ranked exact, prefix, contains', () => {
  const rows = [
    { employee_id: '1230', full_name: '山田', email: 'yamada@example.com', department_name: '総務部' },
    { employee_id: '51234', full_name: '鈴木', email: 'suzuki@example.com', department_name: '総務部' },
    { employee_id: '123', full_name: '高橋', email: 'takahashi@example.com', department_name: '人事部' },
    { employee_id: '9', full_name: '中村', email: 'nakamura@example.com', department_name: '123課' },
  ];
  const order = (kw) => {
    const f = es.parseFilters(query({ search_keyword: kw }));
    return eids(es.sortRows(es.applyFilters(rows, f), f));
  };
  assert.deepEqual(order('123'), ['123', '1230', '9', '51234']);
  assert.deepEqual(order('総務'), ['51234', '1230']); // same rank: newest id first
  const none = es.parseFilters(query({}));
  assert.deepEqual(eids(es.sortRows(rows, none)), ['51234', '1230', '123', '9']);
});

test('employee: 登録日時 range is inclusive, invalid dates rejected', () => {
  const apply = (o) => eids(es.applyFilters(E, es.parseFilters(query(o))));
  assert.deepEqual(apply({ created_start: '2026-10-05T03:00:00Z' }), ['E002', 'X100']);
  assert.deepEqual(apply({ created_end: '2026-10-05T03:00:00Z' }), ['E001', 'E002']);
  assert.deepEqual(apply({ created_start: '2026-10-02T00:00:00Z', created_end: '2026-10-09T00:00:00Z' }), ['E002']);
  assert.match(es.parseFilters(query({ created_end: 'nope' })).error, /created_end/);
  assert.match(es.parseFilters(query({ created_start: '2026-10-09', created_end: '2026-10-01' })).error, /after/);
});

test('employee CSV: only the 4 import columns, BOM, CRLF, formula-safe', () => {
  const csv = es.buildCsv(E);
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], '社員番号,社員氏名,メール,部署');
  assert.equal(lines[1], 'E001,林 健太,hayashi@example.com,第１営業本部');
  assert.equal(lines[3], "X100,'=SUM(A1),x@example.com,経営企画部");
  assert.equal(lines.length, 5); // header + 3 rows + trailing ''
  assert.ok(!csv.includes('2026-10'));
});

test('employee CSV can be imported again', () => {
  const { validateImport } = require('../src/employeeCsv');
  const checked = validateImport(es.buildCsv(E.slice(0, 2)));
  assert.equal(checked.valid.length, 2);
  assert.equal(checked.errors.length, 0);
});

test('employee CSV file name is in the caller time zone', () => {
  assert.equal(es.fileName(new Date('2026-10-13T01:02:03Z'), -540), 'employee_20261013_100203.csv');
});
