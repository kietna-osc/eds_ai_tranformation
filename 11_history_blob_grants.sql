/* EDS — database principal for func-eds-blob-dev (branch feature/history-blob)

   func-eds-blob-dev authenticates with its system-assigned managed identity, like
   func-eds-dev (see 04_grants.sql). It only needs the two blob-history procedures:
   the APIM API eds-blob exposes /history and /images only, and every other call
   from the app still goes to func-eds-dev.

   The SID is the identity's APPLICATION (client) id in little-endian byte order:
       object id : 38466fba-b77c-49ae-8de2-da8680eda3bb   (wrong for this purpose)
       app    id : cdfcc7fc-d553-4fb0-b270-fe628939b842   -> SID below
   Regenerate it if the Function App or its identity is recreated:
       az ad sp show --id <objectId> --query appId -o tsv

   Run against eds-db after 09_history_blob.sql. Safe to re-run. */

IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'func-eds-blob-dev')
    DROP USER [func-eds-blob-dev];
GO

CREATE USER [func-eds-blob-dev] WITH SID = 0xFCC7FCCD53D5B04FB270FE628939B842, TYPE = E;
GO

GRANT EXECUTE ON OBJECT::dbo.sp_history_blob_list   TO [func-eds-blob-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_history_blob_insert TO [func-eds-blob-dev];
GO

-- Verify: two rows, both EXECUTE.
SELECT pr.name AS principal, o.name AS object, pe.permission_name
FROM sys.database_permissions pe
JOIN sys.database_principals pr ON pr.principal_id = pe.grantee_principal_id
JOIN sys.objects o ON o.object_id = pe.major_id
WHERE pr.name = 'func-eds-blob-dev'
ORDER BY o.name;
