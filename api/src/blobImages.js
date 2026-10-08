/* Scanned images in Azure Blob Storage.

   POST /api/images stores the original and a 320 px JPEG preview; dbo.history keeps
   the two blob paths. historyList turns the paths into short-lived, read-only SAS
   links signed with a user delegation key, so no storage account key is used.
   The container is private.

   Needs the Function App's managed identity to have "Storage Blob Data Contributor"
   on the storage account. Without BLOB_ACCOUNT_URL, enabled() is false: the image
   route is not registered and history rows come back without links.

   App settings:
     BLOB_ACCOUNT_URL       https://<account>.blob.core.windows.net
     BLOB_CONTAINER         container name (default history-images)
     BLOB_SAS_MINUTES       lifetime of read links (default 60)
     BLOB_PREVIEW_WIDTH     preview width in px (default 320)
     BLOB_EXPORT_CONTAINER  container for History CSV downloads (default history-exports)
     BLOB_EXPORT_SAS_MINUTES lifetime of download links (default 15) */

const { randomUUID } = require('crypto');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIME_TO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heif': 'heic', 'image/gif': 'gif' };
const SHARP_TO_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heif: 'image/heif', gif: 'image/gif' };

const accountUrl = process.env.BLOB_ACCOUNT_URL;
const containerName = process.env.BLOB_CONTAINER || 'history-images';
const sasMinutes = Number(process.env.BLOB_SAS_MINUTES) || 60;
const previewWidth = Number(process.env.BLOB_PREVIEW_WIDTH) || 320;
const exportContainerName = process.env.BLOB_EXPORT_CONTAINER || 'history-exports';
const exportSasMinutes = Number(process.env.BLOB_EXPORT_SAS_MINUTES) || 15;

const enabled = () => Boolean(accountUrl);

// Loaded on first use, so an app without the setting never loads the storage SDK.
let blob = null;
let serviceClient = null;
function service() {
  if (!serviceClient) {
    blob = require('@azure/storage-blob');
    const { DefaultAzureCredential } = require('@azure/identity');
    serviceClient = new blob.BlobServiceClient(accountUrl, new DefaultAzureCredential());
  }
  return serviceClient;
}
const container = () => service().getContainerClient(containerName);

// A user delegation key is valid for up to 7 days; request one for a day and
// reuse it until an hour before it expires.
let delegation = null;
async function delegationKey() {
  const now = Date.now();
  if (delegation && delegation.renewAfter > now) return delegation.key;
  const expiresOn = new Date(now + 24 * 60 * 60 * 1000);
  const key = await service().getUserDelegationKey(new Date(now - 5 * 60 * 1000), expiresOn);
  delegation = { key, renewAfter: expiresOn.getTime() - 60 * 60 * 1000 };
  return key;
}

/** Read-only https link to one blob, valid for BLOB_SAS_MINUTES; null without a path. */
async function readUrl(blobPath) {
  if (!blobPath || !enabled()) return null;
  return signedUrl(containerName, blobPath, sasMinutes);
}

/* Signs a read-only link. With fileName, the browser saves the blob under that
   name instead of showing it (Content-Disposition: attachment). */
async function signedUrl(containerNameForLink, blobPath, minutes, fileName) {
  const key = await delegationKey();
  const now = Date.now();
  const expiresOn = new Date(now + minutes * 60 * 1000);
  const sas = blob.generateBlobSASQueryParameters({
    containerName: containerNameForLink,
    blobName: blobPath,
    permissions: blob.BlobSASPermissions.parse('r'),
    startsOn: new Date(now - 5 * 60 * 1000),
    expiresOn,
    protocol: blob.SASProtocol.Https,
    ...(fileName ? { contentDisposition: `attachment; filename="${fileName}"` } : {}),
  }, key, new URL(accountUrl).hostname.split('.')[0]);
  const url = `${service().getContainerClient(containerNameForLink).getBlobClient(blobPath).url}?${sas.toString()}`;
  return fileName ? { url, expiresOn } : url;
}

/** Stores a CSV download (fileName must be ASCII) and returns { url, expiresOn }:
 *  a read-only link valid for BLOB_EXPORT_SAS_MINUTES. The container is private;
 *  a lifecycle rule on the storage account removes old files. */
async function storeExport(fileName, text) {
  const now = new Date();
  const folder = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const blobPath = `${folder}/${randomUUID()}/${fileName}`;
  await service().getContainerClient(exportContainerName).getBlockBlobClient(blobPath)
    .uploadData(Buffer.from(text, 'utf8'), { blobHTTPHeaders: { blobContentType: 'text/csv; charset=utf-8' } });
  return signedUrl(exportContainerName, blobPath, exportSasMinutes, fileName);
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

/** Stores the original and its preview. Returns the paths, or { error } for bad input. */
async function storeImage(content, contentType) {
  const decoded = decodeImage(content, contentType);
  if (decoded.error) return decoded;

  // Loaded here, so a problem with the native module only affects this route.
  const sharp = require('sharp');
  let meta;
  try {
    meta = await sharp(decoded.buffer).metadata();
  } catch {
    return { error: 'content is not a supported image' };
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
  await cc.getBlockBlobClient(imagePath).uploadData(decoded.buffer, { blobHTTPHeaders: { blobContentType: mime } });
  await cc.getBlockBlobClient(previewPath).uploadData(preview, { blobHTTPHeaders: { blobContentType: 'image/jpeg' } });

  return {
    image_blob_path: imagePath,
    preview_blob_path: previewPath,
    content_type: mime,
    width: meta.width ?? null,
    height: meta.height ?? null,
    image_bytes: decoded.buffer.length,
    preview_bytes: preview.length,
  };
}

module.exports = { enabled, readUrl, storeImage, storeExport };
