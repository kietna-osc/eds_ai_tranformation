/* Generates 03_seed_data.sql - deterministic dummy data for eds-db.
   Employee counts per department follow the "Danh muc phong ban" sheet. */
const fs = require('fs');
const path = require('path');

// ---- deterministic PRNG (mulberry32) so re-running yields identical data
let _s = 0x9e3779b9;
const rnd = () => {
  _s |= 0; _s = _s + 0x6D2B79F5 | 0;
  let t = Math.imul(_s ^ _s >>> 15, 1 | _s);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};
const pick = a => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const DEPTS = [
  [1, '第１営業本部', 102], [2, '第２営業本部', 104], [3, '第１ソリューション本部第１部門', 114],
  [4, '第１ソリューション本部第２部門', 104], [5, '第２ソリューション本部第１部門', 103],
  [6, '第２ソリューション本部第２部門', 89], [7, '第３ソリューション本部第１部門', 95],
  [8, '第３ソリューション本部第２部門', 106], [9, 'デジタルコンサルティング本部', 90],
  [10, 'ソリューション開発', 99], [11, 'エンベデッドシステム', 126], [12, 'エンタープライズシステム', 82],
  [13, 'ITプラットフォーム', 114], [14, 'カスタマーサポート部', 90], [15, '品質管理部', 103],
  [16, 'DX推進部', 81], [17, '総務部', 109], [18, '経理部', 97], [19, '人事・人財開発部', 92],
  [20, '経営企画部', 96],
];
// Values present in the source list but absent from the catalog -> department_id NULL.
const UNMAPPED = ['Exeo Dig. Sol.', 'EDS本社 特定システム 事業部', 'EDS Solution Partners', 'デジタル戦略室'];

const SUR = [['佐藤', 'さとう', 'sato'], ['鈴木', 'すずき', 'suzuki'], ['高橋', 'たかはし', 'takahashi'],
['田中', 'たなか', 'tanaka'], ['伊藤', 'いとう', 'ito'], ['渡辺', 'わたなべ', 'watanabe'], ['山本', 'やまもと', 'yamamoto'],
['中村', 'なかむら', 'nakamura'], ['小林', 'こばやし', 'kobayashi'], ['加藤', 'かとう', 'kato'], ['吉田', 'よしだ', 'yoshida'],
['山田', 'やまだ', 'yamada'], ['佐々木', 'ささき', 'sasaki'], ['山口', 'やまぐち', 'yamaguchi'], ['松本', 'まつもと', 'matsumoto'],
['井上', 'いのうえ', 'inoue'], ['木村', 'きむら', 'kimura'], ['林', 'はやし', 'hayashi'], ['清水', 'しみず', 'shimizu'],
['山崎', 'やまざき', 'yamazaki'], ['森', 'もり', 'mori'], ['池田', 'いけだ', 'ikeda'], ['橋本', 'はしもと', 'hashimoto'],
['石川', 'いしかわ', 'ishikawa'], ['前田', 'まえだ', 'maeda'], ['藤田', 'ふじた', 'fujita'], ['小川', 'おがわ', 'ogawa'],
['岡田', 'おかだ', 'okada'], ['後藤', 'ごとう', 'goto'], ['長谷川', 'はせがわ', 'hasegawa'], ['村上', 'むらかみ', 'murakami'],
['近藤', 'こんどう', 'kondo'], ['石井', 'いしい', 'ishii'], ['斎藤', 'さいとう', 'saito'], ['坂本', 'さかもと', 'sakamoto'],
['遠藤', 'えんどう', 'endo'], ['青木', 'あおき', 'aoki'], ['藤井', 'ふじい', 'fujii'], ['西村', 'にしむら', 'nishimura'],
['福田', 'ふくだ', 'fukuda'], ['太田', 'おおた', 'ota'], ['三浦', 'みうら', 'miura'], ['藤原', 'ふじわら', 'fujiwara'],
['岡本', 'おかもと', 'okamoto'], ['松田', 'まつだ', 'matsuda'], ['中川', 'なかがわ', 'nakagawa'], ['中野', 'なかの', 'nakano'],
['原田', 'はらだ', 'harada'], ['小野', 'おの', 'ono'], ['田村', 'たむら', 'tamura']];

