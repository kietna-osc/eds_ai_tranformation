const { app } = require('@azure/functions');
const { exec, sql, isRetryable } = require('./db');
const { fuzzyMatchEmployees } = require('./fuzzyMatch');
const blobImages = require('./blobImages');
const historyCsv = require('./historyCsv');
const historySearch = require('./historySearch');
const plannerSync = require('./plannerSync');

const HISTORY_SEARCH_MAX_ROWS = 100000;
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
   data_type VARCHAR(20) CHECK (Identified | Unknown)
   Rows are never updated: each change of the Planner task adds a row (version) with
   the same planner_task_id, and ocr_history gets a matching row (21_history_versions.sql).
   The list procedure returns the latest version of each package, with history_id =
   the package's first row (stable), created_at = registered, updated_at = last change. */
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
    if (e.number === 50004) return json(409, { error: e.message }); // planner sync: too many reverts
    if (e.number === 547) {
      return json(409, {
        error: 'この従業員は履歴データで使用されているため削除できません',
      });
    }
    if (e.number === 2627 || e.number === 2601) {
      return json(409, { error: '同じデータが既に登録されています' });
    }
    return json(500, {
      error: `サーバーでエラーが発生しました。時間をおいて再度お試しください。（requestId: ${context.invocationId}）`,
      requestId: context.invocationId,
    });
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
      // who pressed Register: stored on the ocr_history row the proc writes with it
      ['operator_name', sql.NVarChar(200), strOrNull(b.operator_name, 200)],
      ['operator_email', sql.NVarChar(320), strOrNull(b.operator_email, 320)],
      // what the OCR read before the operator edited it: also only on ocr_history
      ['ocr_receipt_name', sql.NVarChar(200), strOrNull(b.ocr_receipt_name, 200)],
      ['ocr_receipt_department', sql.NVarChar(200), strOrNull(b.ocr_receipt_department, 200)],
      ['ocr_slip_no', sql.NVarChar(100), strOrNull(b.ocr_slip_no, 100)],
      ['ocr_sender_name', sql.NVarChar(200), strOrNull(b.ocr_sender_name, 200)],
      ['ocr_sender_content', sql.NVarChar(1000), strOrNull(b.ocr_sender_content, 1000)],
      ['ocr_sender_address', sql.NVarChar(500), strOrNull(b.ocr_sender_address, 500)],
      ['ocr_model_name', sql.NVarChar(200), strOrNull(b.ocr_model_name, 200)],
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
   Links the Planner task created by the flow back to a package registered without
   one, which is what makes the completion lookup in sp_set_delivered possible. A
   package that already has a task is never relinked (404). */
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
   Called by the "When a task is completed" Planner flow. Adds a Delivered version of
   the package. Idempotent: when the package is already Delivered nothing is added, so
   a duplicate trigger is harmless. */
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
      ['delivered_at', sql.DateTime2, dateOrNull(b.delivered_at)],
    ], context);
    const updated = rows[0]?.rows_updated ?? 0;
    // 404 tells the flow the task was never linked to a package - worth alerting on.
    return updated ? json(200, { updated }) : json(404, { error: 'no matching package' });
  }),
});

/* ------------------------------------- POST /api/history/planner-sync
   Daily reconciliation run by the scheduled flow EDS-PlannerStatusSync: a task reopened
   in Planner adds a Notified version, a completion the trigger missed a Delivered one.
   Request checks and the safety rules are described in plannerSync.js.
   200 { checked, reverted, delivered, duplicates }
   409 when more rows than max_revert would be reverted (nothing is changed). */
app.http('historyPlannerSync', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'history/planner-sync',
  handler: handler('historyPlannerSync', async (request, context) => {
    const body = await request.json().catch(() => null);
    const syncRequest = plannerSync.readPlannerSyncRequest(body);
    if (syncRequest.error) return json(400, { error: syncRequest.error });

    const rows = await exec('dbo.sp_history_planner_sync', [
      ['tasks_json', sql.NVarChar(sql.MAX), JSON.stringify(syncRequest.tasks)],
      ['snapshot_at', sql.DateTime2, syncRequest.snapshotAt],
      ['max_revert', sql.Int, syncRequest.maxRevert],
    ], context);

    const counts = rows[0] || {};
    const result = {
      checked: counts.checked_count ?? 0,
      reverted: counts.reverted_count ?? 0,
      delivered: counts.delivered_count ?? 0,
      duplicates: syncRequest.duplicateCount,
    };
    context.log(`historyPlannerSync: checked ${result.checked}, reverted ${result.reverted}, `
      + `delivered ${result.delivered}, duplicates ${result.duplicates}`);
    return json(200, result);
  }),
});

