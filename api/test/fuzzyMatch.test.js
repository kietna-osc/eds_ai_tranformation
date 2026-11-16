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