const GIVEN = [['太郎', 'たろう', 'taro'], ['花子', 'はなこ', 'hanako'], ['一郎', 'いちろう', 'ichiro'],
['美咲', 'みさき', 'misaki'], ['健太', 'けんた', 'kenta'], ['さくら', 'さくら', 'sakura'], ['大輔', 'だいすけ', 'daisuke'],
['愛', 'あい', 'ai'], ['翔太', 'しょうた', 'shota'], ['優子', 'ゆうこ', 'yuko'], ['直樹', 'なおき', 'naoki'],
['恵', 'めぐみ', 'megumi'], ['拓也', 'たくや', 'takuya'], ['真由美', 'まゆみ', 'mayumi'], ['雄太', 'ゆうた', 'yuta'],
['彩', 'あや', 'aya'], ['和也', 'かずや', 'kazuya'], ['麻衣', 'まい', 'mai'], ['亮', 'りょう', 'ryo'], ['里奈', 'りな', 'rina'],
['修平', 'しゅうへい', 'shuhei'], ['遥', 'はるか', 'haruka'], ['勇気', 'ゆうき', 'yuki'], ['七海', 'ななみ', 'nanami'],
['隆', 'たかし', 'takashi'], ['詩織', 'しおり', 'shiori'], ['聡', 'さとし', 'satoshi'], ['由美', 'ゆみ', 'yumi'],
['浩二', 'こうじ', 'koji'], ['千尋', 'ちひろ', 'chihiro'], ['圭介', 'けいすけ', 'keisuke'], ['奈々', 'なな', 'nana'],
['光', 'ひかる', 'hikaru'], ['彩香', 'あやか', 'ayaka'], ['大樹', 'だいき', 'daiki'], ['結衣', 'ゆい', 'yui'],
['翼', 'つばさ', 'tsubasa'], ['舞', 'まい', 'mai2'], ['誠', 'まこと', 'makoto'], ['瞳', 'ひとみ', 'hitomi']];

