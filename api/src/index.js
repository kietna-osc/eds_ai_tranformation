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

/* Every route is authLevel 'function' and the app additionally restricts inbound
   traffic to the APIM gateway IP, so these handlers are never reached directly.
   Caller identity (JWT, tenant, app role) is validated by the APIM global policy. */

/* dbo.history schema:
   image_url NVARCHAR(MAX): SharePoint URL or relative path of the scanned image
   image_blob_path / preview_blob_path NVARCHAR(500): original and 320 px preview in Blob Storage
   employee_id NVARCHAR(50): text, like dbo.employee; some ids do not fit in INT (e.g. 10000000004)
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
  // The EDS-APIManagement1 Parse JSON schema expects integer | null, so digit-only ids
  // (stored as text) are returned as numbers.
  employee_id: employeeIdOut(row.employee_id),
  recipient_name: row.recipient_name,
  recipient_department_id: row.recipient_department_id,
  recipient_department_name: row.recipient_department_name,
  status: row.status,
  notified_at: row.notified_at,
  delivered_at: row.delivered_at,
  delivered_by: row.delivered_by,
  planner_task_id: row.planner_task_id,
  created_at: row.created_at,
  updated_at: row.updated_at,
  image_blob_path: row.image_blob_path ?? null,
  preview_blob_path: row.preview_blob_path ?? null,
});

/** employee_id is text. Digit-only ids that are exact in JavaScript come back as numbers. */
function employeeIdOut(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  return /^\d+$/.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : s;
}

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

/* ------------------------------------------------- keyword search
   The list procedures cannot be changed for now, so keyword search runs here:
   fetch every row matching the SQL filters, filter by keyword, then page.
   Paging is always the last step, so totalCount / totalPages describe the
   keyword matches. */
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

// NFKC (full-width -> half-width), case-insensitive, whitespace ignored, so
// "林健太" matches "林 健太" and "２０２６" matches "2026".
const normalizeSearch = (v) =>
  String(v ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');

const matchesKeyword = (keyword, fields) =>
  fields.some((f) => normalizeSearch(f).includes(keyword));

// Employee: 社員番号, 社員氏名, Eメール, 部署.
const employeeMatches = (keyword) => (row) => matchesKeyword(keyword, [
  row.employee_code,
  row.full_name,
  row.email,
  row.department_name,
]);

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
   sender_content, sender_address and status Unknown | Identified.
   search_keyword (optional): the History search (historySearch.js) on 伝票番号, 受取人,
   処理状況, データ区分 and 通知日時; totalCount / totalPages then describe the matches.
   tz_offset (optional): Power Fx TimeZoneOffset() for the 通知日時 match, default Japan. */
app.http('historyList', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'history',
  handler: handler('historyList', async (request, context) => {
    const q = request.query;

    const status = strOrNull(q.get('status'), 20);
    const employeeId = strOrNull(q.get('employee_id'), 50);
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

    const filters = [
      ['status', sql.VarChar(20), status],
      ['department_id', sql.Int, departmentId],
      ['employee_id', sql.NVarChar(50), employeeId],
      ['notified_start', sql.DateTime2, notifiedStart],
      ['notified_end', sql.DateTime2, notifiedEnd],
      ['delivered_start', sql.DateTime2, deliveredStart],
      ['delivered_end', sql.DateTime2, deliveredEnd],
    ];

    /* search_keyword: the History search (historySearch.js) over the rows matching the
       other filters, then this page. Without it, SQL pages directly. Either way read
       links are only signed for the rows returned. */
    const keyword = strOrNull(String(q.get('search_keyword') ?? '').trim(), 200);
    let rows;
    let totalCount;
    if (keyword) {
      const tzOffset = historySearch.tzOffsetOrDefault(q.get('tz_offset'));
      const all = await exec('dbo.sp_history_list_v2', [
        ['page', sql.Int, 1],
        ['page_size', sql.Int, HISTORY_SEARCH_MAX_ROWS],
        ...filters,
      ], context);
      if (all.length >= HISTORY_SEARCH_MAX_ROWS) context.warn(`historyList: search capped at ${HISTORY_SEARCH_MAX_ROWS} rows`);
      const matched = historySearch.filterRows(all, keyword, tzOffset);
      totalCount = matched.length;
      rows = matched.slice((page - 1) * pageSize, page * pageSize);
    } else {
      rows = await exec('dbo.sp_history_list_v2', [
        ['page', sql.Int, page],
        ['page_size', sql.Int, pageSize],
        ...filters,
      ], context);
      totalCount = Number(rows[0]?.total_count ?? 0);
    }

    return json(200, {
      page,
      pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
      count: rows.length,
      // preview_url / image_blob_url: read-only links valid for BLOB_SAS_MINUTES, null without a blob.
      value: await Promise.all(rows.map(async (row) => ({
        ...toHistory(row),
        image_blob_url: await blobImages.readUrl(row.image_blob_path),
        preview_url: await blobImages.readUrl(row.preview_blob_path),
      }))),
    });
  }),
});

/* ------------------------------------------ GET /api/history/export
   History screen → ダウンロード. Every row, or with search_keyword only the rows
   the screen's search shows (see historyCsv.js), as a CSV file in Blob Storage.
   Returns a short-lived download link for the app's Download().
   tz_offset: Power Fx TimeZoneOffset(), so the times match the screen. */
const EXPORT_MAX_ROWS = 100000;