/* ------------------------------------- GET /api/employees
   Employee page with server-side pagination, same shape as historyList.
   Filters (employeeSearch.js), each "contains": employee_id, full_name, email,
   department_name; created_start / created_end (登録日時); search_keyword (the result
   screen's search box: words in 社員番号 / 社員氏名 / メール / 部署).
   Every employee is read, filtered and sorted here (employee_id descending, newest
   first, or best keyword match first; the order of sp_employee_list, by full_name, is
   not used), then paged. */

/** Every employee matching the filters, in screen order. */
async function employeesMatching(f, context, label) {
  const all = await exec('dbo.sp_employee_list', [
    ['page', sql.Int, 1],
    ['page_size', sql.Int, FETCH_ALL],
    ['department_name', sql.NVarChar(200), null],
    ['search_keyword', sql.NVarChar(200), null],
  ], context);
  if (all.length >= FETCH_ALL) context.warn(`${label}: capped at ${FETCH_ALL} rows`);
  return { all, matched: employeeSearch.sortRows(employeeSearch.applyFilters(all, f), f) };
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

    const { matched } = await employeesMatching(f, context, 'employeeList');
    return json(200, pageBody(page, pageSize, matched.length,
      paginate(matched, page, pageSize).map(toEmployee)));
  }),
});

/* ------------------------------------- GET /api/employees/export
   CSV of the employees matching the Employee screen's filters, 登録日時 included, so the
   file has the same rows as the list. Columns are the import file's four: 社員番号, 社員氏名,
   メール, 部署 (no 登録日時 / 更新日時), so the file can be edited and imported again.
   Stored in Blob Storage; returns a short-lived link. */
