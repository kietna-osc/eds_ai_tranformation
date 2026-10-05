/* EDS Phase 2 - human database users.

   The server is Entra-only, so these are contained users with no password.
   Created WITH SID rather than FROM EXTERNAL PROVIDER so they do not depend on
   the SQL server holding Microsoft Graph directory permissions.

   For a human user the SID is the Entra OBJECT id in little-endian byte order.
   (Managed identities are the exception - they key off the application id
   instead; see the note in 04_grants.sql.)

   Look one up with:  az ad user show --id <upn> --query id -o tsv
*/

------------------------------------------------------- KietNgoAnh - read only
-- object id bfc6eebe-e451-4d50-86af-d4fd99f012e9
IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'kietna@smartosc.com')
    DROP USER [kietna@smartosc.com];
GO

CREATE USER [kietna@smartosc.com] WITH SID = 0xBEEEC6BF51E4504D86AFD4FD99F012E9, TYPE = E;
GO

ALTER ROLE db_datareader ADD MEMBER [kietna@smartosc.com];
GRANT EXECUTE ON OBJECT::dbo.sp_history_list    TO [kietna@smartosc.com];
GRANT EXECUTE ON OBJECT::dbo.sp_employee_list   TO [kietna@smartosc.com];
GRANT EXECUTE ON OBJECT::dbo.sp_match_candidates TO [kietna@smartosc.com];
GO

/* To let them write as well, add:
       ALTER ROLE db_datawriter ADD MEMBER [kietna@smartosc.com];
   To revoke entirely:
       DROP USER [kietna@smartosc.com];
*/

-- Verify
SELECT dp.name, dp.type_desc, r.name AS role_membership
FROM   sys.database_principals dp
LEFT  JOIN sys.database_role_members rm ON rm.member_principal_id = dp.principal_id
LEFT  JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
WHERE  dp.name IN ('kietna@smartosc.com', 'func-eds-dev')
ORDER  BY dp.name;
GO
