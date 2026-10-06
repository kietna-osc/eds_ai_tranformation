const { app } = require('@azure/functions');
const { exec, sql } = require('./db');
const { fuzzyMatchEmployees } = require('./fuzzyMatch');

/* Every route is authLevel 'function' and the app additionally restricts inbound
   traffic to the APIM gateway IP, so these handlers are never reached directly.
   Caller identity (JWT, tenant, app role) is validated by the APIM global policy. */

/* dbo.history schema:
   image_url NVARCHAR(MAX): base64 data URI ("data:image/...;base64,...") for new rows,
   a SharePoint URL or relative path for rows saved before the change
   sender_name NVARCHAR(200), sender_content NVARCHAR(1000), sender_address NVARCHAR(500)
   status VARCHAR(20) CHECK (Unknown | Identified), default Unknown */
const STATUSES = new Set(['Unknown', 'Identified']);

const toHistory = (row) => ({
  history_id: Number(row.history_id),
  slip_no: row.slip_no,
  image_url: row.image_url,
  sender_name: row.sender_name,
  sender_content: row.sender_content,
  sender_address: row.sender_address,
  // Coerced like history_id: the EDS-APIManagement1 Parse JSON schema expects integer | null,
  // and a string here (e.g. a BIGINT or text column, which mssql returns as a string) fails the run.
  employee_id: intOrNull(row.employee_id),
  recipient_name: row.recipient_name,
  recipient_department_id: intOrNull(row.recipient_department_id),
  recipient_department_name: row.recipient_department_name,
  status: row.status,
  notified_at: row.notified_at,
  delivered_at: row.delivered_at,
  delivered_by: row.delivered_by,
  planner_task_id: row.planner_task_id,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const toEmployee = (row) => ({
  employee_id: row.employee_id,
  employee_code: row.employee_code,
  full_name: row.full_name,
  name_normalized: row.name_normalized,
  department_id: row.department_id,
  department_name: row.department_name,
  email: row.email,
  is_active: row.is_active,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const clampTop = (v, dflt = 50, max = 200) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
};

const intOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

const strOrNull = (v, max) =>
  v === undefined || v === null || v === '' ? null : String(v).slice(0, max);

const dateOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(+d) ? null : d;
};

const json = (status, body) => ({
  status,
  jsonBody: body,
  headers: { 'Cache-Control': 'no-store' },
});

/** Wraps a handler so an unexpected failure never leaks SQL detail to the client. */
const handler = (name, fn) => async (request, context) => {
  try {
    return await fn(request, context);
  } catch (e) {
    context.error(`${name} failed: ${e.message}`, e.stack);
    if (e.number === 50001) return json(400, { error: e.message });
    if (e.number === 547) {
      return json(409, {
        error: 'Cannot delete: history rows still reference this employee',
      });
    }
    if (e.number === 2627 || e.number === 2601) {
      return json(409, { error: 'a row with that key already exists' });
    }
    return json(500, { error: 'Internal error', requestId: context.invocationId });
  }
};

/* ------------------------------------------------- GET /api/history
   History page with server-side pagination.
   Filters are applied in DB first, then page/pageSize are used
   to return the requested chunk. Each row includes sender_name,
   sender_content, sender_address and status Unknown | Identified. */
app.http('historyList', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'history',
  handler: handler('historyList', async (request, context) => {
    const q = request.query;

    const status = strOrNull(q.get('status'), 20);
    const employeeId = intOrNull(q.get('employee_id'));
    const departmentId = intOrNull(q.get('department_id'));
    const notifiedStart = dateOrNull(q.get('notified_start'));
    const notifiedEnd = dateOrNull(q.get('notified_end'));
    const deliveredStart = dateOrNull(q.get('delivered_start'));
    const deliveredEnd = dateOrNull(q.get('delivered_end'));

    const pageSize = clampTop(q.get('pageSize'), 50, 200);

    const pageValue = parseInt(q.get('page'), 10);
    const page = Number.isFinite(pageValue) && pageValue > 0
      ? pageValue
      : 1;

    if (status && !STATUSES.has(status)) {
      return json(400, {
        error: `status must be one of ${[...STATUSES].join(', ')}`
      });
    }
    if (q.get('notified_start') && !notifiedStart) {
      return json(400, { error: 'notified_start must be a valid datetime' });
    }
    if (q.get('notified_end') && !notifiedEnd) {
      return json(400, { error: 'notified_end must be a valid datetime' });
    }
    if (q.get('delivered_start') && !deliveredStart) {
      return json(400, { error: 'delivered_start must be a valid datetime' });
    }
    if (q.get('delivered_end') && !deliveredEnd) {
      return json(400, { error: 'delivered_end must be a valid datetime' });
    }

    const rows = await exec('dbo.sp_history_list', [
      ['page', sql.Int, page],
      ['page_size', sql.Int, pageSize],
      ['status', sql.VarChar(20), status],
      ['department_id', sql.Int, departmentId],
      ['employee_id', sql.Int, employeeId],
      ['notified_start', sql.DateTime2, notifiedStart],
      ['notified_end', sql.DateTime2, notifiedEnd],
      ['delivered_start', sql.DateTime2, deliveredStart],
      ['delivered_end', sql.DateTime2, deliveredEnd],
    ], context);

    const totalCount = Number(rows[0]?.total_count ?? 0);

    return json(200, {
      page,
      pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
      count: rows.length,
      value: rows.map(toHistory),
    });
  }),
});

/* ------------------------------------------------ POST /api/history
   Called at the end of the Power Automate flow to append a package.
   Returns history_id so the flow can link the Planner task to it. */
app.http('historyInsert', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'history',
  handler: handler('historyInsert', async (request, context) => {
    const b = await request.json().catch(() => ({}));
    const employeeId = intOrNull(b.employee_id);
    const status = strOrNull(b.status, 20) || (employeeId ? 'Identified' : 'Unknown');
    if (!STATUSES.has(status)) {
      return json(400, { error: `status must be one of ${[...STATUSES].join(', ')}` });
    }
    const rows = await exec('dbo.sp_history_insert', [
      ['slip_no', sql.NVarChar(100), strOrNull(b.slip_no, 100)],
      // image_url holds the scanned image as a base64 data URI, so it is not length-capped.
      ['image_url', sql.NVarChar(sql.MAX), strOrNull(b.image_url)],
      ['sender_name', sql.NVarChar(200), strOrNull(b.sender_name, 200)],
      ['sender_content', sql.NVarChar(1000), strOrNull(b.sender_content, 1000)],
      ['sender_address', sql.NVarChar(500), strOrNull(b.sender_address, 500)],
      ['employee_id', sql.Int, employeeId],
      ['recipient_name', sql.NVarChar(200), strOrNull(b.recipient_name, 200)],
      ['recipient_department_id', sql.Int, intOrNull(b.recipient_department_id)],
      ['recipient_department_name', sql.NVarChar(200), strOrNull(b.recipient_department_name, 200)],
      ['status', sql.VarChar(20), status],
      ['notified_at', sql.DateTime2, dateOrNull(b.notified_at)],
      ['planner_task_id', sql.NVarChar(100), strOrNull(b.planner_task_id, 100)],
    ], context);
    return json(201, { history_id: Number(rows[0]?.history_id) });
  }),
});

