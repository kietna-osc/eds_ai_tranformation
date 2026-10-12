const { CsvParseError, parseCsv } = require('./csv');
const { message } = require('./messages');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;

class ImportFormatError extends Error {
  constructor(messageText) {
    super(messageText);
    this.name = 'ImportFormatError';
  }
}

const HEADERS = {
  employee_id: ['社員番号', 'employee_id'],
  full_name: ['社員氏名', 'full_name'],
  email: ['メール', 'email'],
  department_name: ['部署', 'department_name'],
};

function tooLarge(csvText) {
  return Buffer.byteLength(csvText, 'utf8') > MAX_BYTES;
}

function tooManyRows(total) {
  return total > MAX_ROWS;
}

function headerIndex(header, names) {
  const cells = header.map((h) => h.trim());
  return names.map((name) => cells.indexOf(name)).find((i) => i >= 0) ?? -1;
}

function validateImport(csvText) {
  let rows;
  try {
    rows = parseCsv(csvText);
  } catch (e) {
    if (e instanceof CsvParseError) throw e;
    throw new CsvParseError(e.message);
  }
  if (!rows.length) throw new ImportFormatError('CSV has no header');

  const header = rows[0];
  const col = {};
  for (const [key, names] of Object.entries(HEADERS)) {
    col[key] = headerIndex(header, names);
    if (col[key] < 0) throw new ImportFormatError(`missing column ${names[0]}`);
  }

  const valid = [];
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const line = rows[i];
    const item = {
      employee_id: (line[col.employee_id] || '').trim(),
      full_name: (line[col.full_name] || '').trim(),
      email: (line[col.email] || '').trim(),
      department_name: (line[col.department_name] || '').trim(),
    };
    const problems = [];
    if (!item.employee_id || item.employee_id.length > 50) problems.push('社員番号');
    if (!item.full_name || item.full_name.length > 200) problems.push('社員氏名');
    if (!item.email || item.email.length > 320) problems.push('メール');
    if (!item.department_name || item.department_name.length > 200) problems.push('部署');
    if (problems.length) errors.push({ line: i + 1, ...item, error: problems.join(', ') });
    else valid.push(item);
  }

  return { total: rows.length - 1, valid, errors };
}

function importResult(checked, upserted) {
  const inserted = upserted.filter((r) => r.action === 'INSERT').length;
  const updated = upserted.filter((r) => r.action === 'UPDATE').length;
  const messages = [];
  if (!checked.valid.length) messages.push(message(53));
  else if (checked.errors.length) messages.push(message(52));
  else messages.push(message(51));
  if (updated) messages.push(message(54));

  return {
    success: checked.valid.length > 0,
    total: checked.total,
    inserted,
    updated,
    skipped: checked.errors.length,
    messages,
    errorFile: checked.errors.length
      ? ['line,社員番号,社員氏名,メール,部署,error']
        .concat(checked.errors.map((e) =>
          [e.line, e.employee_id, e.full_name, e.email, e.department_name, e.error]
            .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))
        .join('\r\n')
      : null,
  };
}

module.exports = {
  ImportFormatError,
  tooLarge,
  tooManyRows,
  validateImport,
  importResult,
};
