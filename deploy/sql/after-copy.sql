/* Runs on a database filled from another environment (setup-test.ps1). Safe to re-run.
   Tokens:
     $(FUNC_APP)         this environment's Function App, e.g. func-eds-test
     $(FUNC_APP_SID)     SID of its managed identity (client ID as bytes)
     $(SOURCE_BLOB_URL)  the source's image storage URL
     $(BLOB_ACCOUNT_URL) this environment's image storage URL
   1. Creates the database user of this environment's Function App. WITH SID, as in
      04_grants.sql, so the server needs no directory read permission. Its permissions
      are copied from the source app's user afterwards (sql.js copy-grants).
   2. Points history.image_url at this environment's image storage. */

IF DATABASE_PRINCIPAL_ID(N'$(FUNC_APP)') IS NULL
    CREATE USER [$(FUNC_APP)] WITH SID = $(FUNC_APP_SID), TYPE = E;
GO

UPDATE dbo.history
SET    image_url = REPLACE(image_url, N'$(SOURCE_BLOB_URL)', N'$(BLOB_ACCOUNT_URL)')
WHERE  image_url LIKE N'$(SOURCE_BLOB_URL)/%';
GO

SELECT (SELECT COUNT(*) FROM dbo.history)  AS history_rows,
       (SELECT COUNT(*) FROM dbo.employee) AS employee_rows,
       (SELECT COUNT(*) FROM dbo.history WHERE image_url LIKE N'$(BLOB_ACCOUNT_URL)/%') AS images_on_this_storage;