/* --------------------------- PATCH /api/history/{id}/planner-task
   Links the Planner task created by the flow back to the package, which is what
   makes the completion lookup in sp_set_delivered possible. */
app.http('historySetPlannerTask', {
  methods: ['PATCH'],
  authLevel: 'function',
  route: 'history/{id}/planner-task',
  handler: handler('historySetPlannerTask', async (request, context) => {
    const historyId = intOrNull(request.params.id);
    const b = await request.json().catch(() => ({}));
    const taskId = strOrNull(b.planner_task_id, 100);
    if (!historyId) return json(400, { error: 'id must be a positive integer' });
    if (!taskId) return json(400, { error: 'planner_task_id is required' });

    const rows = await exec('dbo.sp_history_set_planner_task', [
      ['history_id', sql.BigInt, historyId],
      ['planner_task_id', sql.NVarChar(100), taskId],
    ], context);
    const updated = rows[0]?.rows_updated ?? 0;
    return updated ? json(200, { updated }) : json(404, { error: 'history_id not found' });
  }),
});

/* --------------------------------------- POST /api/history/delivered
   Called by the "When a task is completed" Planner flow. Idempotent: replaying
   the same task does not move delivered_at, so a duplicate trigger is harmless. */
app.http('historySetDelivered', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'history/delivered',
  handler: handler('historySetDelivered', async (request, context) => {
    const b = await request.json().catch(() => ({}));
    const taskId = strOrNull(b.planner_task_id, 100);
    const historyId = intOrNull(b.history_id);
    if (!taskId && !historyId) {
      return json(400, { error: 'planner_task_id or history_id is required' });
    }
    const rows = await exec('dbo.sp_set_delivered', [
      ['planner_task_id', sql.NVarChar(100), taskId],
      ['history_id', sql.BigInt, historyId],
      ['delivered_by', sql.NVarChar(320), strOrNull(b.delivered_by, 320)],
      ['delivered_at', sql.DateTime2, dateOrNull(b.delivered_at)],
    ], context);
    const updated = rows[0]?.rows_updated ?? 0;
    // 404 tells the flow the task was never linked to a package - worth alerting on.
    return updated ? json(200, { updated }) : json(404, { error: 'no matching package' });
  }),
});

