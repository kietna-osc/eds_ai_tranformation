/* POST /api/employees/import: the cases of the ErrorDesign sheet (7.2.2 CSV import, ids 50-56).
   The app shows status / title / message as they are, so these tests pin the exact texts.
   Run: cd api && npm test */
const test = require('node:test');
const assert = require('node:assert/strict');
const { data, post, stored } = require('./harness');
const { parseCsv } = require('../src/csv');

const H = '社員番号,社員氏名,メール,部署';
const row = (id) => `${id},テスト ${id},t${id}@example.com,DX推進部`;
const csv = (...lines) => `﻿${lines.join('\r\n')}\r\n`;
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const run = (text, extra = {}) => post('employeeImport', { csv_base64: b64(text), file_name: 'employees.csv', ...extra });
const ids = (r) => r.jsonBody.messages.map((m) => m.id);
const lines = (r) => r.jsonBody.message.split('\n');

const SHAPE = ['status', 'title', 'message', 'error', 'errorFile', 'summary', 'messages'];
const T50 = ['CSVファイルを読み込めませんでした。', 'CSV UTF-8形式で保存し直してから再度お試しください。'];
const T55 = ['CSVファイルのサイズが上限を超えています。', 'ファイルを分割するか、行数を減らして再度お試しください。'];
const T56 = ['接続切断によりインポート処理が中断されました。', 'データ整合性を保つため、データは保存されていません。', 'ファイル全体を再度インポートしてください。'];

data.employees = [{ employee_id: 'E001' }, { employee_id: 'E002' }];

test('52: every row valid -> success, インポートが完了しました。成功：N件', async () => {
  const r = await run(csv(H, row('N1'), row('N2'), row('N3')));
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.status, 'success');
  assert.equal(r.jsonBody.title, 'インポート完了');
  assert.deepEqual(ids(r), [52]);
  assert.deepEqual(lines(r), ['インポートが完了しました。', '成功：3件']);
  assert.equal(r.jsonBody.error, null);
  assert.equal(r.jsonBody.errorFile, null);
  assert.deepEqual(r.jsonBody.summary, { total: 3, inserted: 3, updated: 0, skipped: 0 });
});

test('Update案: codes already in the DB are updated and counted in 成功 (added / updated), no code list', async () => {
  const r = await run(csv(H, row('E001'), row('E002'), row('N9')));
  assert.equal(r.jsonBody.status, 'success');
  assert.deepEqual(ids(r), [52]);
  assert.deepEqual(lines(r), ['インポートが完了しました。', '成功：3件（新規追加：1件、更新：2件）']);
  assert.equal(r.jsonBody.summary.updated, 2);
});

test('Update案: every row already in the DB -> 成功：N件（新規追加：0件、更新：N件）, not 0件', async () => {
  const r = await run(csv(H, row('E001'), row('E002')));
  assert.deepEqual(lines(r), ['インポートが完了しました。', '成功：2件（新規追加：0件、更新：2件）']);
});

test('51: up to 5 error rows -> partial, each row with its line and cause in the message, no file', async () => {
  const r = await run(csv(H, row('N1'), row('N2'), 'N3,,t@example.com,DX', ',名前,bad,'));
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.status, 'partial');
  assert.equal(r.jsonBody.title, 'インポート完了（一部エラーあり）');
  assert.deepEqual(lines(r), [
    'インポートが完了しました。', '成功：2件', '失敗：2件',
    'エラー内容：',
    '・4行目：社員氏名は必須です',
    '・5行目：社員番号は必須です、メールアドレスの形式が正しくありません、部署は必須です',
  ]);
  assert.equal(r.jsonBody.errorFile, null);
  assert.equal(r.jsonBody.error.code, 51);
  assert.equal(r.jsonBody.error.rowCount, 2);
  assert.deepEqual(r.jsonBody.error.rows[1], {
    line: 5,
    employee_id: '',
    errors: [
      { column: '社員番号', value: '', message: '社員番号は必須です' },
      { column: 'メール', value: 'bad', message: 'メールアドレスの形式が正しくありません' },
      { column: '部署', value: '', message: '部署は必須です' },
    ],
  });
});

