/* Messages of the employee CSV import, ids and texts from the ErrorDesign sheet
   (宅配便伝票仕分けDX_テストケース一覧, 7.2.2 CSV import).
   50 is the shared upload error: ErrorDesign 50 (parse / encoding), 55 (size) and
   56 (connection lost) are merged into it, because the app cannot tell the cause.
   {X} / {Y} / {LIST} are filled by message(id, params). */
const TEXTS = {
  50: 'CSVファイルのアップロードに失敗しました。ファイルを確認して、しばらくしてから再度お試しください。',
  51: 'インポートが完了しました。{X}名の従業員を追加しました。データエラーにより{Y}行をスキップしました。',
  52: 'インポートが完了しました。{X}名の従業員を追加しました。',
  53: 'インポートに失敗しました。{X}行すべてにデータエラーがあり、従業員は追加されませんでした。',
  54: '重複コードが{X}件検出されました：{LIST}。既存データは新しい情報で更新されました。',
};

const message = (id, params = {}) => ({
  id,
  text: (TEXTS[id] || '').replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)),
});

module.exports = { message };
