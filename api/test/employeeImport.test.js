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
const FLOW_FIELDS = ['success', 'total', 'inserted', 'updated', 'skipped', 'messages', 'errorFile', 'errorFileName', 'errorFileUrl'];
const ERROR_HEADER = '\uFEFF行番号,社員番号,社員氏名,メール,部署,エラー内容';
// Error file rows as [行番号, ..., エラー内容] (the harness parses the CSV back).
const { parseCsv } = require('../src/csv');
const errorRows = (r) => parseCsv(r.jsonBody.errorFile).slice(1);

data.employees = [{ employee_id: 'E001' }, { employee_id: 'E002' }];

test('52: every row valid -> インポートが完了しました。{X}名…', async () => {
  const r = await run(csv(H, row('N1'), row('N2'), row('N3')));
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), [52]);
  assert.deepEqual(texts(r), ['インポートが完了しました。3名の従業員を追加しました。']);
  assert.equal(r.jsonBody.errorFile, null);
  assert.equal(r.jsonBody.errorFileUrl, null);
});

test('51: added X, skipped Y, each skipped row with its line and cause, plus the error file link', async () => {
  const r = await run(csv(H, row('N1'), row('N2'), 'N3,,t@example.com,DX', 'N4,名前,,DX'));
  assert.equal(r.status, 200);
  assert.deepEqual(texts(r), [[
    'インポートが完了しました。2名の従業員を追加しました。データエラーにより2行をスキップしました。',
    '・4行目：社員氏名は必須です',
    '・5行目：メールは必須です',
  ].join('\n')]);
  assert.equal(r.jsonBody.skipped, 2);
  assert.ok(r.jsonBody.errorFile.startsWith(`${ERROR_HEADER}\r\n4,N3,,t@example.com,DX,社員氏名は必須です\r\n`));
  assert.match(r.jsonBody.errorFileName, /^employee_import_errors_\d{8}\d{6}\.csv$/);
  assert.equal(r.jsonBody.errorFileUrl, `https://blob/${r.jsonBody.errorFileName}`);
});

test('51: more than 5 skipped rows -> the first 5, then ほかN行; the file has them all', async () => {
  const bad = Array.from({ length: 7 }, (_, i) => `B${i},名前,bad,DX`);
  const r = await run(csv(H, row('N1'), ...bad));
  const lines = texts(r)[0].split('\n');
  assert.equal(lines.length, 1 + 5 + 1);
  assert.equal(lines[1], '・3行目：メールアドレスの形式が正しくありません');
  assert.equal(lines[6], 'ほか2行（すべての行はエラー詳細ファイルをご確認ください）');
  assert.equal(errorRows(r).length, 7);
});

test('line numbers are the file lines (blank lines counted), as Excel shows them', async () => {
  const r = await run(`${H}\r\n\r\n${row('N1')}\r\n\r\n\r\nN2,,x@example.com,DX\r\n`);
  assert.deepEqual(errorRows(r).map((e) => e[0]), ['6']);
  assert.match(texts(r)[0], /・6行目：社員氏名は必須です/);
});

test('社員番号 twice in the file -> those rows are skipped naming each other, the rest is imported', async () => {
  const r = await run(csv(H, row('N1'), row('N2'), row('N1')));
  assert.equal(r.status, 200);
  assert.deepEqual(ids(r), [51]);
  assert.equal(r.jsonBody.inserted, 1);
  assert.deepEqual(errorRows(r).map((e) => [e[0], e[5]]), [
    ['2', '社員番号がファイル内で重複しています（2行目、4行目）'],
    ['4', '社員番号がファイル内で重複しています（2行目、4行目）'],
  ]);
});

test('rows follow the app create rules: 社員番号 half-width letters/digits, メール format', async () => {
  const r = await run(csv(H, row('OK1'),
    'E-01,名前,a@example.com,DX', '社員１,名前,b@example.com,DX', 'E 02,名前,c@example.com,DX',
    'E03,名前,not-an-email,DX', 'E04,名前,d@,DX', 'E05,名前,e@example.c,DX', 'E06,名前,f g@example.com,DX',
    ',名前,,'));
  assert.equal(r.jsonBody.inserted, 1);
  assert.equal(r.jsonBody.skipped, 8);
  const errors = errorRows(r).map((e) => e[5]);
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
  assert.deepEqual(texts(r), [[
    'インポートに失敗しました。3行すべてにデータエラーがあり、従業員は追加されませんでした。',
    '・2行目：社員氏名は必須です、メールは必須です、部署は必須です',
    '・3行目：社員番号は必須です、メールは必須です',
    '・4行目：部署は必須です',
  ].join('\n')]);
  assert.equal(r.jsonBody.success, false);
  assert.equal(errorRows(r).length, 3);
  assert.ok(r.jsonBody.errorFileUrl);
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

// [send, status, cause shown under message 50 (null = unknown, message 50 alone)]
const cases = {
  'empty file': [() => post('employeeImport', { csv_base64: '' }), 400, 'ファイルが空です'],
  'missing column': [() => run(csv('社員番号,社員氏名,メール', 'N1,名前,t@example.com')), 400, '必須列がありません：部署'],
  'two missing columns': [() => run(csv('社員番号,社員氏名', 'N1,名前')), 400, '必須列がありません：メール、部署'],
  'unterminated quote': [() => run(csv(H, 'N1,"名前,t@example.com,DX')), 400, 'CSVの形式が正しくありません（閉じられていない「"」があります）'],
  'wrong encoding (Shift-JIS)': [() => post('employeeImport', {
    csv_base64: Buffer.from([0x8e, 0xd0, 0x88, 0xf5, 0x94, 0xd4, 0x8d, 0x86, 0x0d, 0x0a]).toString('base64'),
  }), 400, '文字コードがUTF-8ではありません（CSV UTF-8形式で保存してください）'],
  'header only': [() => run(csv(H)), 400, 'ヘッダー行のみで、データ行がありません'],
  'too many rows': [() => run(csv(H, ...Array.from({ length: 5001 }, (_, i) => row(`R${i}`)))), 413, 'データ行数が上限（5,000行）を超えています（5,001行）'],
  'too large': [() => run(csv(H, ...Array.from({ length: 4000 }, (_, i) => `${row(`L${i}`)}${'x'.repeat(1400)}`))), 413, 'ファイルサイズが上限（5MB）を超えています'],
  'connection lost': [() => run(csv(H, row('DROP'))), 503, null],
  'unexpected DB error': [() => run(csv(H, row('BOOM'))), 500, null],
};
for (const [name, [send, status, cause]] of Object.entries(cases)) {
  test(`50: ${name} -> ${status} with the shared upload message${cause ? ' and its cause' : ''}`, async () => {
    const r = await send();
    assert.equal(r.status, status);
    assert.deepEqual(ids(r), [50]);
    assert.deepEqual(texts(r), [cause ? `${MSG_50}\n原因：${cause}` : MSG_50]);
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