test('51 with updated codes: 成功 split into added / updated, then 失敗 and the rows', async () => {
  const r = await run(csv(H, row('E001'), 'N3,,t@example.com,DX'));
  assert.deepEqual(ids(r), [51]);
  assert.deepEqual(lines(r), [
    'インポートが完了しました。', '成功：1件（新規追加：0件、更新：1件）', '失敗：1件',
    'エラー内容：', '・3行目：社員氏名は必須です',
  ]);
});

test('51: exactly 5 error rows -> still listed in the message, no file', async () => {
  const bad = Array.from({ length: 5 }, (_, i) => `B${i},名前,bad,DX`);
  const r = await run(csv(H, row('N1'), ...bad));
  assert.equal(r.jsonBody.errorFile, null);
  assert.deepEqual(lines(r).slice(2), [
    '失敗：5件', 'エラー内容：', ...[3, 4, 5, 6, 7].map((n) => `・${n}行目：メールアドレスの形式が正しくありません`),
  ]);
});

test('51: more than 5 error rows -> the error file (one line per cell), the message says 確認 downloads it', async () => {
  const bad = Array.from({ length: 6 }, (_, i) => `B${i},,bad,DX`);
  const r = await run(csv(H, row('N1'), ...bad));
  assert.equal(r.jsonBody.status, 'partial');
  assert.deepEqual(lines(r), [
    'インポートが完了しました。', '成功：1件', '失敗：6件',
    'エラー詳細はダウンロードされるファイル（CSV）をご確認ください。',
  ]);
  assert.match(r.jsonBody.errorFile.fileName, /^employee_import_errors_\d{14}\.csv$/);
  assert.equal(r.jsonBody.errorFile.url, `https://blob/${r.jsonBody.errorFile.fileName}`);
  assert.deepEqual(r.jsonBody.error.rows, []);
  assert.equal(r.jsonBody.error.rowCount, 6);
  const file = parseCsv(stored.at(-1).text);
  assert.deepEqual(file[0], ['行番号', '社員番号', '列名', '入力値', 'エラー内容']);
  assert.deepEqual(file.slice(1, 3), [
    ['3', 'B0', '社員氏名', '', '社員氏名は必須です'],
    ['3', 'B0', 'メール', 'bad', 'メールアドレスの形式が正しくありません'],
  ]);
  assert.equal(file.length, 1 + 12);
});

test('error file not stored -> the message lists the first 5 rows and ほかN件', async () => {
  const bad = Array.from({ length: 7 }, (_, i) => `B${i},名前,bad,DX`);
  data.failExport = true;
  try {
    const r = await run(csv(H, row('N1'), ...bad));
    assert.equal(r.jsonBody.errorFile, null);
    assert.deepEqual(lines(r).slice(3), [
      'エラー内容：',
      ...[3, 4, 5, 6, 7].map((n) => `・${n}行目：メールアドレスの形式が正しくありません`),
      'ほか2件',
    ]);
  } finally {
    data.failExport = false;
  }
});

test('53: every row invalid -> 422 error, インポートエラー, 失敗：N件, with the rows', async () => {
  const r = await run(csv(H, 'N1,,,', ',名前,,DX', 'N3,名前,t@example.com,'));
  assert.equal(r.status, 422);
  assert.equal(r.jsonBody.status, 'error');
  assert.equal(r.jsonBody.title, 'インポートエラー');
  assert.deepEqual(lines(r), [
    'インポートに失敗しました。', '失敗：3件（すべての行にデータエラーがあり、登録されませんでした）',
    'エラー内容：',
    '・2行目：社員氏名は必須です、メールは必須です、部署は必須です',
    '・3行目：社員番号は必須です、メールは必須です',
    '・4行目：部署は必須です',
  ]);
  assert.equal(r.jsonBody.error.code, 53);
});

test('rows follow the app create rules: 社員番号 half-width letters/digits, メール format', async () => {
  const r = await run(csv(H, row('OK1'),
    'E-01,名前,a@example.com,DX', '社員１,名前,b@example.com,DX', 'E03,名前,not-an-email,DX', 'E04,名前,d@,DX',
    'E05,名前,e@example.c,DX', `${'A'.repeat(51)},名前,f@example.com,DX`));
  assert.equal(r.jsonBody.summary.inserted, 1);
  const file = parseCsv(stored.at(-1).text).slice(1);
  assert.deepEqual(file.map((f) => f[4]), [
    '社員番号は半角英数字のみ使用できます',
    '社員番号は半角英数字のみ使用できます',
    'メールアドレスの形式が正しくありません',
    'メールアドレスの形式が正しくありません',
    'メールアドレスの形式が正しくありません',
    '社員番号は50文字以内で入力してください',
  ]);
});