// Mirrors normalize.js: NFKC, katakana -> hiragana, strip whitespace.
const normalize = s => s.normalize('NFKC')
  .replace(/[\u30A1-\u30F6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
  .replace(/\s+/g, '').toLowerCase();

const q = s => (s === null || s === undefined) ? 'NULL' : "N'" + String(s).replace(/'/g, "''") + "'";
const qd = d => d === null ? 'NULL' : "'" + d.toISOString().slice(0, 19).replace('T', ' ') + "'";
const n = v => (v === null || v === undefined) ? 'NULL' : String(v);

// ------------------------------------------------------------------ employees
const emps = [];
let code = 0;
for (const [did, dname, count] of DEPTS) {
  for (let i = 0; i < count; i++) {
    const s = pick(SUR), g = pick(GIVEN);
    code++;
    emps.push({
      employee_code: 'demo-' + String(code).padStart(4, '0'),
      full_name: s[0] + ' ' + g[0],
      name_normalized: normalize(s[1] + g[1]),
      department_id: did,
      department_name: dname,
      email: g[2] + '.' + s[2] + code + '@example.co.jp',
      is_active: rnd() < 0.965 ? 1 : 0,   // a few leavers, to exercise the filtered indexes
    });
  }
}
// Unmapped departments -> department_id NULL but department_name retained.
const N_UNMAPPED = 12;
for (let i = 0; i < N_UNMAPPED; i++) {
  const s = pick(SUR), g = pick(GIVEN);
  code++;
  emps.push({
    employee_code: 'demo-' + String(code).padStart(4, '0'),
    full_name: s[0] + ' ' + g[0],
    name_normalized: normalize(s[1] + g[1]),
    department_id: null,
    department_name: pick(UNMAPPED),
    email: g[2] + '.' + s[2] + code + '@example.co.jp',
    is_active: 1,
  });
}

// -------------------------------------------------------------------- history
const NOW = new Date('2026-09-10T09:00:00Z');
const plannerId = () => {
  const cs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let o = '';
  for (let i = 0; i < 28; i++) o += cs[Math.floor(rnd() * cs.length)];
  return o;
};

const SENDERS = ['ヤマト運輸', '佐川急便', '日本郵便', 'Amazon', '楽天', '佐々木商事', '山田 花子', '株式会社スマート'];
const CONTENTS = ['書類', '契約書類', 'カタログ', 'サンプル品', '返送品', '請求書', '部品'];
const ADDRESSES = [
  '東京都千代田区丸の内1-1-1',
  '大阪府大阪市北区梅田1-1-3',
  '愛知県名古屋市中村区名駅1-1-4',
  '福岡県福岡市博多区博多駅前2-1-1',
  '神奈川県横浜市西区みなとみらい2-2-1',
];

const hist = [];
const N_HIST = 600;
for (let i = 0; i < N_HIST; i++) {
  // spread over the last 90 days, business hours
  const created = new Date(NOW - int(0, 90) * 864e5 - int(0, 9) * 36e5 - int(0, 59) * 6e4);
  const r = rnd();
  const status = r < 0.93 ? 'Identified' : 'Unknown';
  const ymd = created.toISOString().slice(0, 10).replace(/-/g, '');
  const row = {
    slip_no: 'SLP-' + ymd + '-' + String(int(1, 9999)).padStart(4, '0'),
    image_url: 'https://smartosc.sharepoint.com/sites/eds/PackageSlips/' + ymd +
      '/slip_' + String(i + 1).padStart(5, '0') + '.jpg',
    sender_name: pick(SENDERS),
    sender_content: pick(CONTENTS),
    sender_address: pick(ADDRESSES),
    created_at: created,
    status,
  };
  if (status === 'Unknown') {
    // Recipient was not identified: no employee, no snapshot.
    row.employee_id = null;
    row.recipient_name = null;
    row.recipient_department_id = null;
    row.recipient_department_name = null;
    row.notified_at = null;
    row.delivered_at = null;
    row.delivered_by = null;
    row.planner_task_id = null;
  } else {
    const e = emps[int(0, emps.length - 1)];
    row.emp_code = e.employee_code;                 // resolved to employee_id at load time
    row.recipient_name = e.full_name;               // snapshot
    row.recipient_department_id = e.department_id;  // snapshot
    row.recipient_department_name = e.department_name;
    row.notified_at = new Date(+created + int(2, 40) * 6e4);
    row.planner_task_id = plannerId();
    if (r < 0.65) {
      row.delivered_at = new Date(+row.notified_at + int(20, 3600) * 6e4);
      row.delivered_by = rnd() < 0.6 ? e.email : 'reception@example.co.jp';
    } else {
      row.delivered_at = null;
      row.delivered_by = null;
    }
  }
  hist.push(row);
}
hist.sort((a, b) => a.created_at - b.created_at);

// ------------------------------------------------------------------ emit SQL
const out = [];
out.push('/* EDS Phase 2 - dummy seed data. Generated by gen.js (deterministic).');
out.push('   ' + emps.length + ' employees across the 20-department catalog + ' + N_UNMAPPED + ' unmapped;');
out.push('   ' + hist.length + ' history rows over the 90 days to 2026-09-10. */');
out.push('SET NOCOUNT ON;');
out.push('DELETE FROM dbo.history;');
out.push('DELETE FROM dbo.employee;');
out.push("DBCC CHECKIDENT ('dbo.employee', RESEED, 0) WITH NO_INFOMSGS;");
out.push("DBCC CHECKIDENT ('dbo.history',  RESEED, 0) WITH NO_INFOMSGS;");
out.push('GO');

const CH = 200;
for (let i = 0; i < emps.length; i += CH) {
  const vals = emps.slice(i, i + CH).map(e =>
    '(' + q(e.employee_code) + ',' + q(e.full_name) + ',' + q(e.name_normalized) + ',' +
    n(e.department_id) + ',' + q(e.department_name) + ',' + q(e.email) + ',' + e.is_active + ')');
  out.push('INSERT dbo.employee (employee_code,full_name,name_normalized,department_id,department_name,email,is_active) VALUES');
  out.push(vals.join(',\n') + ';');
  out.push('GO');
}

for (let i = 0; i < hist.length; i += CH) {
  const vals = hist.slice(i, i + CH).map(h => {
    const eid = h.emp_code
      ? '(SELECT employee_id FROM dbo.employee WHERE employee_code=' + q(h.emp_code) + ')'
      : 'NULL';
    return '(' + q(h.slip_no) + ',' + q(h.image_url) + ',' + q(h.sender_name) + ',' +
      q(h.sender_content) + ',' + q(h.sender_address) + ',' +
      eid + ',' + q(h.recipient_name) + ',' + n(h.recipient_department_id) + ',' +
      q(h.recipient_department_name) + ",'" + h.status + "'," + qd(h.notified_at) + ',' +
      qd(h.delivered_at) + ',' + q(h.delivered_by) + ',' + q(h.planner_task_id) + ',' +
      qd(h.created_at) + ',' + qd(h.created_at) + ')';
  });
  out.push('INSERT dbo.history (slip_no,image_url,sender_name,sender_content,sender_address,employee_id,recipient_name,' +
    'recipient_department_id,recipient_department_name,status,notified_at,delivered_at,delivered_by,' +
    'planner_task_id,created_at,updated_at) VALUES');
  out.push(vals.join(',\n') + ';');
  out.push('GO');
}

fs.writeFileSync(path.join(__dirname, '..', '03_seed_data.sql'), out.join('\n'), 'utf8');
console.log('employees: ' + emps.length + '  history: ' + hist.length);
console.log('status mix: ' + ['Identified', 'Unknown']
  .map(s => s + '=' + hist.filter(h => h.status === s).length).join(' '));
