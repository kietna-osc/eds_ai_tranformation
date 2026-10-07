/* History with images in Azure Blob Storage (branch feature/history-blob).

   Registered from index.js only when BLOB_ACCOUNT_URL is set, so an app without
   that setting (func-eds-dev) exposes exactly the same routes as before.

   POST /api/blob/images    stores the original image and a 320 px JPEG preview
   POST /api/blob/history   appends a package to dbo.history_blob
   GET  /api/blob/history   lists dbo.history_blob, with short-lived read links

   The container is private. The database stores blob paths only; historyList
   turns them into read-only SAS links signed with a user delegation key, so no
   storage account key is used anywhere. The Function App's managed identity
   needs "Storage Blob Data Contributor" on the storage account.

   App settings:
     BLOB_ACCOUNT_URL       https://<account>.blob.core.windows.net
     BLOB_CONTAINER         container name (default history-images)
     BLOB_SAS_MINUTES       lifetime of read links (default 60)
     BLOB_PREVIEW_WIDTH     preview width in px (default 320) */

const { randomUUID } = require('crypto');
const { DefaultAzureCredential } = require('@azure/identity');
const {
  BlobServiceClient,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
} = require('@azure/storage-blob');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_TO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heif': 'heic', 'image/gif': 'gif' };
const SHARP_TO_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heif: 'image/heif', gif: 'image/gif' };

const accountUrl = process.env.BLOB_ACCOUNT_URL;
const containerName = process.env.BLOB_CONTAINER || 'history-images';
const sasMinutes = Number(process.env.BLOB_SAS_MINUTES) || 60;
const previewWidth = Number(process.env.BLOB_PREVIEW_WIDTH) || 320;

let serviceClient = null;
const service = () => {
  if (!serviceClient) serviceClient = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
  return serviceClient;
};
const container = () => service().getContainerClient(containerName);

// A user delegation key is valid for up to 7 days; request one for a day and
// reuse it until an hour before it expires.
let delegation = null;
async function delegationKey() {
  const now = Date.now();
  if (delegation && delegation.renewAfter > now) return delegation.key;
  const startsOn = new Date(now - 5 * 60 * 1000);
  const expiresOn = new Date(now + 24 * 60 * 60 * 1000);
  const key = await service().getUserDelegationKey(startsOn, expiresOn);
  delegation = { key, renewAfter: expiresOn.getTime() - 60 * 60 * 1000 };
  return key;
}

/** Read-only https link to one blob, valid for BLOB_SAS_MINUTES. */
async function readUrl(blobPath) {
  if (!blobPath) return null;
  const key = await delegationKey();
  const now = Date.now();
  const sas = generateBlobSASQueryParameters({
    containerName,
    blobName: blobPath,
    permissions: BlobSASPermissions.parse('r'),
    startsOn: new Date(now - 5 * 60 * 1000),
    expiresOn: new Date(now + sasMinutes * 60 * 1000),
    protocol: SASProtocol.Https,
  }, key, new URL(accountUrl).hostname.split('.')[0]);
  return `${container().getBlobClient(blobPath).url}?${sas.toString()}`;
}

/** Accepts plain base64 or a data URI; returns { buffer, mime } or { error }. */
function decodeImage(content, contentType) {
  if (typeof content !== 'string' || !content) return { error: 'content (base64 image) is required' };
  let mime = contentType;
  let data = content;
  const m = /^data:([^;,]+)?(;base64)?,/.exec(content);
  if (m) {
    if (!m[2]) return { error: 'data URI must be base64-encoded' };
    mime = mime || m[1];
    data = content.slice(m[0].length);
  }
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length) return { error: 'content is not valid base64' };
  if (buffer.length > MAX_IMAGE_BYTES) return { error: `image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB` };
  return { buffer, mime };
}