/* ------------------------------------- GET /api/employees
   Employee page with server-side pagination, same shape as historyList.
   department_id filters by department; search_keyword matches name, department, or email. */
app.http('employeeList', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'employees',
  handler: handler('employeeList', async (request, context) => {
    const q = request.query;

    const departmentId = intOrNull(q.get('department_id'));
    const searchKeyword = strOrNull(q.get('search_keyword'), 200);

    const pageSize = clampTop(q.get('pageSize'), 50, 200);

    const pageValue = parseInt(q.get('page'), 10);
    const page = Number.isFinite(pageValue) && pageValue > 0
      ? pageValue
      : 1;

    const rows = await exec('dbo.sp_employee_list', [
      ['page', sql.Int, page],
      ['page_size', sql.Int, pageSize],
      ['department_id', sql.Int, departmentId],
      ['search_keyword', sql.NVarChar(200), searchKeyword],
    ], context);

    const totalCount = Number(rows[0]?.total_count ?? 0);

    return json(200, {
      page,
      pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
      count: rows.length,
      value: rows.map(toEmployee),
    });
  }),
});

/* ------------------------------------- GET /api/employees/match
   OCR name -> ranked candidate recipients. `name` must already be normalised
   (NFKC, katakana -> hiragana, whitespace stripped) by the caller. */
app.http('employeeMatch', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'employees/match',
  handler: handler('employeeMatch', async (request, context) => {
    const q = request.query;
    const name = strOrNull(q.get('name'), 200);
    if (!name) return json(400, { error: 'name is required' });

    const rows = await exec('dbo.sp_match_candidates', [
      ['name_normalized', sql.NVarChar(200), name],
      ['department_id', sql.Int, intOrNull(q.get('department_id'))],
      ['top', sql.Int, clampTop(q.get('top'), 10, 50)],
    ], context);
    return json(200, { count: rows.length, value: rows });
  }),
});

/* ----------------------------- GET|POST /api/employees/fuzzy-search
   OCR receiver fuzzy match. Roster is loaded from dbo.employee (active).
   Candidates keep the Office Script shape: employee_id, name, department,
   email, name_score, department_score, score. */
app.http('fuzzySearch', {
  methods: ['GET', 'POST'],
  authLevel: 'function',
  route: 'employees/fuzzy-search',
  handler: handler('fuzzySearch', async (request, context) => {
    const q = request.query;
    const b = request.method === 'POST'
      ? await request.json().catch(() => ({}))
      : {};

    const pick = (snake, camel) =>
      b[snake] ?? b[camel] ?? q.get(snake) ?? q.get(camel);

    const receiverName = String(pick('receiver_name', 'receiverName') ?? '');
    const department = String(pick('department', 'department') ?? '');
    const nameWeight = Number(pick('name_weight', 'nameWeight') ?? 0.85);
    const topK = Number(pick('top_k', 'topK') ?? 3);
    const fuzzyThreshold = Number(pick('fuzzy_threshold', 'fuzzyThreshold') ?? 90);

    const roster = await exec('dbo.sp_employee_fuzzy_roster', [], context);
    return json(200, fuzzyMatchEmployees(
      roster,
      receiverName,
      department,
      nameWeight,
      topK,
      fuzzyThreshold
    ));
  }),
});

/* ----------------------------------------- POST /api/employees
   Inserts a new employee into dbo.employee. */
