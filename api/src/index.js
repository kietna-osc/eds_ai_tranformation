const { app } = require('@azure/functions');
const { exec, sql, isRetryable } = require('./db');
const { fuzzyMatchEmployees } = require('./fuzzyMatch');
const blobImages = require('./blobImages');
const historyCsv = require('./historyCsv');
const historySearch = require('./historySearch');

const HISTORY_SEARCH_MAX_ROWS = 100000;
const { CsvParseError } = require('./csv');
const { message } = require('./messages');
const employeeCsv = require('./employeeCsv');
const employeeSearch = require('./employeeSearch');

/* Every route is authLevel 'function' and the app additionally restricts inbound
   traffic to the APIM gateway IP, so these handlers are never reached directly.
   Caller identity (JWT, tenant, app role) is validated by the APIM global policy. */

/* dbo.history schema:
   image_url NVARCHAR(MAX): blob URL of the image in Blob Storage (see blobImages.js);
     older rows may hold a SharePoint URL or base64
   employee_id NVARCHAR(50): snapshot of the employee code, not a foreign key
   status VARCHAR(20) CHECK (Notified | Delivered), default Notified
   data_type VARCHAR(20) CHECK (Identified | Unknown) */
const STATUSES = new Set(['Notified', 'Delivered']);
const DATA_TYPES = new Set(['Identified', 'Unknown']);