module.exports = function registerHistoryBlob({
  app, exec, sql, json, handler, intOrNull, strOrNull, dateOrNull, clampTop, STATUSES, toHistory,
}) {
  /* ------------------------------------------------ POST /api/blob/images
     Body: { content: "<base64 or data URI>", content_type?: "image/jpeg" }
     Returns the two blob paths to pass to POST /api/blob/history. */
  app.http('blobImageUpload', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'blob/images',
    handler: handler('blobImageUpload', async (request, context) => {
      const b = await request.json().catch(() => ({}));
      const decoded = decodeImage(b.content, strOrNull(b.content_type, 100));
      if (decoded.error) return json(400, { error: decoded.error });

      // Loaded here, not at startup, so a problem with the native module can only
      // affect this route.
      const sharp = require('sharp');
      let meta;
      try {
        meta = await sharp(decoded.buffer).metadata();
      } catch {
        return json(400, { error: 'content is not a supported image' });
      }
      const mime = SHARP_TO_MIME[meta.format] || decoded.mime || 'application/octet-stream';
      const ext = MIME_TO_EXT[mime] || 'bin';

      // .rotate() applies the EXIF orientation, so phone photos are not sideways.
      const preview = await sharp(decoded.buffer)
        .rotate()
        .resize({ width: previewWidth, withoutEnlargement: true })
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer();

      const now = new Date();
      const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      const id = randomUUID();
      const imagePath = `${folder}/${id}.${ext}`;
      const previewPath = `${folder}/${id}_preview.jpg`;

      const cc = container();
      await cc.getBlockBlobClient(imagePath).uploadData(decoded.buffer, {
        blobHTTPHeaders: { blobContentType: mime },
      });
      await cc.getBlockBlobClient(previewPath).uploadData(preview, {
        blobHTTPHeaders: { blobContentType: 'image/jpeg' },
      });
      context.log(`blobImageUpload: ${imagePath} (${decoded.buffer.length} B), preview ${preview.length} B`);

      return json(201, {
        image_blob_path: imagePath,
        preview_blob_path: previewPath,
        content_type: mime,
        width: meta.width ?? null,
        height: meta.height ?? null,
        image_bytes: decoded.buffer.length,
        preview_bytes: preview.length,
      });
    }),
  });

  /* ------------------------------------------------ POST /api/blob/history
     Same body as POST /api/history, plus image_blob_path and preview_blob_path. */
  app.http('blobHistoryInsert', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'blob/history',
    handler: handler('blobHistoryInsert', async (request, context) => {
      const b = await request.json().catch(() => ({}));
      const employeeId = intOrNull(b.employee_id);
      const status = strOrNull(b.status, 20) || (employeeId ? 'Identified' : 'Unknown');
      if (!STATUSES.has(status)) {
        return json(400, { error: `status must be one of ${[...STATUSES].join(', ')}` });
      }
      const rows = await exec('dbo.sp_history_blob_insert', [
        ['slip_no', sql.NVarChar(100), strOrNull(b.slip_no, 100)],
        ['image_url', sql.NVarChar(sql.MAX), strOrNull(b.image_url)],
        ['image_blob_path', sql.NVarChar(500), strOrNull(b.image_blob_path, 500)],
        ['preview_blob_path', sql.NVarChar(500), strOrNull(b.preview_blob_path, 500)],
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

  /* ------------------------------------------------- GET /api/blob/history
     Same query parameters and response as GET /api/history. Each row also has
     image_blob_path / preview_blob_path, and image_blob_url / preview_url:
     read-only links valid for BLOB_SAS_MINUTES (null when the row has no blob). */
  app.http('blobHistoryList', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'blob/history',
    handler: handler('blobHistoryList', async (request, context) => {
      const q = request.query;
      const status = strOrNull(q.get('status'), 20);
      const dates = {};
      for (const name of ['notified_start', 'notified_end', 'delivered_start', 'delivered_end']) {
        dates[name] = dateOrNull(q.get(name));
        if (q.get(name) && !dates[name]) return json(400, { error: `${name} must be a valid datetime` });
      }
      if (status && !STATUSES.has(status)) {
        return json(400, { error: `status must be one of ${[...STATUSES].join(', ')}` });
      }
      const pageSize = clampTop(q.get('pageSize'), 50, 200);
      const pageValue = parseInt(q.get('page'), 10);
      const page = Number.isFinite(pageValue) && pageValue > 0 ? pageValue : 1;

      const rows = await exec('dbo.sp_history_blob_list', [
        ['page', sql.Int, page],
        ['page_size', sql.Int, pageSize],
        ['status', sql.VarChar(20), status],
        ['department_id', sql.Int, intOrNull(q.get('department_id'))],
        ['employee_id', sql.Int, intOrNull(q.get('employee_id'))],
        ['notified_start', sql.DateTime2, dates.notified_start],
        ['notified_end', sql.DateTime2, dates.notified_end],
        ['delivered_start', sql.DateTime2, dates.delivered_start],
        ['delivered_end', sql.DateTime2, dates.delivered_end],
      ], context);

      const totalCount = Number(rows[0]?.total_count ?? 0);
      const value = await Promise.all(rows.map(async (row) => ({
        ...toHistory(row),
        image_blob_path: row.image_blob_path ?? null,
        preview_blob_path: row.preview_blob_path ?? null,
        image_blob_url: await readUrl(row.image_blob_path),
        preview_url: await readUrl(row.preview_blob_path),
      })));

      return json(200, {
        page,
        pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
        count: rows.length,
        value,
      });
    }),
  });
};
