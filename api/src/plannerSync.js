/* Planner -> History status sync (POST /api/history/planner-sync).

   Called once or twice a day by the scheduled flow EDS-PlannerStatusSync. The flow
   lists every task in the EDS Planner plan and sends one entry per task:
     { "planner_task_id": "...", "completed": true | false, "completed_at": "ISO" | null }
   completed means percentComplete = 100 in Planner.

   dbo.sp_history_planner_sync compares each task with the latest version of its
   package and, when they disagree, INSERTs a new version (history + ocr_history):
     task open again (reopened in Planner) + latest 受取済み -> 通知済み version,
       delivered_at NULL, task_changed_at = snapshot_at (Planner does not record
       when a task is reopened, so the time the flow read Planner is used)
     task completed + latest 通知済み -> 受取済み version,
       delivered_at = task_changed_at = completed_at
   Only the tasks in the request are looked at. A task missing from the list (deleted,
   or on a page the flow did not read) is never treated as reopened.

   Safety settings sent by the flow:
     snapshot_at  when the flow started reading Planner (utcNow() before listing the
                  tasks, ISO with Z). A package delivered after that moment (by the
                  "When a task is completed" flow) is not reverted, because the task
                  list is older than that delivery. Also the reopen time stored in
                  task_changed_at, so a time in the future is rejected.
     max_revert   when more rows than this would go back to 通知済み, nothing changes
                  and the API answers 409. A bulk reopen in Planner or a flow bug
                  should be checked by a person first.

   This module only reads and checks the request; the handler is in index.js. */

const DEFAULT_MAX_REVERT = 50;
const MAX_REVERT_LIMIT = 1000;
const MAX_TASKS_PER_REQUEST = 20000;
const PLANNER_TASK_ID_MAX_LENGTH = 100;
// Clock skew allowed between the flow and the Function App.
const SNAPSHOT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/** Date from an ISO string, or null when missing or not a date. */
function toDateOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** max_revert as an integer in 0..MAX_REVERT_LIMIT; DEFAULT_MAX_REVERT when not sent. */
function readMaxRevert(value) {
  if (value === undefined || value === null || value === '') return { maxRevert: DEFAULT_MAX_REVERT };
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > MAX_REVERT_LIMIT) {
    return { error: `max_revert must be an integer from 0 to ${MAX_REVERT_LIMIT}` };
  }
  return { maxRevert: number };
}

/** One Planner task from the request, or { error } naming its position. */
function readTask(task, index) {
  const where = `tasks[${index}]`;
  if (!task || typeof task !== 'object') return { error: `${where} must be an object` };

  const plannerTaskId = typeof task.planner_task_id === 'string' ? task.planner_task_id.trim() : '';
  if (!plannerTaskId) return { error: `${where}.planner_task_id is required` };
  if (plannerTaskId.length > PLANNER_TASK_ID_MAX_LENGTH) {
    return { error: `${where}.planner_task_id is longer than ${PLANNER_TASK_ID_MAX_LENGTH} characters` };
  }
  if (typeof task.completed !== 'boolean') return { error: `${where}.completed must be true or false` };

  // An open task has no completion time, whatever Planner sent.
  const completedAt = task.completed ? toDateOrNull(task.completed_at) : null;
  return {
    task: {
      planner_task_id: plannerTaskId,
      completed: task.completed,
      completed_at: completedAt ? completedAt.toISOString() : null,
    },
  };
}

/** Checks the request body.
 *  Returns { error } for a bad request, otherwise
 *  { snapshotAt, maxRevert, tasks, duplicateCount }.
 *  A task id sent twice (overlapping pages) is kept once - the first entry wins. */
function readPlannerSyncRequest(body, now = new Date()) {
  const request = body && typeof body === 'object' ? body : {};

  const snapshotAt = toDateOrNull(request.snapshot_at);
  if (!snapshotAt) return { error: 'snapshot_at is required (ISO date-time)' };
  if (snapshotAt.getTime() > now.getTime() + SNAPSHOT_FUTURE_TOLERANCE_MS) {
    return { error: 'snapshot_at is in the future (send utcNow(), ISO with Z)' };
  }

  const { maxRevert, error: maxRevertError } = readMaxRevert(request.max_revert);
  if (maxRevertError) return { error: maxRevertError };

  if (!Array.isArray(request.tasks)) return { error: 'tasks must be an array' };
  if (request.tasks.length > MAX_TASKS_PER_REQUEST) {
    return { error: `tasks has more than ${MAX_TASKS_PER_REQUEST} entries` };
  }

  const tasks = [];
  const seenTaskIds = new Set();
  let duplicateCount = 0;
  for (let index = 0; index < request.tasks.length; index++) {
    const { task, error } = readTask(request.tasks[index], index);
    if (error) return { error };
    if (seenTaskIds.has(task.planner_task_id)) {
      duplicateCount++;
      continue;
    }
    seenTaskIds.add(task.planner_task_id);
    tasks.push(task);
  }

  return { snapshotAt, maxRevert, tasks, duplicateCount };
}

module.exports = {
  readPlannerSyncRequest,
  DEFAULT_MAX_REVERT,
  MAX_REVERT_LIMIT,
  MAX_TASKS_PER_REQUEST,
};
