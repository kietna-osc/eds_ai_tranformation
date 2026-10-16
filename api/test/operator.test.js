/* Register stores who pressed it: POST /api/history and POST /api/ocr-history pass
   operator_name / operator_email to the procedures (sp_history_insert_v2 writes them on
   the ocr_history row). Run: cd api && node --test */
const test = require('node:test');
const assert = require('node:assert/strict');
const { calls, post } = require('./harness');

const PACKAGE = {
  slip_no: 'SL-0001', image_url: 'https://blob/a.jpg', employee_id: 'E001',
  recipient_name: '山田 太郎', recipient_department_name: 'DX推進部',
  status: 'Notified', data_type: 'Identified', notified_at: '2026-10-16T01:00:00Z',
};

test('historyInsert passes the operator to sp_history_insert_v2', async () => {
  const r = await post('historyInsert', {
    ...PACKAGE, operator_name: '受付 花子', operator_email: 'hanako@example.com',
  });
  assert.equal(r.status, 201);
  assert.equal(r.jsonBody.history_id, 101);
  assert.equal(calls[0].proc, 'dbo.sp_history_insert_v2');
  assert.equal(calls[0].p.operator_name, '受付 花子');
  assert.equal(calls[0].p.operator_email, 'hanako@example.com');
});

test('historyInsert without an operator (flow not updated yet) sends NULL', async () => {
  const r = await post('historyInsert', { ...PACKAGE, operator_name: '', operator_email: '' });
  assert.equal(r.status, 201);
  assert.equal(calls[0].p.operator_name, null);
  assert.equal(calls[0].p.operator_email, null);
  await post('historyInsert', PACKAGE);
  assert.equal(calls[0].p.operator_name, null);
  assert.equal(calls[0].p.operator_email, null);
});

test('operator values are cut to the column sizes', async () => {
  await post('historyInsert', { ...PACKAGE, operator_name: 'n'.repeat(250), operator_email: 'e'.repeat(400) });
  assert.equal(calls[0].p.operator_name.length, 200);
  assert.equal(calls[0].p.operator_email.length, 320);
});

test('ocrHistoryInsert passes the operator to sp_ocr_history_insert', async () => {
  const r = await post('ocrHistoryInsert', {
    ...PACKAGE, operator_name: '受付 花子', operator_email: 'hanako@example.com',
  });
  assert.equal(r.status, 201);
  assert.equal(calls[0].proc, 'dbo.sp_ocr_history_insert');
  assert.equal(calls[0].p.operator_name, '受付 花子');
  assert.equal(calls[0].p.operator_email, 'hanako@example.com');
  assert.equal('delivered_by' in calls[0].p, false);
});
