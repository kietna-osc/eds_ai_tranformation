/* EDS — drop tables the app no longer uses

   The app only uses dbo.employee, dbo.history and dbo.ocr_history.
   dbo.deploy_log is kept: the deploy runner (deploy/lib/sql.js) records applied
   scripts there, and without it every script would run again from 01_*.

   Dropped (if present):
     department                  catalog no longer used; department_name is stored as text
     employee_backup_20261008    copy made by 14_employee_schema.sql
     employee_test               created by hand, not used by the code
     history_test                created by hand, not used by the code
     history_blob                created by hand, not used by the code

   The deploy runner runs this file in one transaction, so a failure drops nothing.
   Running it by hand (Query editor): it is safe to run more than once. */

------------------------------------------------- department procs
DROP PROCEDURE IF EXISTS dbo.sp_department_list;
DROP PROCEDURE IF EXISTS dbo.sp_department_insert;
GO

------------------------------------------------- foreign keys pointing at the dropped tables
DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql += N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(fk.parent_object_id)) + N'.'
             + QUOTENAME(OBJECT_NAME(fk.parent_object_id))
             + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';' + CHAR(10)
FROM sys.foreign_keys fk
WHERE OBJECT_SCHEMA_NAME(fk.referenced_object_id) = N'dbo'
  AND OBJECT_NAME(fk.referenced_object_id) IN
      (N'department', N'employee_backup_20261008', N'employee_test', N'history_test', N'history_blob');
IF @sql <> N''
BEGIN
    PRINT @sql;
    EXEC sys.sp_executesql @sql;
END
GO

------------------------------------------------- tables (their triggers go with them)
DROP TABLE IF EXISTS dbo.history_test;
DROP TABLE IF EXISTS dbo.history_blob;
DROP TABLE IF EXISTS dbo.employee_test;
DROP TABLE IF EXISTS dbo.employee_backup_20261008;
DROP TABLE IF EXISTS dbo.department;
GO
