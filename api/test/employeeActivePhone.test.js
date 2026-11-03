/* Employee is_active (soft delete) and phone (22_employee_active_phone.sql):
   list order / filters, create / update / delete, and the CSV import's phone fill.
   Run: cd api && npm test */
const test = require('node:test');
const assert = require('node:assert/strict');
const { data, call, post, calls } = require('./harness');

const emp = (id, extra = {}) => ({
  employee_id: id, full_name: `社員 ${id}`, email: `${id.toLowerCase()}@example.com`,
  department_name: 'DX推進部', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...extra,
});
const reset = () => {
  data.oldDeleteProc = false;
  data.employees = [
    emp('1001', { phone: '0312345678', is_active: true }),
    emp('1002', { is_active: false }),
    emp('1003', { phone: null, is_active: true }),
    emp('1004', { is_active: false, phone: '09011112222' }),
    emp('1005'), // read before SQL 22: no is_active / phone column
  ];
};
const ids = (r) => r.jsonBody.value.map((e) => e.employee_id);
const lastCall = (proc) => calls.filter((c) => c.proc === proc).at(-1);

/* ------------------------------------------------------------------ list */

test('list: deleted employees come after the active ones, each part newest id first', async () => {
  reset();
  const r = await call('employeeList', {});
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), ['1005', '1003', '1001', '1004', '1002']);
});

test('list: phone stays text and is_active is a boolean (no column = active)', async () => {
  reset();
  const r = await call('employeeList', {});
  const byId = Object.fromEntries(r.jsonBody.value.map((e) => [e.employee_id, e]));
  assert.equal(byId['1001'].phone, '0312345678');
  assert.equal(byId['1003'].phone, null);
  assert.equal(byId['1001'].is_active, true);
  assert.equal(byId['1002'].is_active, false);
  assert.equal(byId['1005'].is_active, true);
  assert.equal(byId['1005'].phone, null);
});

test('list: is_active filter (true / false / empty) and invalid values', async () => {
  reset();
  assert.deepEqual(ids(await call('employeeList', { is_active: 'true' })), ['1005', '1003', '1001']);
  assert.deepEqual(ids(await call('employeeList', { is_active: 'false' })), ['1004', '1002']);
  assert.equal((await call('employeeList', { is_active: '' })).jsonBody.totalCount, 5);
  const bad = await call('employeeList', { is_active: '1' });
  assert.equal(bad.status, 400);
  assert.match(bad.jsonBody.error, /is_active/);
});

test('list: phone filter is a contains match', async () => {
  reset();
  assert.deepEqual(ids(await call('employeeList', { phone: '1234' })), ['1001']);
  assert.deepEqual(ids(await call('employeeList', { phone: '090' })), ['1004']);
});

test('list: search_keyword (受取人 / CC search) returns active employees only', async () => {
  reset();
  assert.deepEqual(ids(await call('employeeList', { search_keyword: '社員' })), ['1005', '1003', '1001']);
});

/* ------------------------------------------------------------------ create */

const NEW = { employee_id: '2001', full_name: '新入 太郎', department_name: '総務部', email: 'new@example.com' };

test('create: phone and is_active are optional (active, no phone by default)', async () => {
  reset();
  const r = await post('employeeInsert', NEW);
  assert.equal(r.status, 201);
  const p = lastCall('dbo.sp_employee_insert').p;
  assert.equal(p.phone, null);
  assert.equal(p.is_active, true);
  assert.equal(r.jsonBody.value.is_active, true);
});

test('create: digits-only phone and is_active false are passed on', async () => {
  reset();
  const r = await post('employeeInsert', { ...NEW, phone: ' 09012345678 ', is_active: false });
  assert.equal(r.status, 201);
  const p = lastCall('dbo.sp_employee_insert').p;
  assert.equal(p.phone, '09012345678');
  assert.equal(p.is_active, false);
});