app.http('historyExport', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'history/export',
  handler: handler('historyExport', async (request, context) => {
    if (!blobImages.enabled()) return json(503, { error: 'download is not configured (BLOB_ACCOUNT_URL)' });
    const q = request.query;
    const searchKeyword = strOrNull(String(q.get('search_keyword') ?? '').trim(), 200);
    const tzOffset = historyCsv.tzOffsetOrDefault(q.get('tz_offset'));

    const rows = await exec('dbo.sp_history_list_v2', [
      ['page', sql.Int, 1],
      ['page_size', sql.Int, EXPORT_MAX_ROWS],
    ], context);
    if (rows.length >= EXPORT_MAX_ROWS) context.warn(`historyExport: capped at ${EXPORT_MAX_ROWS} rows`);

    const matched = historyCsv.filterRows(rows, searchKeyword, tzOffset);
    const fileName = historyCsv.fileName(new Date(), tzOffset);
    const { url, expiresOn } = await blobImages.storeExport(fileName, historyCsv.buildCsv(matched, tzOffset));
    context.log(`historyExport: ${matched.length} of ${rows.length} rows, keyword ${searchKeyword ? 'set' : 'none'}`);

    return json(200, {
      rowCount: matched.length,
      totalCount: rows.length,
      searchKeyword,
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
    const status = strOrNull(b.status, 20) || (employeeId ? 'Identified' : 'Unknown');
    if (!STATUSES.has(status)) {
      return json(400, { error: `status must be one of ${[...STATUSES].join(', ')}` });
    }
    const rows = await exec('dbo.sp_history_insert_v2', [
      ['slip_no', sql.NVarChar(100), strOrNull(b.slip_no, 100)],
      // Not length-capped, to match the NVARCHAR(MAX) column and parameter.
      ['image_url', sql.NVarChar(sql.MAX), strOrNull(b.image_url)],
      ['image_blob_path', sql.NVarChar(500), strOrNull(b.image_blob_path, 500)],
      ['preview_blob_path', sql.NVarChar(500), strOrNull(b.preview_blob_path, 500)],
      ['sender_name', sql.NVarChar(200), strOrNull(b.sender_name, 200)],
      ['sender_content', sql.NVarChar(1000), strOrNull(b.sender_content, 1000)],
      ['sender_address', sql.NVarChar(500), strOrNull(b.sender_address, 500)],
      ['employee_id', sql.NVarChar(50), employeeId],
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

/* ------------------------------------------------- POST /api/images
   Called by EDS-NotifySelected before POST /api/history.
   Body: { content: "<base64 or data URI>", content_type?: "image/jpeg" }
   Stores the original and a 320 px preview; returns image_blob_path / preview_blob_path.
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
   department_id filters by department; search_keyword is a contains match on
   社員番号 (employee_code), 社員氏名 (full_name), Eメール (email) and 部署
   (department_name). Other columns do not match. */
app.http('employeeList', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'employees',
  handler: handler('employeeList', async (request, context) => {
    const q = request.query;

    const departmentId = intOrNull(q.get('department_id'));
    const keyword = normalizeSearch(q.get('search_keyword'));

    const pageSize = clampTop(q.get('pageSize'), 50, 200);

    const pageValue = parseInt(q.get('page'), 10);
    const page = Number.isFinite(pageValue) && pageValue > 0
      ? pageValue
      : 1;

    if (!keyword) {
      const rows = await exec('dbo.sp_employee_list', [
        ['page', sql.Int, page],
        ['page_size', sql.Int, pageSize],
        ['department_id', sql.Int, departmentId],
        ['search_keyword', sql.NVarChar(200), null],
      ], context);
      const totalCount = Number(rows[0]?.total_count ?? 0);
      return json(200, pageBody(page, pageSize, totalCount, rows.map(toEmployee)));
    }

    // Keyword: the procedure's own keyword match is prefix-only on employee_code,
    // so fetch every row (same order), match here, then page.
    const all = await exec('dbo.sp_employee_list', [
      ['page', sql.Int, 1],
      ['page_size', sql.Int, FETCH_ALL],
      ['department_id', sql.Int, departmentId],
      ['search_keyword', sql.NVarChar(200), null],
    ], context);
    if (all.length >= FETCH_ALL) context.warn(`employeeList: keyword search capped at ${FETCH_ALL} rows`);
    const matched = all.filter(employeeMatches(keyword));
    return json(200, pageBody(page, pageSize, matched.length,
      paginate(matched, page, pageSize).map(toEmployee)));
  }),
});

/* ------------------------------------ POST /api/employees/import
   CSV import (messages 51-56). Body: { "csv": "<file text>" } or
   { "csv_base64": "<file content>" }. Columns: 社員番号,社員氏名,メール,部署.
   Each row is validated on its own; valid rows are upserted by employee_code
   (existing code -> updated, new code -> inserted) in one transaction, invalid
   rows are skipped and returned as errorFile.
     200  some or all rows written: messages 51 or 52, plus 54 when codes were updated
     413  file too large / too many rows: message 55
     422  every row invalid, nothing written: message 53
     503  connection lost while writing, transaction rolled back: message 56
     400  not a readable CSV or a required column is missing (no message id yet) */
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
          employee_code: r.employee_code,
          full_name: r.full_name,
          email: r.email,
          department_name: r.department_name,
        })))],
      ], context);
    } catch (e) {
      // The procedure runs with XACT_ABORT in one transaction, so nothing was kept.
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
