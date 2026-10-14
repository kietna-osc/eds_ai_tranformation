/* Handler tests for historyList / historyExport / employeeList / employeeExport.
   Uses the in-memory fakes in harness.js (no npm install, no Azure, no database).
   Run: cd api && node --test */
const test = require('node:test');
const assert = require('node:assert/strict');
const { calls, stored, data, call } = require('./harness');

/* ---------------------------------------------------------------- data */

const HISTORY = Array.from({ length: 30 }, (_, i) => ({
  history_id: i + 1,
  slip_no: `SL-${String(i + 1).padStart(4, '0')}`,
  recipient_name: i % 3 === 0 ? '' : `受取人${i % 5}`,
  status: i % 4 === 0 ? 'Delivered' : 'Notified',
  data_type: i % 3 === 0 ? 'Unknown' : 'Identified',
  notified_at: new Date(Date.UTC(2026, 9, 1 + (i % 12), 1)).toISOString(),
  delivered_at: i % 4 === 0 ? new Date(Date.UTC(2026, 9, 13, 1)).toISOString() : null,
  created_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  image_url: null,
}));

const EMPLOYEES = Array.from({ length: 12 }, (_, i) => ({
  employee_id: `E${String(i + 1).padStart(3, '0')}`,
  full_name: `社員 ${i + 1}`,
  email: `user${i + 1}@example.com`,
  department_name: i < 6 ? '第１営業本部' : 'DX推進部',
  created_at: new Date(Date.UTC(2026, 9, 1 + i, 3)).toISOString(),
  updated_at: new Date(Date.UTC(2026, 9, 1 + i, 3)).toISOString(),
}));

data.history = HISTORY;
data.employees = EMPLOYEES;

/* ---------------------------------------------------------------- History */

test('historyList without filters pages in SQL', async () => {
  const r = await call('historyList', { page: '2', pageSize: '10' });
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.totalCount, 30);
  assert.equal(r.jsonBody.count, 10);
  assert.equal(calls[0].p.page, 2);
  assert.equal(calls[0].p.page_size, 10);
});

test('historyList: status / data_type / 通知日時 go to SQL', async () => {
  const r = await call('historyList', {
    status: 'Delivered', data_type: 'identified',
    notified_start: '2026-10-01T00:00:00Z', notified_end: '2026-10-31T00:00:00Z', pageSize: '50',
  });
  assert.equal(r.status, 200);
  assert.equal(calls[0].p.status, 'Delivered');
  assert.equal(calls[0].p.data_type, 'Identified');
  assert.ok(r.jsonBody.value.every((v) => v.status === 'Delivered' && v.data_type === 'Identified'));
  assert.equal(r.jsonBody.totalCount, HISTORY.filter((h) => h.status === 'Delivered' && h.data_type === 'Identified').length);
});

test('historyList: 伝票番号 and 受取人 filter all matching rows, then page', async () => {
  const r = await call('historyList', { recipient_name: '不明', page: '1', pageSize: '3' });
  const unknown = HISTORY.filter((h) => h.recipient_name === '');
  assert.equal(r.jsonBody.totalCount, unknown.length);
  assert.equal(r.jsonBody.count, 3);
  assert.equal(r.jsonBody.totalPages, Math.ceil(unknown.length / 3));
  assert.equal(calls[0].p.page_size, 100000);

  const s = await call('historyList', { slip_no: 'sl-001' });
  assert.deepEqual(s.jsonBody.value.map((v) => v.slip_no).sort(),
    ['SL-0010', 'SL-0011', 'SL-0012', 'SL-0013', 'SL-0014', 'SL-0015', 'SL-0016', 'SL-0017', 'SL-0018', 'SL-0019']);
});

test('historyList: combined panel filters (処理状態 + 受取人)', async () => {
  const r = await call('historyList', { status: '通知済み', recipient_name: '受取人1', pageSize: '200' });
  const want = HISTORY.filter((h) => h.status === 'Notified' && h.recipient_name.includes('受取人1'));
  assert.equal(r.jsonBody.totalCount, want.length);
});

test('historyList: invalid values return 400', async () => {
  assert.equal((await call('historyList', { status: 'Done' })).status, 400);
  assert.equal((await call('historyList', { notified_end: 'x' })).status, 400);
});

test('historyExport applies the same filters as the list', async () => {
  stored.length = 0;
  const q = { status: 'Notified', data_type: 'Unknown', slip_no: 'SL-00' };
  const list = await call('historyList', { ...q, pageSize: '200' });
  const r = await call('historyExport', q);
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.rowCount, list.jsonBody.totalCount);
  const lines = stored[0].text.slice(1).trim().split('\r\n');
  assert.equal(lines.length - 1, r.jsonBody.rowCount);
  assert.ok(lines.slice(1).every((l) => l.includes('通知済み') && l.includes('指定なし（不明）')));
});

/* ---------------------------------------------------------------- Employees */

test('employeeList without filters pages in SQL', async () => {
  const r = await call('employeeList', { page: '1', pageSize: '5' });
  assert.equal(r.jsonBody.totalCount, 12);
  assert.equal(r.jsonBody.count, 5);
  assert.equal(calls[0].p.page_size, 5);
});

test('employeeList: per-field filters and 登録日時 range', async () => {
  const r = await call('employeeList', { department_name: '第1営業', employee_id: 'e00', pageSize: '50' });
  assert.equal(r.jsonBody.totalCount, 6);
  const d = await call('employeeList', { created_start: '2026-10-03T00:00:00Z', created_end: '2026-10-05T23:59:59Z' });
  assert.deepEqual(d.jsonBody.value.map((v) => v.employee_id).sort(), ['E003', 'E004', 'E005']);
  assert.equal((await call('employeeList', { created_start: 'bad' })).status, 400);
});

test('employeeExport: 4 columns, same rows as the list', async () => {
  stored.length = 0;
  const r = await call('employeeExport', { department_name: 'DX', tz_offset: '-540' });
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.rowCount, 6);
  assert.match(r.jsonBody.file.fileName, /^employee_\d{8}_\d{6}\.csv$/);
  const lines = stored[0].text.slice(1).trim().split('\r\n');
  assert.equal(lines[0], '社員番号,社員氏名,メール,部署');
  assert.equal(lines.length, 7);
  assert.ok(lines.slice(1).every((l) => l.split(',').length === 4 && l.endsWith('DX推進部')));
});

test('employeeExport ignores 登録日時 (created_start / created_end)', async () => {
  stored.length = 0;
  const list = await call('employeeList', { created_start: '2026-10-03T00:00:00Z', created_end: '2026-10-05T23:59:59Z' });
  assert.equal(list.jsonBody.totalCount, 3);
  const r = await call('employeeExport', { created_start: '2026-10-03T00:00:00Z', created_end: '2026-10-05T23:59:59Z' });
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.rowCount, 12);
  // an invalid date is ignored too, not a 400
  assert.equal((await call('employeeExport', { created_start: 'bad', department_name: 'DX' })).jsonBody.rowCount, 6);
});

test('employeeExport with no filter exports everyone', async () => {
  stored.length = 0;
  const r = await call('employeeExport', {});
  assert.equal(r.jsonBody.rowCount, 12);
  assert.equal(r.jsonBody.totalCount, 12);
});
