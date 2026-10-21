/* Unit tests for the planner-sync request checks (plannerSync.js).
   Run: cd api && node --test */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readPlannerSyncRequest, DEFAULT_MAX_REVERT, MAX_REVERT_LIMIT } = require('../src/plannerSync');

const SNAPSHOT = '2026-10-14T10:00:00Z';
const validRequest = (overrides = {}) => ({
  snapshot_at: SNAPSHOT,
  max_revert: 10,
  tasks: [
    { planner_task_id: 'task-done', completed: true, completed_at: '2026-10-14T03:12:00.1234567Z' },
    { planner_task_id: 'task-open', completed: false, completed_at: null },
  ],
  ...overrides,
});

test('planner sync: a valid request is read as is', () => {
  const r = readPlannerSyncRequest(validRequest());
  assert.equal(r.error, undefined);
  assert.equal(r.snapshotAt.toISOString(), '2026-10-14T10:00:00.000Z');
  assert.equal(r.maxRevert, 10);
  assert.equal(r.duplicateCount, 0);
  assert.deepEqual(r.tasks, [
    { planner_task_id: 'task-done', completed: true, completed_at: '2026-10-14T03:12:00.123Z' },
    { planner_task_id: 'task-open', completed: false, completed_at: null },
  ]);
});

test('planner sync: snapshot_at is required and must be a date', () => {
  for (const snapshot_at of [undefined, null, '', 'yesterday']) {
    assert.match(readPlannerSyncRequest(validRequest({ snapshot_at })).error, /snapshot_at/, String(snapshot_at));
  }
});

test('planner sync: snapshot_at in the future is rejected (JST sent without Z)', () => {
  const now = new Date('2026-10-22T10:00:00Z'); // 19:00 JST
  assert.equal(readPlannerSyncRequest(validRequest({ snapshot_at: '2026-10-22T10:00:00Z' }), now).error, undefined);
  assert.equal(readPlannerSyncRequest(validRequest({ snapshot_at: '2026-10-22T10:04:00Z' }), now).error, undefined);
  assert.match(readPlannerSyncRequest(validRequest({ snapshot_at: '2026-10-22T19:00:00Z' }), now).error, /future/);
  assert.equal(readPlannerSyncRequest(validRequest({ snapshot_at: '2026-10-22T19:00:00+09:00' }), now).error, undefined);
});

test('planner sync: max_revert defaults and is bounded', () => {
  assert.equal(readPlannerSyncRequest(validRequest({ max_revert: undefined })).maxRevert, DEFAULT_MAX_REVERT);
  assert.equal(readPlannerSyncRequest(validRequest({ max_revert: 0 })).maxRevert, 0);
  assert.equal(readPlannerSyncRequest(validRequest({ max_revert: '25' })).maxRevert, 25);
  for (const max_revert of [-1, 1.5, MAX_REVERT_LIMIT + 1, 'many']) {
    assert.match(readPlannerSyncRequest(validRequest({ max_revert })).error, /max_revert/, String(max_revert));
  }
});

test('planner sync: tasks must be an array of well-formed entries', () => {
  assert.match(readPlannerSyncRequest(validRequest({ tasks: undefined })).error, /tasks must be an array/);
  assert.match(readPlannerSyncRequest(validRequest({ tasks: 'x' })).error, /tasks must be an array/);
  assert.match(readPlannerSyncRequest(validRequest({ tasks: [null] })).error, /tasks\[0\] must be an object/);
  assert.match(readPlannerSyncRequest(validRequest({ tasks: [{ completed: true }] })).error,
    /tasks\[0\]\.planner_task_id is required/);
  assert.match(readPlannerSyncRequest(validRequest({ tasks: [{ planner_task_id: 'x'.repeat(101), completed: true }] })).error,
    /longer than 100/);
  assert.match(readPlannerSyncRequest(validRequest({ tasks: [{ planner_task_id: 'a', completed: 'true' }] })).error,
    /tasks\[0\]\.completed must be true or false/);
});

test('planner sync: an empty task list is allowed', () => {
  const r = readPlannerSyncRequest(validRequest({ tasks: [] }));
  assert.equal(r.error, undefined);
  assert.deepEqual(r.tasks, []);
});

test('planner sync: a task id sent twice is kept once, first entry wins', () => {
  const r = readPlannerSyncRequest(validRequest({
    tasks: [
      { planner_task_id: 'same', completed: false },
      { planner_task_id: ' same ', completed: true, completed_at: SNAPSHOT },
    ],
  }));
  assert.equal(r.duplicateCount, 1);
  assert.deepEqual(r.tasks, [{ planner_task_id: 'same', completed: false, completed_at: null }]);
});

test('planner sync: completed_at is dropped for open tasks and when not a date', () => {
  const r = readPlannerSyncRequest(validRequest({
    tasks: [
      { planner_task_id: 'open', completed: false, completed_at: SNAPSHOT },
      { planner_task_id: 'done-bad-date', completed: true, completed_at: 'not a date' },
    ],
  }));
  assert.equal(r.tasks[0].completed_at, null);
  assert.equal(r.tasks[1].completed_at, null);
});

test('planner sync: a missing or non-object body is a bad request', () => {
  assert.match(readPlannerSyncRequest(null).error, /snapshot_at/);
  assert.match(readPlannerSyncRequest('text').error, /snapshot_at/);
});
