# Deploy scripts

Deploy dev and test from your own machine. Run them in Windows PowerShell from the repository root.

| Script | What it does |
|---|---|
| `setup-test.ps1` | Creates the test resources and copies dev's data into them. Run it once; re-running it is safe. |
| `deploy-test.ps1` | Deploys the working tree to test: `sql`, `api`, `apim`, `powerplatform` |
| `deploy-dev.ps1` | Deploys the working tree to dev: `sql`, `api`, `apim` |
| `config.dev.ps1`, `config.test.ps1` | All names, URLs and values for each environment. The scripts hardcode none of them. |

```powershell
az login                               # the scripts use your account; nothing is stored
pac auth create                        # once, for -Parts powerplatform
cd tools; npm ci; cd ..                # once: the SQL runner uses tools/node_modules/mssql

.\deploy\setup-test.ps1                # once
.\deploy\deploy-test.ps1               # every time you want test updated
.\deploy\deploy-test.ps1 -Parts api    # only the Function App
.\deploy\deploy-dev.ps1 -Parts api,apim
```

Every script shows what it will change and asks before it starts. Pass `-Yes` to skip the question.

## Environments

| | Dev | Test |
|---|---|---|
| Function App | `func-eds-dev` (Linux Consumption, Central US) | `func-eds-test` (Linux Consumption, **East US**) |
| SQL | `sql-eds-dev1` / `eds-db` | `sql-eds-test1` / `eds-db-test` |
| Image storage | `stedsimages1008` | `stedsimagestest1013` |
| APIM API | `eds-data-api`, path `/eds` | `eds-data-api-test`, path `/eds-test` |
| Power Platform | smartosc.com (default) | EDS-test |

Both environments use resource group `rg-kietna-1422` and APIM instance `apim-eds-dev`.

## SQL scripts

The numbered scripts at the repository root (`17_something.sql` and later) are the migrations. `-Parts sql` runs each script that the database has not run yet, in number order. Each script runs in its own transaction, so a script that fails changes nothing. The script names are recorded in `dbo.deploy_log`.

- **First run against dev:** the scripts up to now were run by hand, so record them first with `.\deploy\deploy-dev.ps1 -Parts sql -BaselineSql`. That runs nothing. `setup-test.ps1` records them on test automatically.
- **A script you already ran by hand on dev:** run `-BaselineSql` again on dev so it isn't run twice.
- **Don't name dev's resources in new scripts.** Use `$(FUNC_APP)` for the Function App's database user and `$(BLOB_ACCOUNT_URL)` for the image storage. The values come from the config file. `config.test.ps1` also rewrites `func-eds-dev` and the dev storage URL in older-style scripts, but don't rely on that.
- **Never recreate the Function App's database user in a migration.** The user's SID differs between environments. `setup-test.ps1` creates it.
- **Scripts that can't run inside a transaction** (e.g. `ALTER DATABASE`): make the first line `-- deploy: no-transaction`.

## Power Platform

People edit the app and flows in dev, so dev is the source. Nothing is deployed to dev. `deploy-test.ps1 -Parts powerplatform` works like this:

1. Exports the `EDSPADelivery` solution from dev as managed. EDS-test already has it as managed.
2. Replaces dev's IDs with test's in the flows and inside the canvas app's `.msapp`, using the `Replace` list in `config.test.ps1`:
   - API path `/eds/` → `/eds-test/`
   - Reception SharePoint site and its Documents library → Test-Reception
   - Teams *Notification / RnD* → *Test-Notification / channel notification*
   - Planner *EDS-Planner* → *EDS-Planner-test*

   The flows and the app contain these IDs directly; they don't read environment variables. The EDSProcessLabel2 site (PackageSlipLog, EmployeeList, UnknownImage, UploadedImage) stays shared with dev.
3. Raises the version above the one installed in EDS-test.
4. Imports it into EDS-test, using that environment's connections and the environment variable values in `config.test.ps1`.

**Only what is in the solution is deployed.** Add these to `EDSPADelivery` in dev once (make.powerapps.com → Solutions → EDS-PA-Delivery → Add existing):

- Canvas app `EDS-App-Desktop-phase2`
- Cloud flows `EDS-APIManagement1` and `EDS-EmployeeImport`. These sit outside Dataverse, so add them from that tab.

Until you do, the script warns that they are missing. Test then has no API flow, and an app outside the solution would call dev's flows.

The exported solution contains the flows' client secret. It is written to `deploy/.out/` (git-ignored) and deleted after the import.

## If something fails

- **The test database:** `eds-db-test` is a free-offer database configured like dev's `eds-db` (serverless Gen5, 0.5–2 vCores, 32 GB, pauses after 60 idle minutes). It gets 100,000 vCore-seconds a month and pauses, without charge, when they run out. SqlPackage fills it with dev's schema and data, but only while it has no tables, so a re-run never overwrites test data. To start over from dev's current data, use `-RecopyDatabase`.
- **SqlPackage fails during Publish:** the database is left partly filled. Re-run with `-RecopyDatabase` after fixing the cause.
- **Why `func-eds-test` is in East US:** Azure does not let this subscription create App Service plans in Central US ("not allowed to create or update the serverfarm"). A new app on dev's existing Central US plan could not be configured either. In East US, Azure created `EastUSLinuxDynamicPlan`, which is also where `apim-eds-dev` runs. The app's storage and database stay in Central US.
- **The SQL firewall blocks you:** the scripts add a rule named `deploy-<your Windows user>` for your current IP automatically.