app.http('employeeInsert', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'employees',
  handler: handler('employeeInsert', async (request, context) => {
    const b = await request.json().catch(() => ({}));

    const employeeId = intOrNull(b.employee_id);
    const employeeCode = strOrNull(b.employee_code, 50);
    const fullName = strOrNull(b.full_name, 200);

    if (!employeeId || employeeId <= 0) {
      return json(400, {
        error: 'employee_id must be a positive integer'
      });
    }

    if (!employeeCode) {
      return json(400, {
        error: 'employee_code is required'
      });
    }

    if (!fullName) {
      return json(400, {
        error: 'full_name is required'
      });
    }

    const rows = await exec('dbo.sp_employee_insert', [
      ['employee_id', sql.Int, employeeId],
      ['employee_code', sql.NVarChar(50), employeeCode],
      ['full_name', sql.NVarChar(200), fullName],
      ['name_normalized', sql.NVarChar(200), strOrNull(b.name_normalized, 200)],
      ['department_id', sql.Int, intOrNull(b.department_id)],
      ['department_name', sql.NVarChar(200), strOrNull(b.department_name, 200)],
      ['email', sql.NVarChar(320), strOrNull(b.email, 320)],
      ['is_active', sql.Bit, b.is_active === undefined ? true : Boolean(b.is_active)],
    ], context);

    return json(201, {
      value: rows[0]
    });
  }),
});

/* --------------------------------------- DELETE /api/employees/{id}
   Removes the employee row. History rows keep their employee_id snapshot. */
app.http('employeeDelete', {
  methods: ['DELETE'],
  authLevel: 'function',
  route: 'employees/{id}',
  handler: handler('employeeDelete', async (request, context) => {
    const employeeId = intOrNull(request.params.id);
    if (!employeeId || employeeId <= 0) {
      return json(400, { error: 'id must be a positive integer' });
    }

    const rows = await exec('dbo.sp_employee_delete', [
      ['employee_id', sql.Int, employeeId],
    ], context);
    const deleted = rows[0]?.rows_deleted ?? 0;
    return deleted
      ? json(200, { deleted })
      : json(404, { error: 'employee_id not found' });
  }),
});

/* -------------------------------------------- GET /api/departments */
app.http('departmentList', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'departments',
  handler: handler('departmentList', async (request, context) => {
    const rows = await exec('dbo.sp_department_list', [], context);
    return json(200, { count: rows.length, value: rows });
  }),
});

/* ------------------------------------------- POST /api/departments */
app.http('departmentInsert', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'departments',
  handler: handler('departmentInsert', async (request, context) => {
    const b = await request.json().catch(() => ({}));
    const name = strOrNull(b.department_name, 200);
    if (!name) return json(400, { error: 'department_name is required' });

    const rows = await exec('dbo.sp_department_insert', [
      ['department_name', sql.NVarChar(200), name],
    ], context);
    return json(201, { value: rows[0] });
  }),
});

/* ------------------------------------------- POST /api/ocr-history
   Appends one OCR result log. history_id is optional. */
app.http('ocrHistoryInsert', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'ocr-history',
  handler: handler('ocrHistoryInsert', async (request, context) => {
    const b = await request.json().catch(() => ({}));
    const rows = await exec('dbo.sp_ocr_history_insert', [
      ['history_id', sql.BigInt, intOrNull(b.history_id)],
      ['name', sql.NVarChar(200), strOrNull(b.name, 200)],
      ['department', sql.NVarChar(200), strOrNull(b.department, 200)],
      ['slip_no', sql.NVarChar(100), strOrNull(b.slip_no, 100)],
      ['sender_name', sql.NVarChar(200), strOrNull(b.sender_name, 200)],
      ['sender_content', sql.NVarChar(1000), strOrNull(b.sender_content, 1000)],
      ['sender_address', sql.NVarChar(500), strOrNull(b.sender_address, 500)],
      ['model_name', sql.NVarChar(200), strOrNull(b.model_name, 200)],
    ], context);
    return json(201, { id: Number(rows[0]?.id) });
  }),
});

/* --------------------------------------------------- GET /api/health
   Anonymous and does not touch SQL, so it can be probed without waking the
   database or holding a token. */
app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: async () => json(200, { ok: true, ts: new Date().toISOString() }),
});