test('create: phone with anything but half-width digits, or over 20 digits -> 400', async () => {
  reset();
  for (const phone of ['090-1234-5678', '+81312345678', '０９０１２３４', '1'.repeat(21)]) {
    const r = await post('employeeInsert', { ...NEW, phone });
    assert.equal(r.status, 400, phone);
    assert.equal(r.jsonBody.error, '電話番号は半角数字のみ（20桁以内）で入力してください');
  }
  assert.equal(calls.some((c) => c.proc === 'dbo.sp_employee_insert'), false);
});

test('create: is_active must be a JSON boolean', async () => {
  reset();
  for (const isActive of ['true', 1, 0]) {
    const r = await post('employeeInsert', { ...NEW, is_active: isActive });
    assert.equal(r.status, 400);
    assert.match(r.jsonBody.error, /true または false/);
  }
});

/* ------------------------------------------------------------------ update */

const EDIT = { full_name: '社員 1001', department_name: 'DX推進部', email: '1001@example.com' };

test('update: no phone / is_active in the body keeps both (the flow before this change)', async () => {
  reset();
  const r = await post('employeeUpdate', EDIT, { id: '1001' });
  assert.equal(r.status, 200);
  const p = lastCall('dbo.sp_employee_update').p;
  assert.equal(p.update_phone, false);
  assert.equal(p.is_active, null);
  assert.equal(r.jsonBody.value.phone, '0312345678');
  assert.equal(r.jsonBody.value.is_active, true);
});

test('update: phone "" clears it, a new phone replaces it', async () => {
  reset();
  let r = await post('employeeUpdate', { ...EDIT, phone: '' }, { id: '1001' });
  assert.equal(lastCall('dbo.sp_employee_update').p.update_phone, true);
  assert.equal(r.jsonBody.value.phone, null);
  r = await post('employeeUpdate', { ...EDIT, phone: '0398765432' }, { id: '1001' });
  assert.equal(r.jsonBody.value.phone, '0398765432');
});

test('update: is_active true restores a deleted employee, false deletes (soft)', async () => {
  reset();
  let r = await post('employeeUpdate', { ...EDIT, email: '1002@example.com', is_active: true }, { id: '1002' });
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.value.is_active, true);
  r = await post('employeeUpdate', { ...EDIT, is_active: false }, { id: '1001' });
  assert.equal(r.jsonBody.value.is_active, false);
});

test('update: invalid phone -> 400, nothing updated', async () => {
  reset();
  const r = await post('employeeUpdate', { ...EDIT, phone: '03-1234' }, { id: '1001' });
  assert.equal(r.status, 400);
  assert.equal(calls.some((c) => c.proc === 'dbo.sp_employee_update'), false);
});

/* ------------------------------------------------------------------ delete */

