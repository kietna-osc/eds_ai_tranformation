/* User-facing messages from the Function_Design_Messages sheet
   ([Internal] [EDS] Function Desgin v1.2.xlsx). Keys are the sheet IDs, so the
   Power App and testers can match a response to its row.

   Responses carry { id, type, text, params }. `text` is the Japanese message
   with {X} / {Y} / {リスト} filled in; the Power App can show it directly or
   render its own copy from `id` + `params`.

   The "[エラー詳細ファイルをダウンロード]" link in 51 / 53 is not part of `text`:
   the response's errorFile tells the app to show that download button. */
const MESSAGES = {
  // 7.2.2 CSV import
  51: { type: 'success', text: 'インポートが完了しました。{X}名の従業員を追加しました。データエラーにより{Y}行をスキップしました。' },
  52: { type: 'success', text: 'インポートが完了しました。{X}名の従業員を追加しました。' },
  53: { type: 'error', text: 'インポートに失敗しました。{X}行すべてにデータエラーがあり、従業員は追加されませんでした。' },
  // Duplicate employee code: the Update option was chosen (Skip / Reject dropped).
  54: { type: 'error', text: '重複コードが{X}件検出されました：{リスト}。既存データは新しい情報で更新されました。' },
  55: { type: 'error', text: 'CSVファイルのサイズが上限を超えています。ファイルを分割するか、行数を減らして再度お試しください。' },
  56: { type: 'error', text: '接続切断によりインポート処理が中断されました。データ整合性を保つため、データは保存されていません。ファイル全体を再度インポートしてください。' },
  // 7.2.3 CSV export
  57: { type: 'success', text: '従業員一覧のCSVファイルを出力しました。' },
  58: { type: 'error', text: 'CSVファイルの出力に時間がかかっています。しばらくしてから再度お試しください。' },
};

function message(id, params = {}) {
  const m = MESSAGES[id];
  if (!m) throw new Error(`unknown message id ${id}`);
  const text = m.text.replace(/\{([^}]+)\}/g, (all, k) => (k in params ? String(params[k]) : all));
  return { id, type: m.type, text, params };
}

module.exports = { MESSAGES, message };