test('line numbers are the file lines (blank lines counted), as Excel shows them', async () => {
  const r = await run(`${H}\r\n\r\n${row('N1')}\r\n\r\n\r\nN2,,x@example.com,DX\r\n`);
  assert.equal(r.jsonBody.error.rows[0].line, 6);
  assert.equal(lines(r).at(-1), '・6行目：社員氏名は必須です');
});

test('社員番号 twice in the file -> those rows are skipped naming each other, the rest is imported', async () => {
  const r = await run(csv(H, row('N1'), row('N2'), row('N1')));
  assert.equal(r.jsonBody.status, 'partial');
  assert.equal(r.jsonBody.summary.inserted, 1);
  assert.deepEqual(lines(r).slice(-2), [
    '・2行目：社員番号がファイル内で重複しています（2行目、4行目）',
    '・4行目：社員番号がファイル内で重複しています（2行目、4行目）',
  ]);
});

test('社員番号 differing only in case is the same id (DB collation) -> both rows skipped', async () => {
  const r = await run(csv(H, row('N1'), 'abc1,名前,a1@example.com,DX', 'ABC1,名前,a2@example.com,DX'));
  assert.equal(r.jsonBody.summary.inserted, 1);
  assert.deepEqual(lines(r).slice(-2), [
    '・3行目：社員番号がファイル内で重複しています（3行目、4行目）',
    '・4行目：社員番号がファイル内で重複しています（3行目、4行目）',
  ]);
});

test('47 email: twice in the file, or used by another employee in the DB -> row errors', async () => {
  const saved = data.employees;
  data.employees = [{ employee_id: 'E001', email: 'taken@example.com' }, { employee_id: 'E002', email: 'move@example.com' }];
  try {
    const r = await run(csv(H,
      'N1,名前,same@example.com,DX', 'N2,名前,SAME@example.com,DX',   // twice in the file (case-insensitive)
      'N3,名前,Taken@example.com,DX',                                 // E001 has it
      'E002,名前,new@example.com,DX', 'N4,名前,move@example.com,DX', // E002 gives its email to N4 in the same file
      'N5,名前,ok@example.com,DX'));
    assert.equal(r.jsonBody.status, 'partial');
    assert.deepEqual(lines(r).slice(-3), [
      '・2行目：メールアドレスがファイル内で重複しています（2行目、3行目）',
      '・3行目：メールアドレスがファイル内で重複しています（2行目、3行目）',
      '・4行目：このメールアドレスは既に他の従業員に使用されています（社員番号：E001）',
    ]);
    assert.deepEqual(r.jsonBody.summary, { total: 6, inserted: 2, updated: 1, skipped: 3 });
  } finally {
    data.employees = saved;
  }
});

