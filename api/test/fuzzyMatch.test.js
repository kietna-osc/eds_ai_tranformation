/* Unit tests for the OCR receiver fuzzy match.
   Run: cd api && node --test */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fuzzyMatchEmployees } = require('../src/fuzzyMatch');

const row = (employee_id, full_name, department_name) =>
  ({ employee_id, full_name, department_name, email: `${employee_id}@example.com` });

/* Name only (nameWeight 1), so score = name similarity:
   10 equal characters out of 10 = 100, 9 = 90, 8 = 80 ... */
const roster = [
  row(1, 'abcdefghij', '総務部'),
  row(2, 'abcdefghix', '総務部'), // 90
  row(3, 'abcdefghxx', '総務部'), // 80
  row(4, 'abcdexxxxx', '総務部'), // 50
  row(5, 'abcxxxxxxx', '総務部'), // 30
  row(6, 'axxxxxxxxx', '総務部'), // 10
];
const ids = (result) => result.candidates.map((c) => c.employee_id);

test('fuzzy: unique exact name returns that employee alone', () => {
  const r = fuzzyMatchEmployees(roster, 'abcdefghij', '', 1);
  assert.equal(r.match_type, 'exact_name');
  assert.deepEqual(ids(r), ['1']);
});

test('fuzzy: every exact full-name match is returned, ordered by department, score 100', () => {
  const people = [
    row(11, '前川 雄亮', '経理部'),
    row(12, '前川雄亮', '総務部'),   // same name after normalization
    row(13, '前川 雄亮', '営業部'),
    row(14, '前川 雄介', '総務部'),  // not an exact match
  ];
  const r = fuzzyMatchEmployees(people, '前川 雄亮', '総務部', 0.7);
  assert.equal(r.match_type, 'exact_name');
  assert.equal(ids(r)[0], '12'); // department match first
  assert.deepEqual(ids(r).slice().sort(), ['11', '12', '13']);
  assert.ok(r.candidates.every((c) => c.score === 100 && c.name_score === 100));
  assert.ok(r.candidates[0].department_score >= r.candidates[1].department_score);
  assert.ok(r.candidates[1].department_score >= r.candidates[2].department_score);
});

test('fuzzy: OCR family name only matches by family name, score 60 + department × 0.3', () => {
  const people = [
    row(21, '竹平 裕紀', '総務部'),
    row(22, '竹平　健', '経理部'),  // full-width space
    row(23, '竹平裕紀', '総務部'),  // no space: no family name, not matched
    row(24, '竹田 一郎', '総務部'),
  ];
  const r = fuzzyMatchEmployees(people, '竹平', '総務部', 0.7);
  assert.equal(r.match_type, 'family_name');
  assert.deepEqual(ids(r), ['21', '22']);
  assert.equal(r.candidates[0].score, 90);  // 60 + 100 × 0.3
  assert.equal(r.candidates[1].score, 70);  // 60 + 33.33 × 0.3 (総務部 vs 経理部 share 部)
});

test('fuzzy: exact full name wins over family name', () => {
  const people = [row(31, '竹平', '総務部'), row(32, '竹平 裕紀', '総務部')];
  const r = fuzzyMatchEmployees(people, '竹平', '総務部', 0.7);
  assert.equal(r.match_type, 'exact_name');
  assert.deepEqual(ids(r), ['31']);
});

test('fuzzy: no exact match returns every candidate above minScore, best first', () => {
  const r = fuzzyMatchEmployees(roster.slice(1), 'abcdefghij', '', 1);
  assert.equal(r.match_type, 'top_k');
  // 90 and 80 are both returned (no top-1 cut for high scores); 30 is not above 30.
  assert.deepEqual(ids(r), ['2', '3', '4']);
  assert.deepEqual(r.candidates.map((c) => c.score), [90, 80, 50]);
});

test('fuzzy: minScore is a parameter (default 30)', () => {
  const rest = roster.slice(1);
  assert.deepEqual(ids(fuzzyMatchEmployees(rest, 'abcdefghij', '', 1, 60)), ['2', '3']);
  assert.deepEqual(ids(fuzzyMatchEmployees(rest, 'abcdefghij', '', 1, 0)), ['2', '3', '4', '5', '6']);
  assert.deepEqual(ids(fuzzyMatchEmployees(rest, 'abcdefghij', '', 1, 95)), []);
});

test('fuzzy: empty receiver name or roster returns none', () => {
  assert.deepEqual(fuzzyMatchEmployees(roster, '', '', 1), { match_type: 'none', candidates: [] });
  assert.deepEqual(fuzzyMatchEmployees([], 'abc', '', 1), { match_type: 'none', candidates: [] });
});