const toHistory = (row) => ({
  history_id: Number(row.history_id),
  slip_no: row.slip_no,
  image_url: row.image_url,
  sender_name: row.sender_name,
  sender_content: row.sender_content,
  sender_address: row.sender_address,
  employee_id: employeeIdOut(row.employee_id),
  recipient_name: row.recipient_name,
  recipient_department_name: row.recipient_department_name,
  status: row.status,
  data_type: row.data_type,
  notified_at: row.notified_at,
  delivered_at: row.delivered_at,
  delivered_by: row.delivered_by,
  planner_task_id: row.planner_task_id,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

/** employee_id is text. Digit-only ids that are exact in JavaScript come back as numbers. */
function employeeIdOut(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  return /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : s;
}

const toEmployee = (row) => ({
  employee_id: row.employee_id,
  full_name: row.full_name,
  department_name: row.department_name,
  email: row.email,
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
  v === undefined || v === null || v === '' ? null : (max ? String(v).slice(0, max) : String(v));

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

const FETCH_ALL = 100000;

const pageBody = (page, pageSize, totalCount, value) => ({
  page,
  pageSize,
  totalCount,
  totalPages: Math.ceil(totalCount / pageSize),
  count: value.length,
  value,
});

const paginate = (rows, page, pageSize) =>
  rows.slice((page - 1) * pageSize, page * pageSize);

/** Wraps a handler so an unexpected failure never leaks SQL detail to the client. */
const handler = (name, fn) => async (request, context) => {
  try {
    return await fn(request, context);
  } catch (e) {
    context.error(`${name} failed: ${e.message}`, e.stack);
    if (e.number === 50001) return json(400, { error: e.message });
    if (e.number === 50002 || e.number === 50003) return json(409, { error: e.message });
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
   History page with server-side pagination. Filters (see historySearch.js):
     SQL:  status, data_type, employee_id, notified_start/end, delivered_start/end
     here: slip_no, recipient_name, search_keyword (all matching rows are read, then paged)
   Each row includes sender_name, sender_content, sender_address,
   status Notified | Delivered and data_type Identified | Unknown. */

/** sp_history_list_v2 parameters for the SQL part of the History filters. */
const historySqlFilters = (f) => [
  ['status', sql.VarChar(20), f.status],
  ['data_type', sql.VarChar(20), f.dataType],
  ['employee_id', sql.NVarChar(50), f.employeeId],
  ['notified_start', sql.DateTime2, f.notifiedStart],
  ['notified_end', sql.DateTime2, f.notifiedEnd],
  ['delivered_start', sql.DateTime2, f.deliveredStart],
  ['delivered_end', sql.DateTime2, f.deliveredEnd],
];

/** Every History row matching all filters, newest first. */
async function historyMatching(f, maxRows, context, label) {
  const all = await exec('dbo.sp_history_list_v2', [
    ['page', sql.Int, 1],
    ['page_size', sql.Int, maxRows],
    ...historySqlFilters(f),
  ], context);
  if (all.length >= maxRows) context.warn(`${label}: capped at ${maxRows} rows`);
  return { all, matched: historySearch.applyRowFilters(all, f) };
}

app.http('historyList', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'history',
  handler: handler('historyList', async (request, context) => {
    const q = request.query;
    const f = historySearch.parseFilters((name) => q.get(name));
    if (f.error) return json(400, { error: f.error });

    const pageSize = clampTop(q.get('pageSize'), 50, 200);
    const pageValue = parseInt(q.get('page'), 10);
    const page = Number.isFinite(pageValue) && pageValue > 0
      ? pageValue
      : 1;

    let rows;
    let totalCount;
    if (historySearch.needsRowFilter(f)) {
      const { matched } = await historyMatching(f, HISTORY_SEARCH_MAX_ROWS, context, 'historyList');
      totalCount = matched.length;
      rows = paginate(matched, page, pageSize);
    } else {
      rows = await exec('dbo.sp_history_list_v2', [
        ['page', sql.Int, page],
        ['page_size', sql.Int, pageSize],
        ...historySqlFilters(f),
      ], context);
      totalCount = Number(rows[0]?.total_count ?? 0);
    }

    return json(200, {
      page,
      pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
      count: rows.length,
      // preview_url / image_blob_url: read-only links valid for BLOB_SAS_MINUTES,
      // null when image_url is not a blob URL.
      value: await Promise.all(rows.map(async (row) => ({
        ...toHistory(row),
        ...(await blobImages.imageLinks(row.image_url)),
      }))),
    });
  }),
});

const EXPORT_MAX_ROWS = 100000;

/* ------------------------------------------- GET /api/history/export
   CSV of the rows the History screen shows for the same filters (same parameters as
   GET /api/history, without paging), stored in Blob Storage; returns a short-lived link. */
app.http('historyExport', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'history/export',
  handler: handler('historyExport', async (request, context) => {
    if (!blobImages.enabled()) return json(503, { error: 'download is not configured (BLOB_ACCOUNT_URL)' });
    const q = request.query;
    const f = historySearch.parseFilters((name) => q.get(name));
    if (f.error) return json(400, { error: f.error });

    const { all, matched } = await historyMatching(f, EXPORT_MAX_ROWS, context, 'historyExport');
    const fileName = historyCsv.fileName(new Date(), f.tzOffset);
    const { url, expiresOn } = await blobImages.storeExport(fileName, historyCsv.buildCsv(matched, f.tzOffset));
    context.log(`historyExport: ${matched.length} of ${all.length} rows`);

    return json(200, {
      rowCount: matched.length,
      totalCount: all.length,
      searchKeyword: f.keyword,
      file: { fileName, contentType: 'text/csv', url, expiresOn },
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
    const employeeId = strOrNull(String(b.employee_id ?? '').trim(), 50);
    const slipNo = strOrNull(b.slip_no, 100);
    // image_blob_path (from POST /api/images) wins: image_url then stores its blob URL.
    const blobPath = strOrNull(b.image_blob_path, 500);
    const imageUrl = blobPath && blobImages.enabled()
      ? blobImages.imageUrlFor(blobPath)
      : (b.image_url == null || b.image_url === '' ? null : String(b.image_url));
    let dataType = strOrNull(b.data_type, 20);
    let status = strOrNull(b.status, 20);
    if (status === 'Identified' || status === 'Unknown') {
      dataType = dataType || status;
      status = 'Notified';
    }
    if (!dataType) dataType = employeeId ? 'Identified' : 'Unknown';
    if (!status) status = 'Notified';
    if (!slipNo) return json(400, { error: 'slip_no is required' });
    if (!imageUrl) return json(400, { error: 'image_url is required' });
    if (!DATA_TYPES.has(dataType)) {
      return json(400, { error: `data_type must be one of ${[...DATA_TYPES].join(', ')}` });
    }
    if (!STATUSES.has(status)) {
      return json(400, { error: `status must be one of ${[...STATUSES].join(', ')}` });
    }
    const rows = await exec('dbo.sp_history_insert_v2', [
      ['slip_no', sql.NVarChar(100), slipNo],
      ['image_url', sql.NVarChar(sql.MAX), imageUrl],
      ['sender_name', sql.NVarChar(200), strOrNull(b.sender_name, 200)],
      ['sender_content', sql.NVarChar(1000), strOrNull(b.sender_content, 1000)],
      ['sender_address', sql.NVarChar(500), strOrNull(b.sender_address, 500)],
      ['employee_id', sql.NVarChar(50), employeeId],
      ['recipient_name', sql.NVarChar(200), strOrNull(b.recipient_name, 200)],
      ['recipient_department_name', sql.NVarChar(200), strOrNull(b.recipient_department_name, 200)],
      ['status', sql.VarChar(20), status],
      ['data_type', sql.VarChar(20), dataType],
      ['notified_at', sql.DateTime2, dateOrNull(b.notified_at)],
      ['planner_task_id', sql.NVarChar(100), strOrNull(b.planner_task_id, 100)],
    ], context);
    return json(201, { history_id: Number(rows[0]?.history_id) });
  }),
});

/* ------------------------------------------------- POST /api/images
   Called by EDS-NotifySelected before POST /api/history.
   Body: { content: "<base64 or data URI>", content_type?: "image/jpeg" }
   Stores the original and a 320 px preview; returns image_url (blob URL) and
   image_blob_path / preview_blob_path.
   Only registered when BLOB_ACCOUNT_URL is set (see blobImages.js). */
if (blobImages.enabled()) {
  app.http('imageUpload', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'images',
    handler: handler('imageUpload', async (request, context) => {
      const b = await request.json().catch(() => ({}));
      const result = await blobImages.storeImage(b.content, strOrNull(b.content_type, 100));
      if (result.error) return json(400, { error: result.error });
      context.log(`imageUpload: ${result.image_blob_path} (${result.image_bytes} B), preview ${result.preview_bytes} B`);
      return json(201, result);
    }),
  });
}

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
   Filters (employeeSearch.js), each "contains": employee_id, full_name, email,
   department_name; created_start / created_end (登録日時); search_keyword (any column).
   Without a filter the page comes straight from SQL; with one, every employee is
   read, filtered here, then paged. */

/** Every employee matching the filters. */
async function employeesMatching(f, context, label) {
  const all = await exec('dbo.sp_employee_list', [
    ['page', sql.Int, 1],
    ['page_size', sql.Int, FETCH_ALL],
    ['department_name', sql.NVarChar(200), null],
    ['search_keyword', sql.NVarChar(200), null],
  ], context);
  if (all.length >= FETCH_ALL) context.warn(`${label}: capped at ${FETCH_ALL} rows`);
  return { all, matched: employeeSearch.applyFilters(all, f) };
}

app.http('employeeList', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'employees',
  handler: handler('employeeList', async (request, context) => {
    const q = request.query;
    const f = employeeSearch.parseFilters((name) => q.get(name));
    if (f.error) return json(400, { error: f.error });

    const pageSize = clampTop(q.get('pageSize'), 50, 200);
    const pageValue = parseInt(q.get('page'), 10);
    const page = Number.isFinite(pageValue) && pageValue > 0
      ? pageValue
      : 1;

    if (!employeeSearch.hasFilter(f)) {
      const rows = await exec('dbo.sp_employee_list', [
        ['page', sql.Int, page],
        ['page_size', sql.Int, pageSize],
        ['department_name', sql.NVarChar(200), null],
        ['search_keyword', sql.NVarChar(200), null],
      ], context);
      const totalCount = Number(rows[0]?.total_count ?? 0);
      return json(200, pageBody(page, pageSize, totalCount, rows.map(toEmployee)));
    }

    const { matched } = await employeesMatching(f, context, 'employeeList');
    return json(200, pageBody(page, pageSize, matched.length,
      paginate(matched, page, pageSize).map(toEmployee)));
  }),
});

/* ------------------------------------- GET /api/employees/export
   CSV of the employees matching the Employee screen's filters, except that dates are
   ignored: created_start / created_end (登録日時) are not applied. Columns are the
   import file's four: 社員番号, 社員氏名, メール, 部署 (no 登録日時 / 更新日時), so the
   file can be edited and imported again. Stored in Blob Storage; returns a short-lived link. */
app.http('employeeExport', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'employees/export',
  handler: handler('employeeExport', async (request, context) => {
    if (!blobImages.enabled()) return json(503, { error: 'download is not configured (BLOB_ACCOUNT_URL)' });
    const q = request.query;
    // The download ignores 登録日時: drop the date parameters before parsing.
    const f = employeeSearch.parseFilters((name) =>
      (name === 'created_start' || name === 'created_end' ? null : q.get(name)));
    if (f.error) return json(400, { error: f.error });

    const { all, matched } = await employeesMatching(f, context, 'employeeExport');
    const fileName = employeeSearch.fileName(new Date(), f.tzOffset);
    const { url, expiresOn } = await blobImages.storeExport(fileName, employeeSearch.buildCsv(matched));
    context.log(`employeeExport: ${matched.length} of ${all.length} rows`);

    return json(200, {
      rowCount: matched.length,
      totalCount: all.length,
      file: { fileName, contentType: 'text/csv', url, expiresOn },
    });
  }),
});

app.http('employeeImport', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'employees/import',
  handler: handler('employeeImport', async (request, context) => {
    const b = await request.json().catch(() => ({}));
    const csvText = typeof b.csv === 'string'
      ? b.csv
      : typeof b.csv_base64 === 'string' ? Buffer.from(b.csv_base64, 'base64').toString('utf8') : null;
    if (!csvText) return json(400, { error: 'csv or csv_base64 is required' });
    if (employeeCsv.tooLarge(csvText)) return json(413, { success: false, messages: [message(55)] });

    let checked;
    try {
      checked = employeeCsv.validateImport(csvText);
    } catch (e) {
      if (e instanceof CsvParseError || e instanceof employeeCsv.ImportFormatError) {
        return json(400, { error: `invalid CSV: ${e.message}` });
      }
      throw e;
    }
    if (employeeCsv.tooManyRows(checked.total)) return json(413, { success: false, messages: [message(55)] });
    if (!checked.valid.length) return json(422, employeeCsv.importResult(checked, []));

    let upserted;
    try {
      upserted = await exec('dbo.sp_employee_upsert', [
        ['rows', sql.NVarChar(sql.MAX), JSON.stringify(checked.valid.map((r) => ({
          employee_id: r.employee_id,
          full_name: r.full_name,
          email: r.email,
          department_name: r.department_name,
        })))],
      ], context);
    } catch (e) {
      if (isRetryable(e)) {
        context.error(`employeeImport: connection lost, rolled back: ${e.message}`);
        return json(503, { success: false, messages: [message(56)] });
      }
      throw e;
    }
    return json(200, employeeCsv.importResult(checked, upserted));
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
      ['department_name', sql.NVarChar(200), strOrNull(q.get('department_name'), 200)],
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

    const employeeId = strOrNull(b.employee_id, 50);
    const fullName = strOrNull(b.full_name, 200);
    const departmentName = strOrNull(b.department_name, 200);
    const email = strOrNull(b.email, 320);

    if (!employeeId) return json(400, { error: 'employee_id is required' });
    if (!fullName) return json(400, { error: 'full_name is required' });
    if (!departmentName) return json(400, { error: 'department_name is required' });
    if (!email) return json(400, { error: 'email is required' });

    const rows = await exec('dbo.sp_employee_insert', [
      ['employee_id', sql.NVarChar(50), employeeId],
      ['full_name', sql.NVarChar(200), fullName],
      ['department_name', sql.NVarChar(200), departmentName],
      ['email', sql.NVarChar(320), email],
    ], context);

    return json(201, {
      value: rows[0]
    });
  }),
});

/* ------------------------------------------ PATCH /api/employees/{id}
   Updates full_name, department_name, and email. employee_id is not changed. */
app.http('employeeUpdate', {
  methods: ['PATCH'],
  authLevel: 'function',
  route: 'employees/{id}',
  handler: handler('employeeUpdate', async (request, context) => {
    const employeeId = strOrNull(request.params.id, 50);
    const b = await request.json().catch(() => ({}));
    const fullName = strOrNull(b.full_name, 200);
    const departmentName = strOrNull(b.department_name, 200);
    const email = strOrNull(b.email, 320);

    if (!employeeId) return json(400, { error: 'id is required' });
    if (!fullName) return json(400, { error: 'full_name is required' });
    if (!departmentName) return json(400, { error: 'department_name is required' });
    if (!email) return json(400, { error: 'email is required' });

    const rows = await exec('dbo.sp_employee_update', [
      ['employee_id', sql.NVarChar(50), employeeId],
      ['full_name', sql.NVarChar(200), fullName],
      ['department_name', sql.NVarChar(200), departmentName],
      ['email', sql.NVarChar(320), email],
    ], context);
    return rows[0]
      ? json(200, { value: rows[0] })
      : json(404, { error: 'employee_id not found' });
  }),
});

/* --------------------------------------- DELETE /api/employees/{id}
   Removes the employee row. History rows keep their employee_id snapshot. */
app.http('employeeDelete', {
  methods: ['DELETE'],
  authLevel: 'function',
  route: 'employees/{id}',
  handler: handler('employeeDelete', async (request, context) => {
    const employeeId = strOrNull(request.params.id, 50);
    if (!employeeId) {
      return json(400, { error: 'id is required' });
    }

    const rows = await exec('dbo.sp_employee_delete', [
      ['employee_id', sql.NVarChar(50), employeeId],
    ], context);
    const deleted = rows[0]?.rows_deleted ?? 0;
    return deleted
      ? json(200, { deleted })
      : json(404, { error: 'employee_id not found' });
  }),
});

/* ------------------------------------------- POST /api/ocr-history
   Appends one OCR read: confirmed package fields plus raw ocr_ values. */
app.http('ocrHistoryInsert', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'ocr-history',
  handler: handler('ocrHistoryInsert', async (request, context) => {
    const b = await request.json().catch(() => ({}));
    const slipNo = strOrNull(b.slip_no, 100);
    const imageUrl = b.image_url == null || b.image_url === '' ? null : String(b.image_url);
    const dataType = strOrNull(b.data_type, 20);
    const status = strOrNull(b.status, 20) || 'Notified';
    if (!slipNo) return json(400, { error: 'slip_no is required' });
    if (!imageUrl) return json(400, { error: 'image_url is required' });
    if (!DATA_TYPES.has(dataType)) {
      return json(400, { error: 'data_type must be one of Identified, Unknown' });
    }
    if (!STATUSES.has(status)) {
      return json(400, { error: 'status must be one of Notified, Delivered' });
    }

    const rows = await exec('dbo.sp_ocr_history_insert', [
      ['history_id', sql.BigInt, intOrNull(b.history_id)],
      ['slip_no', sql.NVarChar(100), slipNo],
      ['image_url', sql.NVarChar(sql.MAX), imageUrl],
      ['sender_name', sql.NVarChar(200), strOrNull(b.sender_name, 200)],
      ['sender_content', sql.NVarChar(1000), strOrNull(b.sender_content, 1000)],
      ['sender_address', sql.NVarChar(500), strOrNull(b.sender_address, 500)],
      ['employee_id', sql.NVarChar(50), strOrNull(b.employee_id, 50)],
      ['recipient_name', sql.NVarChar(200), strOrNull(b.recipient_name, 200)],
      ['recipient_department_name', sql.NVarChar(200), strOrNull(b.recipient_department_name, 200)],
      ['status', sql.VarChar(20), status],
      ['data_type', sql.VarChar(20), dataType],
      ['notified_at', sql.DateTime2, dateOrNull(b.notified_at)],
      ['delivered_at', sql.DateTime2, dateOrNull(b.delivered_at)],
      ['delivered_by', sql.NVarChar(320), strOrNull(b.delivered_by, 320)],
      ['planner_task_id', sql.NVarChar(100), strOrNull(b.planner_task_id, 100)],
      ['ocr_receipt_name', sql.NVarChar(200), strOrNull(b.ocr_receipt_name, 200)],
      ['ocr_receipt_department', sql.NVarChar(200), strOrNull(b.ocr_receipt_department, 200)],
      ['ocr_slip_no', sql.NVarChar(100), strOrNull(b.ocr_slip_no, 100)],
      ['ocr_sender_name', sql.NVarChar(200), strOrNull(b.ocr_sender_name, 200)],
      ['ocr_sender_content', sql.NVarChar(1000), strOrNull(b.ocr_sender_content, 1000)],
      ['ocr_sender_address', sql.NVarChar(500), strOrNull(b.ocr_sender_address, 500)],
      ['ocr_model_name', sql.NVarChar(200), strOrNull(b.ocr_model_name, 200)],
    ], context);
    return json(201, { ocr_id: Number(rows[0]?.ocr_id) });
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
