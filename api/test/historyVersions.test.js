/* History versions (21_history_versions.sql): the Planner flows add a row per task
   change instead of updating, and the list shows the latest version.
   Run: cd api && node --test */
const test = require('node:test');
const assert = require('node:assert/strict');
const { calls, data, call, post } = require('./harness');

test('historySetDelivered passes the task and delivered_at to sp_set_delivered', async () => {
  const r = await post('historySetDelivered', { planner_task_id: 'task-1', delivered_at: '2026-10-21T02:00:00Z' });
  assert.equal(r.status, 200);
  assert.equal(calls[0].proc, 'dbo.sp_set_delivered');
  assert.equal(calls[0].p.planner_task_id, 'task-1');
  assert.equal(calls[0].p.delivered_at.toISOString(), '2026-10-21T02:00:00.000Z');
  assert.deepEqual(Object.keys(calls[0].p).sort(), ['delivered_at', 'history_id', 'planner_task_id']);
});

test('historySetDelivered: unknown package 404, package without a task 400', async () => {
  assert.equal((await post('historySetDelivered', { history_id: 404 })).status, 404);
  const r = await post('historySetDelivered', { history_id: 400 });
  assert.equal(r.status, 400);
  assert.match(r.jsonBody.error, /no Planner task/);
});

test('historyList shows one row per package with the stable history_id', async () => {
  const saved = data.history;
  data.history = [
    { history_id: 7, slip_no: 'S-7', status: 'Notified', data_type: 'Identified', planner_task_id: 't7',
      notified_at: '2026-10-20T01:00:00Z', delivered_at: null,
      created_at: '2026-10-20T01:00:00Z', updated_at: '2026-10-22T10:00:05Z' },
  ];
  try {
    const r = await call('historyList', {});
    assert.equal(r.status, 200);
    const [row] = r.jsonBody.value;
    assert.equal(row.history_id, 7);
    assert.equal(row.delivered_at, null);
    assert.equal(row.created_at, '2026-10-20T01:00:00Z');
    assert.ok(!('task_changed_at' in row));
  } finally {
    data.history = saved;
  }
});
