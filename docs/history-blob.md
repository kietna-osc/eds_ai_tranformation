# History images in Azure Blob Storage

Branch: **`feature/history-blob`**. Status: backend and flows deployed to separate resources; app copy built, not yet published; SQL scripts to be run.

When a package is registered (or registered as unknown), the scanned image and a 320 px preview are stored in Azure Blob Storage. `dbo.history_blob` stores their paths. The History screen shows the preview and opens the full image on click.

Everything runs on **separate copies** of the live parts. The live app, flows, Function App, APIM API and `dbo.history` are not changed.

## How it works

```
Register / register unknown (app copy EDS-App-Desktop-phase2-blob)
  -> EDS-NotifySelected-blob
       Teams post + Planner task                      (same as live)
       read the image from SharePoint                 (same as the base64 variant)
       POST /eds-blob/images  -> func-eds-blob-dev blobImageUpload
            original + 320 px JPEG preview -> stedsblobdev1007 / history-images / yyyy/mm/<id>[_preview].jpg
       POST /eds-blob/history -> blobHistoryInsert -> dbo.sp_history_blob_insert -> dbo.history_blob
History screen (app copy)
  -> EDS-APIManagement1-blob (historyList only; every other call is unchanged)
       GET /eds-blob/history -> blobHistoryList -> dbo.sp_history_blob_list
            + preview_url / image_blob_url: read-only SAS links, valid 60 min
  -> imgHistScan shows preview_url; click opens image_blob_url
     rows without blobs (copied from dbo.history, or upload failed) -> SharePoint thumbnail, as before
```

- `image_url` still holds the SharePoint URL sent by the app, as a fallback.
- If reading the image or uploading it fails, the row is saved without blob paths, so a registration is never lost.
- The container is private. The database stores paths, never links. Read links are signed with a **user delegation key** obtained by the Function App's managed identity, so no storage account key is used.

## What was created

| Resource | Name | Notes |
|---|---|---|
| Storage account | `stedsblobdev1007` (rg-kietna-1422, Central US) | StorageV2, LRS, HTTPS only, TLS 1.2, public blob access disabled. Also holds the Function App's host storage. |
| Blob container | `history-images` | Private |
| Function App | `func-eds-blob-dev` | Linux Consumption, Node 22, Functions v4, system-assigned identity (app id `cdfcc7fc-d553-4fb0-b270-fe628939b842`). Inbound: APIM gateway IP `74.151.170.134` only. HTTPS only, TLS 1.2, FTPS only. Application Insights `func-eds-blob-dev`. |
| Role assignment | Storage Blob Data Contributor | `func-eds-blob-dev` identity on `stedsblobdev1007` only |
| APIM API | `eds-blob-api`, path `/eds-blob` | Operations `GET /history`, `POST /history`, `POST /images`. Policy `apim/eds-blob-api.policy.xml`: a copy of the live `eds-data-api` policy with the backend swapped. |
| APIM named values | `func-eds-blob-url`, `func-eds-blob-key` (secret) | |
| Flow | `EDS-NotifySelected-blob` (Dataverse workflow `7fc373b2-06c2-f111-aaaf-6045bd59502f`), on | `powerplatform/flows/EDS-NotifySelected-blob.json` |
| Flow | `EDS-APIManagement1-blob` (flow `1303d31d-c352-442e-9196-ff8aab1f9f46`), on | `powerplatform/flows/EDS-APIManagement1-blob.json` |
| SQL (to run) | `dbo.history_blob`, `dbo.sp_history_blob_list`, `dbo.sp_history_blob_insert`, user `func-eds-blob-dev` | `09_history_blob.sql`, `10_history_blob_copy.sql`, `11_history_blob_grants.sql` |
| App (to publish) | `EDS-App-Desktop-phase2-blob` | Built from `powerplatform/canvas-app` on this branch |

App settings of `func-eds-blob-dev`: `SQL_SERVER`, `SQL_DATABASE` (as live), `BLOB_ACCOUNT_URL=https://stedsblobdev1007.blob.core.windows.net`, `BLOB_CONTAINER=history-images`, `BLOB_SAS_MINUTES=60`, `BLOB_PREVIEW_WIDTH=320`.

## Code

- `api/src/historyBlob.js`: the three routes `blob/images`, `blob/history` (POST) and `blob/history` (GET).
- `api/src/index.js` registers them **only when `BLOB_ACCOUNT_URL` is set**. `func-eds-dev` does not have that setting, so redeploying it from this branch exposes the same 13 routes as before. `sharp` is loaded only inside the upload route.
- New dependencies: `@azure/storage-blob` and `sharp`. The Linux Function App needs the Linux build of `sharp`. Build the deployment package on Windows with:

  ```
  npm ci --omit=dev --os=linux --cpu=x64 --libc=glibc
  ```

  Then zip `host.json package.json package-lock.json src node_modules` with `/` separators (`tar.exe -a -cf`, or `tools/zip.js`). `@img/sharp-wasm32` can be removed from the package. About 29 MB.

### `POST /eds-blob/images`

```json
{ "content": "data:image/jpeg;base64,/9j/4AAQ...", "content_type": "image/jpeg" }
```

`content` may be a data URI or plain base64. The limit is 10 MB. Response **201**:

