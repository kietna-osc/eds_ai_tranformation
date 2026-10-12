/* EDS Phase 2 - database principal for the API.

   func-eds-dev authenticates with its system-assigned managed identity, so there
   is no password anywhere. It is granted EXECUTE on the listed procedures and
   nothing else - no SELECT, no INSERT, no db_datareader/db_datawriter. A fully
   compromised Function App can therefore only perform these operations, and
   cannot read either table directly.

   Created WITH SID rather than FROM EXTERNAL PROVIDER so it does not depend on
   the SQL server having Microsoft Graph directory permissions.

   The SID must be derived from the identity's APPLICATION (client) id, not its
   object/principal id - Azure SQL matches the appid claim in the access token.
   Using the object id yields "Login failed for user '<token-identified principal>'".
       object id : b72d3f12-1e47-421f-b081-2b2b5276d37c   (wrong for this purpose)
       app    id : df9b640d-81b0-41e2-9b54-401d8937d6ca   -> SID below
   Regenerate the SID if the managed identity is ever recreated:
       az ad sp show --id <objectId> --query appId -o tsv
   then reverse the first three GUID groups into little-endian byte order. */

IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'func-eds-dev')
    DROP USER [func-eds-dev];
GO

CREATE USER [func-eds-dev] WITH SID = 0x0D649BDFB081E2419B54401D8937D6CA, TYPE = E;
GO

GRANT EXECUTE ON OBJECT::dbo.sp_history_list             TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_history_insert           TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_history_set_planner_task TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_set_delivered            TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_employee_list            TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_match_candidates         TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_employee_fuzzy_roster    TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_employee_insert          TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_employee_update          TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_employee_delete          TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_department_list          TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_department_insert        TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_ocr_history_insert       TO [func-eds-dev];
GO

-- Verify: expect EXECUTE grants and no others.
SELECT dp.name AS principal, p.permission_name, o.name AS object_name
FROM   sys.database_permissions p
JOIN   sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
LEFT  JOIN sys.objects o ON o.object_id = p.major_id
WHERE  dp.name = 'func-eds-dev'
ORDER  BY o.name;
GO
