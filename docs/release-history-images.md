# Release: scanned images in Azure Blob Storage (live)

Branch: **`release/history-blob`** (from `develop`). The design is the blob variant from `docs/history-blob.md`, applied to the live resources instead of copies.

New registrations store the scanned image and a 320 px preview in Blob Storage, and their paths in `dbo.history`. The History screen of **`EDS-App-Desktop-phase2`** shows the preview and opens the full image on click. Old rows keep the SharePoint thumbnail.

## What changes in live

| Resource | Change |
|---|---|
| Storage `stedsimages1008` (new) | Container `history-images`, private. **Shared-key access disabled**: account keys do not work. Only `func-eds-dev`'s identity has a data role (Storage Blob Data Contributor). |
| SQL `eds-db` | `13_history_image_blob.sql`: two columns on `dbo.history`, `employee_id` as text, new `sp_history_list_v2` / `sp_history_insert_v2`. The old procedures are unchanged. |
| Function `func-eds-dev` | `history` routes use the `_v2` procedures, `employee_id` as text, read links in `historyList`, new `POST /api/images`. App settings `BLOB_*`. |
| APIM `eds-data-api` | New operation `POST /images`. The policy is unchanged. |
| Flow `EDS-NotifySelected` | Reads the image from SharePoint → `POST /eds/images` → `POST /eds/history` with the paths. Teams and Planner are unchanged. Gains the SharePoint connection reference. |
| Flow `EDS-APIManagement1` | No change: it passes the new fields through. |
| App `EDS-App-Desktop-phase2` | Updated in place (same name, link and sharing): preview + click for full image, plus the loading fix from `66532d6` (hide rows and disable the pager while loading). |

Also fixed by this release: registering one of the 12 employees whose id does not fit in `INT` (e.g. `10000000004`) no longer fails.

## Before step 2.2: merge with the CSV work

A colleague's version (`api_database_namvh`, 2026-10-07) adds `employeeImport` / `employeeExport` and `sp_employee_upsert` to the same `api/src/index.js`. It is **not deployed**. Whichever is deployed second to `func-eds-dev` must contain both changes, or it removes the other. Merge before deploying either.

## Deployment (in this order; each step works with the old versions of the rest)

| # | Step | Who | Check | Rollback |
|---|---|---|---|---|
| 2.1 | Run `13_history_image_blob.sql` in Query editor (allowlist your IP if asked) | You | The last two results: `image_blob_path` / `preview_blob_path` `nvarchar 500`, `employee_id` `nvarchar 50`; two `EXECUTE` rows for the `_v2` procedures | Not needed: additive. Old procedures untouched. |
| 2.2 | `func-eds-dev`: app settings `BLOB_ACCOUNT_URL=https://stedsimages1008.blob.core.windows.net`, `BLOB_CONTAINER=history-images`, `BLOB_SAS_MINUTES=60`, `BLOB_PREVIEW_WIDTH=320`; deploy `powerapps/release/func-eds-dev-release.zip` | Claude | 14 functions loaded (13 + `imageUpload`); History in the live app still loads | Set `WEBSITE_RUN_FROM_PACKAGE` to the URL in `powerapps/backup-2026-10-08/func-eds-dev-package-url.txt` |
| 2.3 | APIM `eds-data-api`: add `POST /images` (`image-upload`) | Claude | Without a token: 401 | Delete the operation |
| 2.4 | App: Export package of `EDS-App-Desktop-phase2` (make.powerapps.com → Apps → ⋯ → Export package) → Claude swaps in `EDS-App-Desktop-phase2-release.msapp` → Import package with **Update** → Publish | You + Claude | History loads; old rows show SharePoint thumbnails; loading message while paging | Power Apps → app → Details → Versions → Restore the previous version, or import `powerapps/backup-2026-10-08/EDS-App-Desktop-phase2.msapp` |
| 2.5 | Flow `EDS-NotifySelected`: apply the release definition (`powerplatform/solution/EDSPADelivery/Workflows/EDS-NotifySelected-*.json`, with the secret inserted). **This is the switch-on.** | Claude (approve the prompt) | Next registration: run succeeds; `Upload_image` 201 | Re-apply `powerapps/backup-2026-10-08/EDS-NotifySelected-live.json` |
| 2.6 | Test: register, register unknown, History preview + full image, page size, an employee with a long id | You, Claude checks the runs and logs | See `docs/history-blob.md` → Testing checklist | Per step above |

Other apps that call `EDS-NotifySelected` (e.g. `EDS-App-Desktop-phase2-anhndt-20261006`) also start saving blob paths after 2.5. Their History keeps showing SharePoint thumbnails, because they do not read `preview_url`.

## Afterwards

- Monitor `EDS-NotifySelected` run failures and `func-eds-dev` Application Insights for a few days.
- Remove the test resources: `func-eds-blob-dev`, `stedsblobdev1007`, APIM `eds-blob-api` and `func-eds-blob-*` named values, flows `EDS-NotifySelected-blob` / `EDS-APIManagement1-blob` / `EDS-NotifySelected-base64`, app `EDS-App-Desktop-phase2-blob`, table `dbo.history_blob` with its procedures and user.
- Merge `release/history-blob` into `develop`; update `docs/SETUP.md` and `docs/EDS-APIManagement1.md`.
- Later, optional: shorter link lifetime; the inherited flow issues (a Planner failure stops the flow; unknown packages saved as `Identified`; department name not saved).
