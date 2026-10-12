/* Message ids used by the employee CSV import (51-56).
   The Azure messages.js file was not in the pasted index.js, so these texts
   are the local stand-in for the same ids. */
const TEXTS = {
  51: 'すべての行を取り込みました。',
  52: '一部の行を取り込みました。エラー行はスキップしました。',
  53: '有効な行がないため、取り込みませんでした。',
  54: '既存の社員番号を更新しました。',
  55: 'ファイルが大きすぎます。',
  56: '接続が切れたため、取り込みを取り消しました。',
};

const message = (id) => ({ id, text: TEXTS[id] || '' });

module.exports = { message };
