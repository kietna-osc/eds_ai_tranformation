# EDS – Setup and deployment

How to deploy each part of EDS from this repository, and what is not in the repository.

## Repository layout

| Path | What |
|---|---|
| `01_schema.sql` … `08_sync_employee_department_id.sql` | Database schema, stored procedures, seed data, users and grants (Azure SQL `eds-db`) |
| `api/` | Function App source (`func-eds-dev`, Node.js, Azure Functions v4) |
| `apim/` | APIM data API definition and policy |
| `powerplatform/solution/EDSPADelivery/` | Power Automate solution `EDSPADelivery` (5 flows, environment variables, connection references), extracted from the export zip |
| `powerplatform/flows/EDS-APIManagement1.json` | Definition of the flow `EDS-APIManagement1`, which is not part of the solution |
| `powerplatform/canvas-app/` | Canvas app source (`pac canvas unpack` of `EDS-App-Desktop-phase2-base64`) |
| `docs/EDS-APIManagement1.md` | API contract used by the app through the `EDS-APIManagement1` flow |
| `tools/` | Helper scripts: run SQL batches, generate seed data, build the Function App zip |

## Not in the repository

These must be created by hand. The repository only contains what is deployed to them.

| Missing | What to know |
|---|---|
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
5. Turn the flows on.

The client secret is stored in plain text in the flow definition. Anyone who can open or export the flow can read it. Move it to a secret environment variable or Key Vault when possible.

## 5. Canvas app

```
pac canvas pack --msapp EDS-App-Desktop-phase2-base64.msapp --sources powerplatform/canvas-app
```

Then, in Power Apps Studio: create a blank canvas app → File → Open → Browse → select the `.msapp`. Then File → Save as. Allow the connections, re-point the SharePoint data sources and flows if the environment is new, and publish.

To save app changes back into the repository: download the `.msapp` from Studio, then run `pac canvas unpack --msapp <file> --sources powerplatform/canvas-app`.

## 6. Flow `EDS-APIManagement1`

The app sends every database call (`history`, `employee`, `department`) through this flow. Its inputs and outputs are described in `docs/EDS-APIManagement1.md`. Without it the app cannot read or write the database, including the History screen.

It is **not** part of the `EDSPADelivery` solution, so importing the solution does not create it. `powerplatform/flows/EDS-APIManagement1.json` holds its definition as returned by the Power Automate management API (`displayName`, `definition`, `connectionReferences`). There is no import button for a bare definition. Either:

- update an existing flow with `PATCH https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments/<env>/flows/<flow id>?api-version=2016-11-01` and the body `{"properties": <file content>}`, using a token for `https://service.flow.microsoft.com/`, or
- create an instant flow with a Power Apps trigger (inputs `text`, `text_1`, `text_2`) and rebuild the actions by hand from the file.

Before using it, replace `<CLIENT_SECRET>` in `Get_auth_token` with the secret of app registration `53ddbbff-90ae-4085-858e-9923b3c6a3d9`. Never commit the real secret. The current flow is `649050a3-e9fb-484d-bfa1-4351703308c6` in the default environment.

The list routes read the page size from `pageSize`, which is what the app sends. They also accept `page_size` for older callers.

## Scanned images in the history table

`dbo.history.image_url` holds the SharePoint URL or path of the scanned image:

```
App (register / register unknown) → image uploaded to SharePoint (EDS-UploadCaptureImage / EDS-SaveUnknownPackage)
  → EDS-NotifySelected → APIM /history (POST) → historyInsert → sp_history_insert → dbo.history.image_url
History screen: EDS-APIManagement1 → historyList → imgHistScan looks up the file name in the
  SharePoint Documents library (colSpAllItems) and shows its thumbnail
```

### Base64 variant (not active)

A version that stores the image itself as a base64 data URI in `image_url`, so the History screen does not depend on SharePoint, is kept on branch **`feature/history-base64`**. It was live from 2026-10-06 to 2026-10-07, then rolled back: each row carried about 0.8 MB, and a 50-row History page took about 23 s to load.

What stays on `develop` from that change, because it is harmless with URLs:

- `image_url` and `@image_url` are `NVARCHAR(MAX)`, and `historyInsert` does not cap the length.
- The app's `imgHistScan.Image` formula shows a value starting with `data:` directly, otherwise the SharePoint thumbnail.

To turn it back on:

1. In Power Automate, turn on **`EDS-NotifySelected-base64`** (a copy of `EDS-NotifySelected` with the steps `Initialize_image_value`, `Set_image_value_url` and `Try_get_image`, kept turned off), or apply its definition from the branch to `EDS-NotifySelected`.
2. Point the app's register and register-unknown buttons (`cmpMatchPanel` → `btnRegister`, `btnUnknown`) at the flow that is on, and publish.
3. Read `docs/history-search-paging.md` first: with base64, the size of `historyList` responses becomes the main performance problem.