// [send, HTTP status, ErrorDesign code, sheet text, cause]
const failures = {
  'not a .csv file': [() => run(csv(H, row('N1')), { file_name: 'employees.xlsx' }), 400, 50, T50, 'CSVファイル（.csv）ではありません（employees.xlsx）'],
  'empty file': [() => post('employeeImport', { csv_base64: '' }), 400, 50, T50, 'ファイルが空です'],
  'missing column': [() => run(csv('社員番号,社員氏名,メール', 'N1,名前,t@example.com')), 400, 50, T50, '必須列がありません：部署'],
  'two missing columns': [() => run(csv('社員番号,社員氏名', 'N1,名前')), 400, 50, T50, '必須列がありません：メール、部署'],
  'unterminated quote': [() => run(csv(H, 'N1,"名前,t@example.com,DX')), 400, 50, T50, 'CSVの形式が正しくありません（閉じられていない「"」があります）'],
  'Shift-JIS file': [() => post('employeeImport', {
    csv_base64: Buffer.from([0x8e, 0xd0, 0x88, 0xf5, 0x94, 0xd4, 0x8d, 0x86, 0x0d, 0x0a]).toString('base64'),
  }), 400, 50, T50, '文字コードがUTF-8ではありません'],
  'header only': [() => run(csv(H)), 400, 50, T50, 'ヘッダー行のみで、データ行がありません'],
  'too many rows': [() => run(csv(H, ...Array.from({ length: 5001 }, (_, i) => row(`R${i}`)))), 413, 55, T55, 'データ行数 5,001行（上限 5,000行）'],
  'too large': [() => run(csv(H, ...Array.from({ length: 4000 }, (_, i) => `${row(`L${i}`)}${'x'.repeat(1400)}`))), 413, 55, T55, /^ファイルサイズ 5\.\dMB（上限 5MB）$/],
  'connection lost': [() => run(csv(H, row('DROP'))), 503, 56, T56, null],
};
for (const [name, [send, http, code, text, cause]] of Object.entries(failures)) {
  test(`${code}: ${name} -> ${http}, status error, sheet text${cause ? ' + 原因' : ''}`, async () => {
    const r = await send();
    assert.equal(r.status, http);
    assert.equal(r.jsonBody.status, 'error');
    assert.equal(r.jsonBody.title, 'インポートエラー');
    assert.deepEqual(ids(r), [code]);
    const got = lines(r);
    assert.deepEqual(got.slice(0, text.length), text);
    if (cause instanceof RegExp) assert.match(got[text.length].replace(/^原因：/, ''), cause);
    else if (cause) assert.equal(got[text.length], `原因：${cause}`);
    else assert.equal(got.length, text.length);
    assert.equal(r.jsonBody.error.code, code);
  });
}

// The shapes a flow body can send instead of the trigger's contentBytes (all imported the same).
const uploadForms = {
  'data URI': (b) => `data:text/csv;base64,${b.toString('base64')}`,
  'file object': (b) => ({ name: 'employees.csv', contentBytes: b.toString('base64') }),
  'file object as JSON text': (b) => JSON.stringify({ name: 'employees.csv', contentBytes: b.toString('base64') }),
  '$content object': (b) => ({ '$content-type': 'text/csv', $content: b.toString('base64') }),
  'CSV text': (b) => b.toString('utf8'),
  'base64 with line breaks': (b) => b.toString('base64').replace(/(.{40})/g, '$1\r\n'),
};
for (const [name, wrap] of Object.entries(uploadForms)) {
  test(`csv_base64 as ${name} -> read like contentBytes (not 文字コード)`, async () => {
    const buf = Buffer.from(csv(H, row('N1'), 'N2,,x@example.com,DX'), 'utf8');
    const r = await post('employeeImport', { csv_base64: wrap(buf), file_name: 'employees.csv' });
    assert.equal(r.status, 200);
    assert.deepEqual(ids(r), [51]);
    assert.equal(lines(r).at(-1), '・3行目：社員氏名は必須です');
  });
}

test('a real Shift-JIS file sent as base64 is still 50 文字コード', async () => {
  const r = await post('employeeImport', { csv_base64: Buffer.from([0x8e, 0xd0, 0x88, 0xf5, 0x2c, 0x0d, 0x0a]).toString('base64') });
  assert.equal(r.jsonBody.error.reason, '文字コードがUTF-8ではありません');
});

test('unexpected DB error -> 500 with the generic text, nothing saved', async () => {
  const r = await run(csv(H, row('BOOM')));
  assert.equal(r.status, 500);
  assert.equal(r.jsonBody.status, 'error');
  assert.deepEqual(lines(r), ['インポート処理中にエラーが発生しました。', 'データは保存されていません。', 'しばらくしてから再度お試しください。']);
});

test('every response has the same shape (the flow parses one schema)', async () => {
  const responses = [
    await run(csv(H, row('N1'))),
    await run(csv(H, 'N1,,,')),
    await run(csv('社員番号', 'N1')),
    await run(csv(H, row('DROP'))),
  ];
  for (const r of responses) {
    assert.deepEqual(Object.keys(r.jsonBody), SHAPE, `${r.status}`);
    assert.ok(['success', 'partial', 'error'].includes(r.jsonBody.status));
    assert.ok(r.jsonBody.title && r.jsonBody.message);
  }
});
