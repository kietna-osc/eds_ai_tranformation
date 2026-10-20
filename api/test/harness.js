/* Loads src/index.js with @azure/functions, the database (db.js), Blob Storage
   (blobImages.js) and fuzzyMatch replaced by in-memory fakes, so handler tests need
   no npm install, no Azure and no database.

   The fake database emulates the stored procedures the handlers call:
     sp_history_list_v2  filters status / data_type / employee_id / notified_* / delivered_*
                         (inclusive, like the SQL), newest created_at first, then pages
     sp_employee_list    department_name exact (unused by the handlers now), ordered by
                         full_name, then pages
     sp_employee_upsert  INSERT / UPDATE per row (UPDATE when the id is in data.employees);
                         id DROP throws a retryable error, BOOM a non-retryable one
   Set `data.history` / `data.employees` before calling a handler. */
const Module = require('node:module');
const path = require('node:path');

const handlers = {};
const calls = [];
const stored = [];
const data = { history: [], employees: [] };

const inRange = (v, from, to) => {
  if (from === null && to === null) return true;
  if (!v) return false;
  const d = new Date(v);
  return (from === null || d >= from) && (to === null || d <= to);
};

async function exec(proc, params) {
  const p = Object.fromEntries(params.map(([n, , v]) => [n, v ?? null]));
  calls.push({ proc, p });
  let rows;
  if (proc === 'dbo.sp_history_list_v2') {
    rows = data.history.filter((r) => (p.status === null || r.status === p.status)
      && (p.data_type === null || r.data_type === p.data_type)
      && (p.employee_id === null || String(r.employee_id) === String(p.employee_id))
      && inRange(r.notified_at, p.notified_start, p.notified_end)
      && inRange(r.delivered_at, p.delivered_start, p.delivered_end))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.history_id - a.history_id);
  } else if (proc === 'dbo.sp_employee_list') {
    rows = data.employees.filter((r) => p.department_name === null || r.department_name === p.department_name)
      .sort((a, b) => a.full_name.localeCompare(b.full_name) || a.employee_id.localeCompare(b.employee_id));
  } else if (proc === 'dbo.sp_history_insert_v2') {
    return [{ history_id: 101 }];
  } else if (proc === 'dbo.sp_employee_upsert') {
    const incoming = JSON.parse(p.rows);
    if (incoming.some((r) => r.employee_id === 'DROP')) throw Object.assign(new Error('connection reset'), { retryable: true });
    if (incoming.some((r) => r.employee_id === 'BOOM')) throw new Error('deadlock');
    return incoming.map((r) => ({
      employee_id: r.employee_id,
      action: data.employees.some((e) => e.employee_id === r.employee_id) ? 'UPDATE' : 'INSERT',
    }));
  } else if (proc === 'dbo.sp_employee_update') {
    const row = data.employees.find((r) => r.employee_id === p.employee_id);
    return row ? [{ ...row, ...p }] : [];
  } else if (proc === 'dbo.sp_employee_delete') {
    if (p.employee_id === 'IN_USE') throw Object.assign(new Error('FK'), { number: 547 });
    if (p.employee_id === 'BOOM') throw new Error('connection reset');
    return [{ rows_deleted: data.employees.some((r) => r.employee_id === p.employee_id) ? 1 : 0 }];
  } else {
    throw new Error(`unexpected ${proc}`);
  }
  const total = rows.length;
  return rows.slice((p.page - 1) * p.page_size, p.page * p.page_size).map((r) => ({ ...r, total_count: total }));
}

const sqlType = () => 'type';
const sql = new Proxy(sqlType, { get: () => sqlType });
const src = (f) => path.resolve(__dirname, '../src', f);
const fakes = {
  '@azure/functions': { app: { http: (name, o) => { handlers[name] = o.handler; } } },
  [src('db.js')]: { exec, sql, isRetryable: (e) => Boolean(e.retryable) },
  [src('blobImages.js')]: {
    enabled: () => true,
    imageLinks: async () => ({}),
    storeExport: async (fileName, text) => {
      stored.push({ fileName, text });
      return { url: `https://blob/${fileName}`, expiresOn: '2026-10-13T00:15:00Z' };
    },
  },
  [src('fuzzyMatch.js')]: { fuzzyMatchEmployees: () => [] },
};

const origLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
  if (fakes[request]) return fakes[request];
  if (parent && request.startsWith('.')) {
    const full = Module._resolveFilename(request, parent);
    if (fakes[full]) return fakes[full];
  }
  return origLoad.call(this, request, parent, ...rest);
};
require('../src/index.js');
Module._load = origLoad;

const context = { log() {}, warn() {}, error() {} };

/** Calls a handler with a query (object or URLSearchParams). */
async function call(name, query) {
  calls.length = 0;
  const q = query instanceof URLSearchParams ? query : new URLSearchParams(query);
  return handlers[name]({ query: q }, context);
}

/** Calls a POST/PATCH/DELETE handler with a JSON body and optional route params. */
async function post(name, body, params = {}) {
  calls.length = 0;
  return handlers[name]({ json: async () => body, query: new URLSearchParams(), params }, context);
}

/** CSV text -> data lines (no BOM, no header, no trailing blank). */
const csvLines = (text) => text.replace(/^﻿/, '').trim().split('\r\n').slice(1);

module.exports = { handlers, calls, stored, data, call, post, csvLines };
