# EDS – Setup and deployment

How to deploy each part of EDS from this repository, and what is not in the repository.

## Repository layout

| Path | What |
|---|---|
| `01_schema.sql` … `08_sync_employee_department_id.sql` | Database schema, stored procedures, seed data, users and grants (Azure SQL `eds-db`) |
| `api/` | Function App source (`func-eds-dev`, Node.js, Azure Functions v4) |
| `apim/` | APIM data API definition and policy |
| `powerplatform/solution/EDSPADelivery/` | Power Automate solution `EDSPADelivery` (5 flows, environment variables, connection references), extracted from the export zip |
| `powerplatform/canvas-app/` | Canvas app source (`pac canvas unpack` of `EDS-App-Desktop-phase2`) |
| `docs/EDS-APIManagement1.md` | API contract used by the app through the `EDS-APIManagement1` flow |
| `tools/` | Helper scripts: run SQL batches, generate seed data, build the Function App zip |

## Not in the repository

These must be created by hand. The repository only contains what is deployed to them.

| Missing | What to know |
|---|---|
| **Flow `EDS-APIManagement1`** | The app sends every database call (`history`, `employee`, `department`, `ocr_history`) through this flow. It is **not** part of the `EDSPADelivery` solution, so importing the solution does not create it. Its inputs and outputs are described in `docs/EDS-APIManagement1.md`. Without it the app cannot read or write the database, including the History screen. Export it from the current environment and add it here when possible. |
| **Azure SQL server and database** | No template or script creates them. The current ones are server `sql-eds-dev1` and database `eds-db` (serverless, 60-minute auto-pause, Microsoft Entra-only authentication, firewall allows listed IPs only). Create them first, then run the SQL scripts below. |
| **Function App resource** | No template or script creates it. The current one is `func-eds-dev`: Linux, Node.js, Functions v4, system-assigned managed identity, inbound traffic restricted to the APIM gateway IP. The app settings it needs are listed in step 2. |

## 1. Database

Run the scripts in order against `eds-db`, signed in as a Microsoft Entra admin of the server:

```
01_schema.sql   02_procs.sql   03_seed_data.sql (optional, dummy data)
04_grants.sql   05_users.sql   06_seed_department.sql
07_cleanup_employee.sql        08_sync_employee_department_id.sql
```

`tools/run.js` can run them with an `az` access token (`SQL_SERVER`, `SQL_DB` environment variables). Azure Portal → database → Query editor also works.

`01_schema.sql` and `02_procs.sql` are safe to re-run. On an existing database, re-running both applies the latest schema changes in place, for example widening `dbo.history.image_url` to `NVARCHAR(MAX)`.

`04_grants.sql` contains the SID of the Function App's managed identity. If the Function App is new, regenerate the SID as described in the file header.

## 2. Function App

```
cd api
npm install
```

Deploy `package.json`, `host.json`, `src/` and `node_modules/` as a zip. The zip must use `/` path separators. PowerShell's `Compress-Archive` writes `\`, which a Linux host cannot read. `tools/zip.js` builds a correct zip. Edit `ROOT` and `OUT` at its top first.

Required app settings:

| Setting | Value |
|---|---|
| `SQL_SERVER` | `<server>.database.windows.net` |
| `SQL_DATABASE` | `eds-db` |

The function signs in to SQL with its system-assigned managed identity. There is no connection string or password.

## 3. APIM

Import `apim/eds-data-api.openapi.json` and apply `apim/eds-data-api.policy.xml` to the data API. The policy needs these named values: `tenant-id`, `api-audience`, `data-app-role`, `func-eds-url` and `func-eds-key`.

## 4. Power Automate solution `EDSPADelivery`

The folder is the content of the solution export zip. The client secret has been removed.

1. **Insert the client secret.** In these two files, replace `<CLIENT_SECRET>` with the secret of app registration `53ddbbff-90ae-4085-858e-9923b3c6a3d9` (step `Get_auth_token`):
   - `Workflows/EDS-NotifySelected-7DA7A2CC-EFA1-F111-B8DE-70A8A50387B3.json`
   - `Workflows/EDS-ProcessLabel-627A7FDA-01AC-F111-AAAD-70A8A50387B3.json`

   Get the secret from the team lead or the key store. **Never commit the files with the real secret.** Run `git checkout -- powerplatform/solution` after building the zip.
2. **Build the zip** from the repository root. The file names must sit at the root of the zip:
   ```
   tar -a -cf EDSPADelivery.zip -C powerplatform/solution/EDSPADelivery "[Content_Types].xml" customizations.xml solution.xml Workflows environmentvariabledefinitions
   ```
3. **Import** with `pac solution import --path EDSPADelivery.zip`, or in make.powerapps.com → Solutions → Import. Create or select the connections for the four connection references: SharePoint, Teams, Planner and Excel Online.
4. **Set the environment variables.** These are `cr1d7_*`: SharePoint site, list and library IDs, Teams team and channel, Planner group and plan, and the Office Script. The values in the export point to the current environment.
5. **Check the hard-coded values.** In `EDS-NotifySelected` → `Try_get_image` → `Image_source_url`, the SharePoint site URL is hard-coded: `https://smartosc0.sharepoint.com/sites/Teamresponsibleforreceivingexpressshipments`. Change it if the site is different.
6. Turn the flows on.

The client secret is stored in plain text in the flow definition. Anyone who can open or export the flow can read it. Move it to a secret environment variable or Key Vault when possible.

## 5. Canvas app

```
pac canvas pack --msapp EDS-App-Desktop-phase2.msapp --sources powerplatform/canvas-app
```

Then, in Power Apps Studio: create a blank canvas app → File → Open → Browse → select the `.msapp`. Then File → Save as. Allow the connections, re-point the SharePoint data sources and flows if the environment is new, and publish.

To save app changes back into the repository: download the `.msapp` from Studio, then run `pac canvas unpack --msapp <file> --sources powerplatform/canvas-app`.

## Scanned images in the history table

New registrations store the scanned image as base64 in `dbo.history.image_url`:

```
App (register / register unknown) → image uploaded to SharePoint (EDS-UploadCaptureImage / EDS-SaveUnknownPackage)
  → EDS-NotifySelected: reads the file from SharePoint → "data:<type>;base64,<content>"
  → APIM /history (POST) → historyInsert → sp_history_insert → dbo.history.image_url (NVARCHAR(MAX))
History screen: EDS-APIManagement1 → historyList → imgHistScan shows the data URI directly;
  older rows (SharePoint URL/path) still use the SharePoint thumbnail
```

- If the flow cannot read the file, it saves the original URL or path instead, so the registration is not lost.
- The SharePoint upload is unchanged. Teams notifications and other screens still use it.
- Old rows were not converted.
- Each of these must be NVARCHAR(MAX) or uncapped: the column, the `@image_url` parameter and the Function App parameter. A shorter type anywhere silently cuts the image and stores it broken.
- `historyList` returns the full images. A page of 50 rows can be tens of MB. Lower `pageSize` if the History screen is slow.

Check new rows:

```sql
SELECT TOP 10 history_id, slip_no, created_at,
       LEN(image_url) AS image_length,
       CASE WHEN image_url LIKE 'data:image/%;base64,%' THEN 'BASE64' ELSE 'URL / PATH' END AS image_type
FROM dbo.history
ORDER BY history_id DESC;
```
