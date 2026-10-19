/* Register logs the read: POST /api/history passes operator_name / operator_email and
   the raw ocr_* values to sp_history_insert_v2, which writes them on the ocr_history
   row only. Run: cd api && node --test */
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

const OCR = {
  ocr_receipt_name: '山田 太朗', ocr_receipt_department: 'DX推進', ocr_slip_no: 'SL-0O01',
  ocr_sender_name: '株式会社 サンプル', ocr_sender_content: '書類', ocr_sender_address: '東京都',
  ocr_model_name: 'gpt-5.5',
};

test('historyInsert passes the raw OCR values to sp_history_insert_v2', async () => {
  const r = await post('historyInsert', { ...PACKAGE, ...OCR });
  assert.equal(r.status, 201);
  assert.equal(calls[0].proc, 'dbo.sp_history_insert_v2');
  for (const [k, v] of Object.entries(OCR)) assert.equal(calls[0].p[k], v, k);
  // the confirmed values still come from the non-ocr fields
  assert.equal(calls[0].p.slip_no, 'SL-0001');
  assert.equal(calls[0].p.recipient_name, '山田 太郎');
});

test('historyInsert without OCR values (app or flow not updated yet) sends NULL', async () => {
  const blank = Object.fromEntries(Object.keys(OCR).map((k) => [k, '']));
  await post('historyInsert', { ...PACKAGE, ...blank });
  for (const k of Object.keys(OCR)) assert.equal(calls[0].p[k], null, k);
  await post('historyInsert', PACKAGE);
  for (const k of Object.keys(OCR)) assert.equal(calls[0].p[k], null, k);
});

test('OCR values are cut to the column sizes', async () => {
  await post('historyInsert', {
    ...PACKAGE, ocr_slip_no: 's'.repeat(150), ocr_sender_content: 'c'.repeat(1200),
    ocr_sender_address: 'a'.repeat(600),
  });
  assert.equal(calls[0].p.ocr_slip_no.length, 100);
  assert.equal(calls[0].p.ocr_sender_content.length, 1000);
  assert.equal(calls[0].p.ocr_sender_address.length, 500);
});

test('the old POST /api/ocr-history endpoint is gone', async () => {
  await assert.rejects(post('ocrHistoryInsert', PACKAGE));
});
