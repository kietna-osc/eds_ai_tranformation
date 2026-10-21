/* History versions (21_history_versions.sql): the Planner flows add a row per task
   change instead of updating, and the list shows the latest version with
   task_changed_at. Run: cd api && node --test */
const test = require('node:test');
const assert = require('node:assert/strict');
const { calls, data, call, post } = require('./harness');

test('historySetDelivered passes task_changed_at to sp_set_delivered', async () => {
  const r = await post('historySetDelivered', {
    planner_task_id: 'task-1', delivered_at: '2026-10-21T02:00:00Z', task_changed_at: '2026-10-21T01:59:00Z',
  });
  assert.equal(r.status, 200);
  assert.equal(calls[0].proc, 'dbo.sp_set_delivered');
  assert.equal(calls[0].p.planner_task_id, 'task-1');
  assert.equal(calls[0].p.task_changed_at.toISOString(), '2026-10-21T01:59:00.000Z');
});

test('historySetDelivered from an old flow (no task_changed_at) sends NULL', async () => {
  const r = await post('historySetDelivered', { planner_task_id: 'task-1', delivered_at: '2026-10-21T02:00:00Z' });
  assert.equal(r.status, 200);
  assert.equal(calls[0].p.task_changed_at, null);
});

test('historySetDelivered: unknown package 404, package without a task 400', async () => {
  assert.equal((await post('historySetDelivered', { history_id: 404 })).status, 404);
  const r = await post('historySetDelivered', { history_id: 400 });
  assert.equal(r.status, 400);
  assert.match(r.jsonBody.error, /no Planner task/);
});

test('historyList returns task_changed_at of the latest version', async () => {
  const saved = data.history;
  data.history = [
    { history_id: 7, slip_no: 'S-7', status: 'Delivered', data_type: 'Identified', planner_task_id: 't7',
      notified_at: '2026-10-20T01:00:00Z', delivered_at: '2026-10-21T02:00:00Z',
      task_changed_at: '2026-10-21T01:59:00Z', created_at: '2026-10-20T01:00:00Z', updated_at: '2026-10-21T02:00:05Z' },
    { history_id: 8, slip_no: 'S-8', status: 'Notified', data_type: 'Unknown', planner_task_id: 't8',
      created_at: '2026-10-19T01:00:00Z', updated_at: '2026-10-19T01:00:00Z' },
  ];
  try {
    const r = await call('historyList', {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.jsonBody.value.map((v) => [v.history_id, v.task_changed_at]),
      [[7, '2026-10-21T01:59:00Z'], [8, null]]);
  } finally {
    data.history = saved;
  }
});