```json
{ "image_blob_path": "2026/10/<id>.jpg", "preview_blob_path": "2026/10/<id>_preview.jpg",
  "content_type": "image/jpeg", "width": 3264, "height": 2448, "image_bytes": 613197, "preview_bytes": 13071 }
```

Response **400** if `content` is missing, not base64, or not an image.

### `POST /eds-blob/history`

The same body as `POST /eds/history`, plus `image_blob_path` and `preview_blob_path`. It returns `{ "history_id": n }`.

### `GET /eds-blob/history`

The same parameters and response as `GET /eds/history`. Each row also has `image_blob_path`, `preview_blob_path`, `image_blob_url` and `preview_url`; the last two are null when there is no blob.

## Setup order

1. **SQL** (Azure Portal → `eds-db` → Query editor):
   1. If base64 rows are still in `dbo.history`, run the base64 delete first (otherwise `10` skips them anyway).
   2. `09_history_blob.sql`: table, indexes, trigger, procedures.
   3. `10_history_blob_copy.sql`: one-time copy of `dbo.history`.
   4. `11_history_blob_grants.sql`: database user for `func-eds-blob-dev`, EXECUTE on the two procedures only.
   5. Only for a database set up before 2026-10-07 14:00: `12_history_blob_employee_id_text.sql`, then `09_history_blob.sql` again. A fresh setup gets `NVARCHAR(50)` from `09` directly.
2. **App** (Power Apps Studio):
   1. File → Open → Browse → `EDS-App-Desktop-phase2-blob.msapp`.
   2. Data / Power Automate pane → **Add flow** → `EDS-NotifySelected-blob` and `EDS-APIManagement1-blob`. The formulas already call these names; errors in Studio disappear once both are added.
   3. File → **Save as** `EDS-App-Desktop-phase2-blob` (a new app). Allow connections. Publish.
   4. Share the app only with testers.

## Testing checklist

| # | Test | Expected |
|---|---|---|
| 1 | Open History in the new app | Rows copied from `dbo.history` show SharePoint thumbnails |
| 2 | Register a package | Teams post and Planner task as usual. A new row at the top shows the **preview**. Clicking it opens the full image. |
| 3 | Register unknown | Same as 2; the `PackageSlipLog` / unknown list works as before |
| 4 | Change page and page size | Previews load quickly |
| 5 | Leave the screen open for more than 60 minutes, then click a preview | The link has expired; reloading the page creates new links |
| 6 | Live app `EDS-App-Desktop-phase2` | Unchanged; test registrations from the new app do **not** appear in its History (separate table) |

Checks: `EDS-NotifySelected-blob` run history → `Upload_to_blob` / `Query_history`. `func-eds-blob-dev` Application Insights. Rows:

```sql
SELECT TOP 10 history_id, slip_no, image_blob_path, preview_blob_path, created_at
FROM dbo.history_blob ORDER BY history_id DESC;
```

## Known gaps

- **Delivered status.** `POST /eds/history/delivered` (`historySetDelivered`) updates `dbo.history` only. According to its code comment it is called by a Planner "task completed" flow, which is not in this repository and was not checked. If that flow exists, rows registered through the blob variant are not marked delivered. Add a blob route and point the flow at it before going live.
- **Mobile.** The mobile History layout has no image control, so it shows no preview.
- **Link lifetime.** Read links expire after `BLOB_SAS_MINUTES`. The History screen gets new links on every page load.
- **Inherited from live, unchanged on purpose:**
  - unknown registrations are saved with `status = Identified`
  - the department name is not saved (`recipient_department` vs `recipient_department_name`)
  - only one row is saved per registration
  - **a Planner failure stops the flow** before the Teams post and the history row. Seen 2026-10-07: assigning to `KIET@SMARTOSC.COM`, which is not a user in the tenant, failed with "Referenced User or Group … is not found", and the app showed 「メッセージの送信に失敗しました」. Test with recipients whose email is a tenant user.
- **`employee_id` is text.** Live `dbo.employee.employee_id` is `NVARCHAR`, and 12 of 2,007 ids do not fit in `INT` (e.g. `10000000004`). The blob variant stores `employee_id` as `NVARCHAR(50)` (`12_history_blob_employee_id_text.sql`); `GET /eds-blob/history` returns digit-only ids as numbers and others as text. **Live has the same bug:** `func-eds-dev` `historyInsert` sends `employee_id` as `INT`, so registering one of those 12 employees in the live app fails with a 500 at the history step. Not fixed in live.
- **Schema drift.** The live database differs from `01_schema.sql` (`employee.employee_id` is text, `employee_code` does not exist). Update the repo scripts from the live schema before using them for a new environment.
- **Policy drift.** The live `eds-data-api` policy requires role `{{api-app-role}}` (`OCR.Invoke`), but `apim/eds-data-api.policy.xml` on `develop` says `{{data-app-role}}`. The new API copies the live policy.

## Removing the variant

Delete:
- the app `EDS-App-Desktop-phase2-blob`
- the flows `EDS-NotifySelected-blob` and `EDS-APIManagement1-blob`
- the APIM API `eds-blob-api` and the named values `func-eds-blob-*`
- the Function App `func-eds-blob-dev` with its Application Insights
- the storage account `stedsblobdev1007`

In SQL: `DROP USER [func-eds-blob-dev]`, then drop the two procedures and `dbo.history_blob`. Nothing in the live system depends on any of these.