test('delete: an active employee is soft-deleted', async () => {
  reset();
  const r = await post('employeeDelete', undefined, { id: '1001' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.jsonBody, { deleted: 1, permanent: false });
  assert.equal(lastCall('dbo.sp_employee_delete').p.permanent, false);
});

test('delete: soft delete of an already deleted employee -> 409', async () => {
  reset();
  const r = await post('employeeDelete', undefined, { id: '1002' });
  assert.equal(r.status, 409);
  assert.equal(r.jsonBody.error, 'この従業員は既に削除済みです。一覧を更新してください。');
});

test('delete: permanent=true removes an already deleted employee', async () => {
  reset();
  const r = await post('employeeDelete', undefined, { id: '1002' }, { permanent: 'true' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.jsonBody, { deleted: 1, permanent: true });
});

test('delete: permanent=true on an active employee -> 409, never removed', async () => {
  reset();
  const r = await post('employeeDelete', undefined, { id: '1001' }, { permanent: 'true' });
  assert.equal(r.status, 409);
  assert.equal(r.jsonBody.error, '削除されていない従業員は完全に削除できません。一覧を更新してください。');
});

test('delete: unknown id -> 404 (soft and permanent); invalid permanent -> 400', async () => {
  reset();
  for (const query of [{}, { permanent: 'true' }]) {
    const r = await post('employeeDelete', undefined, { id: 'NOPE' }, query);
    assert.equal(r.status, 404);
  }
  const bad = await post('employeeDelete', undefined, { id: '1001' }, { permanent: 'yes' });
  assert.equal(bad.status, 400);
});

test('delete: the procedure before SQL 22 (no found column) still maps 0 rows to 404', async () => {
  reset();
  data.oldDeleteProc = true;
  const r = await post('employeeDelete', undefined, { id: 'NOPE' });
  assert.equal(r.status, 404);
});

/* ------------------------------------------------------------------ CSV import */

const csv = (...lines) => `﻿${lines.join('\r\n')}\r\n`;
const run = (text) => post('employeeImport', {
  csv_base64: Buffer.from(text, 'utf8').toString('base64'), file_name: 'employees.csv',
});
const lines = (r) => r.jsonBody.message.split('\n');
const upserted = () => JSON.parse(lastCall('dbo.sp_employee_upsert').p.rows);
const H5 = '社員番号,社員氏名,メール,部署,電話番号';

test('import: a file without 電話番号 imports as before', async () => {
  reset();
  const r = await run(csv('社員番号,社員氏名,メール,部署', '3001,新 一郎,s1@example.com,総務部'));
  assert.equal(r.jsonBody.status, 'success');
  assert.equal(upserted()[0].phone, '');
});

test('import: an active employee without a phone gets it filled; other columns ignored', async () => {
  reset();
  // 1003 has no phone: filled even though name / email in the file differ (they are ignored)
  const r = await run(csv(H5, '1003,別名,someone.else@example.com,別部署,0355556666', '3001,新 一郎,s1@example.com,総務部,09000001111'));
  assert.equal(r.jsonBody.status, 'success');
  assert.deepEqual(lines(r), ['インポートが完了しました。', '成功：2件']);
  assert.deepEqual(upserted().map((x) => [x.employee_id, x.phone]), [['1003', '0355556666'], ['3001', '09000001111']]);
  assert.equal('phoneFill' in upserted()[0], false);
});

test('import: an employee who already has a phone, or a row without one -> 既に登録されています', async () => {
  reset();
  const r = await run(csv(H5, '1001,社員 1001,1001@example.com,DX推進部,0399990000', '1003,社員 1003,1003@example.com,DX推進部,'));
  assert.equal(r.status, 422);
  assert.deepEqual(lines(r).slice(-2), [
    '・2行目：この社員番号は既に登録されています',
    '・3行目：この社員番号は既に登録されています',
  ]);
});

test('import: a deleted employee\'s 社員番号 -> 削除済み row error, even with a phone', async () => {
  reset();
  const r = await run(csv(H5, '1002,社員 1002,1002@example.com,DX推進部,0311112222'));
  assert.equal(r.status, 422);
  assert.equal(lines(r).at(-1), '・2行目：この社員番号は削除済みの従業員です');
});

test('import: invalid phone -> row error', async () => {
  reset();
  const r = await run(csv(H5, '3001,新 一郎,s1@example.com,総務部,03-1234-5678'));
  assert.equal(r.status, 422);
  assert.equal(lines(r).at(-1), '・2行目：電話番号は半角数字のみ（20桁以内）で入力してください');
});

test('import: 状態 (from the download) is accepted and ignored; a missing column does not ask for 電話番号', async () => {
  reset();
  let r = await run(csv(`${H5},状態`, '3001,新 一郎,s1@example.com,総務部,,削除済み'));
  assert.equal(r.jsonBody.status, 'success');
  assert.equal('is_active' in upserted()[0], false);
  r = await run(csv('社員番号,社員氏名,メール', '3002,新 二郎,s2@example.com'));
  assert.equal(r.status, 400);
  assert.match(r.jsonBody.message, /必須列がありません：部署/);
  assert.doesNotMatch(r.jsonBody.message, /電話番号/);
});
