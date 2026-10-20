/* POST /api/employees/import: messages 50-54 of the ErrorDesign sheet (7.2.2 CSV import).
   Every response must carry the fields EDS-EmployeeImport's Parse_JSON requires, so the
   message reaches the app whatever the status code. Run: cd api && node --test */
const test = require('node:test');
const assert = require('node:assert/strict');
const { data, post } = require('./harness');

const H = '社員番号,社員氏名,メール,部署';
const row = (id) => `${id},テスト ${id},t${id}@example.com,DX推進部`;
const csv = (...lines) => `﻿${lines.join('\r\n')}\r\n`;
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const run = (text) => post('employeeImport', { csv_base64: b64(text) });
const texts = (r) => r.jsonBody.messages.map((m) => m.text);
const ids = (r) => r.jsonBody.messages.map((m) => m.id);

const MSG_50 = 'CSVファイルのアップロードに失敗しました。ファイルを確認して、しばらくしてから再度お試しください。';
const FLOW_FIELDS = ['success', 'total', 'inserted', 'updated', 'skipped', 'messages', 'errorFile'];

data.employees = [{ employee_id: 'E001' }, { employee_id: 'E002' }];

test('52: every row valid -> インポートが完了しました。{X}名…', async () => {
  const r = await run(csv(H, row('N1'), row('N2'), row('N3')));
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), [52]);
  assert.deepEqual(texts(r), ['インポートが完了しました。3名の従業員を追加しました。']);
  assert.equal(r.jsonBody.errorFile, null);
});

test('51: valid and invalid rows -> added X, skipped Y, plus the error file', async () => {
  const r = await run(csv(H, row('N1'), row('N2'), 'N3,,t@example.com,DX', 'N4,名前,,DX'));
  assert.equal(r.status, 200);
  assert.deepEqual(texts(r), ['インポートが完了しました。2名の従業員を追加しました。データエラーにより2行をスキップしました。']);
  assert.equal(r.jsonBody.skipped, 2);
  assert.match(r.jsonBody.errorFile, /^line,社員番号,社員氏名,メール,部署,error\r\n"4",/);
});

test('rows follow the app create rules: 社員番号 half-width letters/digits, メール format', async () => {
  const r = await run(csv(H, row('OK1'),
    'E-01,名前,a@example.com,DX', '社員１,名前,b@example.com,DX', 'E 02,名前,c@example.com,DX',
    'E03,名前,not-an-email,DX', 'E04,名前,d@,DX', 'E05,名前,e@example.c,DX', 'E06,名前,f g@example.com,DX',
    ',名前,,'));
  assert.equal(r.jsonBody.inserted, 1);
  assert.equal(r.jsonBody.skipped, 8);
  const errors = r.jsonBody.errorFile.split('\r\n').slice(1).map((l) => l.match(/"([^"]*)"$/)[1]);
  assert.deepEqual(errors, [
    '社員番号は半角英数字のみ使用できます',
    '社員番号は半角英数字のみ使用できます',
    '社員番号は半角英数字のみ使用できます',
    'メールアドレスの形式が正しくありません',
    'メールアドレスの形式が正しくありません',
    'メールアドレスの形式が正しくありません',
    'メールアドレスの形式が正しくありません',
    '社員番号は必須です、メールは必須です、部署は必須です',
  ]);
});

test('values the app accepts are accepted here too', async () => {
  const r = await run(csv(H, 'abc123,名前,taro.yamada+1@sub.example.co.jp,DX', 'ABC,名前,x@y.jp,DX'));
  assert.equal(r.jsonBody.inserted, 2);
  assert.equal(r.jsonBody.skipped, 0);
});

test('53: every row invalid -> インポートに失敗しました。{X}行すべて…, with the error file', async () => {
  const r = await run(csv(H, 'N1,,,', ',名前,,DX', 'N3,名前,t@example.com,'));
  assert.equal(r.status, 422);
  assert.deepEqual(texts(r), ['インポートに失敗しました。3行すべてにデータエラーがあり、従業員は追加されませんでした。']);
  assert.equal(r.jsonBody.success, false);
  assert.ok(r.jsonBody.errorFile);
});

test('54 (Update案): codes already in the DB are listed and updated', async () => {
  const r = await run(csv(H, row('E001'), row('E002'), row('N9')));
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), [52, 54]);
  assert.deepEqual(texts(r), [
    'インポートが完了しました。1名の従業員を追加しました。',
    '重複コードが2件検出されました：E001、E002。既存データは新しい情報で更新されました。',
  ]);
  assert.equal(r.jsonBody.updated, 2);
});

test('54: with skipped rows too, 51 comes first', async () => {
  const r = await run(csv(H, row('E001'), 'N3,,t@example.com,DX'));
  assert.deepEqual(ids(r), [51, 54]);
});

test('54: more than 10 codes -> the first 10, then ほかN件', async () => {
  const many = Array.from({ length: 12 }, (_, i) => `U${String(i + 1).padStart(2, '0')}`);
  const saved = data.employees;
  data.employees = many.map((employee_id) => ({ employee_id }));
  try {
    const r = await run(csv(H, ...many.map(row)));
    assert.equal(texts(r)[1],
      '重複コードが12件検出されました：U01、U02、U03、U04、U05、U06、U07、U08、U09、U10 ほか2件。既存データは新しい情報で更新されました。');
  } finally {
    data.employees = saved;
  }
});

const cases = {
  'empty file': [() => post('employeeImport', { csv_base64: '' }), 400],
  'missing column': [() => run(csv('社員番号,社員氏名,メール', 'N1,名前,t@example.com')), 400],
  'unterminated quote': [() => run(csv(H, 'N1,"名前,t@example.com,DX')), 400],
  'wrong encoding (Shift-JIS)': [() => post('employeeImport', {
    csv_base64: Buffer.from([0x8e, 0xd0, 0x88, 0xf5, 0x94, 0xd4, 0x8d, 0x86, 0x0d, 0x0a]).toString('base64'),
  }), 400],
  'header only': [() => run(csv(H)), 400],
  'too many rows': [() => run(csv(H, ...Array.from({ length: 5001 }, (_, i) => row(`R${i}`)))), 413],
  'too large': [() => run(csv(H, ...Array.from({ length: 4000 }, (_, i) => `${row(`L${i}`)}${'x'.repeat(1400)}`))), 413],
  '社員番号 twice in the file': [() => run(csv(H, row('N1'), row('N1'))), 409],
  'connection lost': [() => run(csv(H, row('DROP'))), 503],
  'unexpected DB error': [() => run(csv(H, row('BOOM'))), 500],
};
for (const [name, [send, status]] of Object.entries(cases)) {
  test(`50: ${name} -> ${status} with the shared upload message`, async () => {
    const r = await send();
    assert.equal(r.status, status);
    assert.deepEqual(ids(r), [50]);
    assert.deepEqual(texts(r), [MSG_50]);
    assert.equal(r.jsonBody.success, false);
  });
}

test('every response carries the fields the flow Parse_JSON requires', async () => {
  const responses = [
    await run(csv(H, row('N1'))),
    await run(csv(H, 'N1,,,')),
    await run(csv('社員番号', 'N1')),
    await run(csv(H, row('DROP'))),
  ];
  for (const r of responses) {
    for (const f of FLOW_FIELDS) assert.ok(f in r.jsonBody, `${r.status} lacks ${f}`);
    assert.ok(r.jsonBody.messages.every((m) => Number.isInteger(m.id) && typeof m.text === 'string' && m.text));
  }
});