app.http('employeeExport', {
  methods: ['GET'],
  authLevel: 'function',
  route: 'employees/export',
  handler: handler('employeeExport', async (request, context) => {
    if (!blobImages.enabled()) return json(503, { error: 'download is not configured (BLOB_ACCOUNT_URL)' });
    const f = employeeSearch.parseFilters((name) => request.query.get(name));
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
  /* Body: { csv_base64 | csv, file_name?, tz_offset? }. Every response has the same shape
     (employeeCsv.js header): status / title / message are what the app popup shows.
     HTTP: 200 success or partial, 422 every row invalid (53), 400 unreadable file (50),
     413 too large (55), 503 connection lost (56), 500 unexpected. The cause is logged. */
  handler: handler('employeeImport', async (request, context) => {
    const b = await request.json().catch(() => ({}));
    const upload = typeof b.csv === 'string' ? { text: b.csv, form: 'csv' } : employeeCsv.decodeUpload(b.csv_base64);
    const csvText = upload.text;
    const fileName = typeof b.file_name === 'string' ? b.file_name : '';
    if (upload.form !== 'base64' && upload.form !== 'csv') {
      context.warn(`employeeImport: csv_base64 received as ${upload.form}; the flow should send the trigger's contentBytes`);
    }

    const storeErrorFile = async (csv) => {
      if (!blobImages.enabled()) return null;
      try {
        const name = employeeCsv.errorFileName(new Date(), Number(b.tz_offset ?? -540) || 0);
        const { url } = await blobImages.storeExport(name, csv);
        return { fileName: name, url };
      } catch (e) {
        context.error(`employeeImport: error file not stored: ${e.message}`);
        return null;
      }
    };

    let checked;
    try {
      employeeCsv.checkFile(fileName, csvText);
      checked = employeeCsv.validateImport(csvText);
    } catch (e) {
      if (!(e instanceof employeeCsv.ImportError)) throw e;
      // Wrong header: the file comes back with the cause on its header line.
      const errorFile = e.file ? await storeErrorFile(employeeCsv.errorFileCsv(e.file)) : null;
      context.warn(`employeeImport: ${e.httpStatus} ${e.message}`);
      return json(e.httpStatus, employeeCsv.failure(e.code, e.reason, errorFile));
    }

    /* 社員番号 already registered, or email used twice in the file / by another employee
       (ErrorDesign 47) -> row errors; existing employees are never overwritten (Skip案). */
    if (checked.valid.length) {
      let dbRows;
      try {
        dbRows = await exec('dbo.sp_employee_list', [
          ['page', sql.Int, 1],
          ['page_size', sql.Int, FETCH_ALL],
          ['department_name', sql.NVarChar(200), null],
          ['search_keyword', sql.NVarChar(200), null],
        ], context);
      } catch (e) {
        context.error(`employeeImport: employee list failed: ${e.message}`);
        return json(isRetryable(e) ? 503 : 500, employeeCsv.failure(isRetryable(e) ? 56 : 'unexpected'));
      }
      employeeCsv.markDbConflicts(checked, dbRows);
    }

    /* More error rows than the popup lists -> a CSV of every error in Blob Storage. If it
       cannot be stored, the popup lists the first rows instead (logged). */
    const errorFile = employeeCsv.needsErrorFile(checked) ? await storeErrorFile(employeeCsv.errorCsv(checked)) : null;
    if (!checked.valid.length) return json(422, employeeCsv.importResult(checked, [], errorFile));

    let upserted;
    try {
      upserted = await exec('dbo.sp_employee_upsert', [
        ['rows', sql.NVarChar(sql.MAX), JSON.stringify(employeeCsv.upsertRows(checked))],
      ], context);
    } catch (e) {
      if (isRetryable(e)) {
        context.error(`employeeImport: connection lost, rolled back: ${e.message}`);
        return json(503, employeeCsv.failure(56));
      }
      context.error(`employeeImport failed: ${e.message}`, e.stack);
      return json(500, employeeCsv.failure('unexpected'));
    }
    return json(200, employeeCsv.importResult(checked, upserted, errorFile));
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

/* employeeUpdate / employeeDelete error texts are Japanese: the flow passes "error"
   straight to the app popup (same as employeeInsert). */
const EMPLOYEE_NOT_FOUND = '指定された社員IDの従業員が見つかりません。一覧を更新してください。';
/* Same text as THROW 50003 in sp_employee_insert. */
const EMAIL_IN_USE = 'このメールアドレスは既に他の従業員に使用されている';

/** True when another employee already has this email (trimmed, case-insensitive).
 *  sp_employee_update has no such check and SQL is frozen, so it is done here:
 *  sp_employee_list's keyword (a LIKE on email, among others) narrows the rows,
 *  the exact comparison is made in JS. */
async function emailUsedByOther(email, employeeId, context) {
  const wanted = email.trim().toLowerCase();
  const rows = await exec('dbo.sp_employee_list', [
    ['page', sql.Int, 1],
    ['page_size', sql.Int, FETCH_ALL],
    ['department_name', sql.NVarChar(200), null],
    ['search_keyword', sql.NVarChar(200), wanted.length <= 200 ? wanted : null],
  ], context);
  return rows.some((r) => String(r.employee_id) !== employeeId
    && String(r.email ?? '').trim().toLowerCase() === wanted);
}

/* ------------------------------------------ PATCH /api/employees/{id}
   Updates full_name, department_name, and email. employee_id is not changed.
   409 when another employee already uses the email. */
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

    if (!employeeId) return json(400, { error: '社員IDが指定されていません' });
    if (!fullName) return json(400, { error: '名前が指定されていません' });
    if (!departmentName) return json(400, { error: '部署が指定されていません' });
    if (!email) return json(400, { error: 'メールが指定されていません' });
    if (await emailUsedByOther(email, employeeId, context)) {
      return json(409, { error: EMAIL_IN_USE });
    }

    const rows = await exec('dbo.sp_employee_update', [
      ['employee_id', sql.NVarChar(50), employeeId],
      ['full_name', sql.NVarChar(200), fullName],
      ['department_name', sql.NVarChar(200), departmentName],
      ['email', sql.NVarChar(320), email],
    ], context);
    return rows[0]
      ? json(200, { value: rows[0] })
      : json(404, { error: EMPLOYEE_NOT_FOUND });
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
      return json(400, { error: '社員IDが指定されていません' });
    }

    const rows = await exec('dbo.sp_employee_delete', [
      ['employee_id', sql.NVarChar(50), employeeId],
    ], context);
    const deleted = rows[0]?.rows_deleted ?? 0;
    return deleted
      ? json(200, { deleted })
      : json(404, { error: EMPLOYEE_NOT_FOUND });
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
