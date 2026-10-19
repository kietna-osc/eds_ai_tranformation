/* employeeUpdate / employeeDelete responses. The flow passes "error" straight to the
   app popup, so every error text is Japanese. Run: cd api && node --test */
const test = require('node:test');
const assert = require('node:assert/strict');
const { calls, data, post } = require('./harness');

data.employees = [{
  employee_id: 'E001', full_name: '三浦 大輔', email: 'd-miura@example.co.jp', department_name: 'DX推進部',
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
}, {
  employee_id: 'E002', full_name: '山田 太郎', email: 'taro@example.co.jp', department_name: 'DX推進部',
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
}];

const BODY = { full_name: '三浦 大輔', email: 'd-miura@example.co.jp', department_name: '第１営業本部' };
const NOT_FOUND = '指定された社員IDの従業員が見つかりません。一覧を更新してください。';

test('employeeUpdate: updates the row named in the route', async () => {
  const r = await post('employeeUpdate', BODY, { id: 'E001' });
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.value.department_name, '第１営業本部');
});

test('employeeUpdate: unknown id -> 404 with a Japanese error', async () => {
  // e.g. edited in one tab after another tab deleted the employee (its email is gone too)
  const r = await post('employeeUpdate', { ...BODY, email: 'deleted@example.co.jp' }, { id: 'NOPE' });
  assert.equal(r.status, 404);
  assert.equal(r.jsonBody.error, NOT_FOUND);
});

test('employeeUpdate: missing field -> 400 in Japanese', async () => {
  const r = await post('employeeUpdate', { ...BODY, email: '' }, { id: 'E001' });
  assert.equal(r.status, 400);
  assert.equal(r.jsonBody.error, 'メールが指定されていません');
});

test('employeeDelete: unknown id -> 404 with a Japanese error', async () => {
  const r = await post('employeeDelete', undefined, { id: 'NOPE' });
  assert.equal(r.status, 404);
  assert.equal(r.jsonBody.error, NOT_FOUND);
});

test('employeeDelete: still referenced (547) -> 409 in Japanese', async () => {
  const r = await post('employeeDelete', undefined, { id: 'IN_USE' });
  assert.equal(r.status, 409);
  assert.equal(r.jsonBody.error, 'この従業員は履歴データで使用されているため削除できません');
});

test('unexpected failure -> 500 in Japanese with the requestId', async () => {
  const r = await post('employeeDelete', undefined, { id: 'BOOM' });
  assert.equal(r.status, 500);
  assert.match(r.jsonBody.error, /^サーバーでエラーが発生しました/);
  assert.ok('requestId' in r.jsonBody);
});

test('employeeUpdate: email used by another employee -> 409, nothing updated', async () => {
  const r = await post('employeeUpdate', { ...BODY, email: ' Taro@Example.co.jp ' }, { id: 'E001' });
  assert.equal(r.status, 409);
  assert.equal(r.jsonBody.error, 'このメールアドレスは既に他の従業員に使用されている');
  assert.ok(!calls.some((c) => c.proc === 'dbo.sp_employee_update'));
});

test('employeeUpdate: keeping its own email is not a duplicate', async () => {
  const r = await post('employeeUpdate', { ...BODY, email: 'D-Miura@example.co.jp' }, { id: 'E001' });
  assert.equal(r.status, 200);
  assert.ok(calls.some((c) => c.proc === 'dbo.sp_employee_update'));
});
