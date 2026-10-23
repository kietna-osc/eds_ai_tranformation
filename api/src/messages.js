/* Messages of the employee CSV import: ids and texts from the ErrorDesign sheet
   (宅配便伝票仕分けDX_テストケース一覧, 7.2.2 CSV import), Japanese column.
   The app shows the API's title and message as they are, so every popup text is here.
   {Y} / {OK} are filled by message(id, params); \n starts a new popup line.
   51-53 are counts, as the user asked on 2026-10-23: 成功 = added + updated rows (codes already
   in the DB are updated, Update案; neither the codes nor the added / updated split is shown),
   失敗 = skipped rows. */
const TEXTS = {
  // 50 CSVファイルの形式不正、破損、またはエンコーディング誤り
  50: 'CSVファイルを読み込めませんでした。CSV UTF-8形式で保存し直してから再度お試しください。',
  // 51 インポート完了（成功行とエラー行が混在）
  51: 'インポートが完了しました。\n成功：{OK}件\n失敗：{Y}件',
  // 52 インポート完了、エラー0件
  52: 'インポートが完了しました。\n成功：{OK}件',
  // 53 全行にエラーがある
  53: 'インポートに失敗しました。\n失敗：{Y}件（すべての行にデータエラーがあり、登録されませんでした）',
  // 55 アップロード許容サイズを超過するファイル
  55: 'CSVファイルのサイズが上限を超えています。ファイルを分割するか、行数を減らして再度お試しください。',
  // 56 インポートが中断され、一部データのみ書き込まれた状態（実際は全件ロールバック）
  56: '接続切断によりインポート処理が中断されました。データ整合性を保つため、データは保存されていません。ファイル全体を再度インポートしてください。',
  // Not in the sheet: an unexpected server error. The upsert is one transaction, so nothing is saved.
  unexpected: 'インポート処理中にエラーが発生しました。データは保存されていません。しばらくしてから再度お試しください。',
};

/* Popup titles per result status. */
const TITLES = {
  success: 'インポート完了',
  partial: 'インポート完了（一部エラーあり）',
  error: 'インポートエラー',
};

const message = (id, params = {}) => ({
  id,
  text: (TEXTS[id] || '').replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)),
});

/** One sentence per line: the popup shows the message as it is. */
const sentences = (text) => text.split(/(?<=。)|\n/).map((s) => s.trim()).filter(Boolean);

module.exports = { TEXTS, TITLES, message, sentences };
