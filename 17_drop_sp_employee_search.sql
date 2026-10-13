/* Drops dbo.sp_employee_search.
   It reads employee_code, department_id, is_active and name_normalized, which dbo.employee
   no longer has, so every call fails. Nothing calls it (not the Function App, the flows or
   the app). It also makes SqlPackage refuse to export the database, which setup-test.ps1
   needs.
   Definition at the time it was dropped (2026-10-13; last modified 2026-09-17):

-- --------------------------------------------------------- Search bar (Employee)
-- CREATE   PROCEDURE dbo.sp_employee_search
--     @q             NVARCHAR(200),
--     @top           INT = 25,
--     @department_id INT = NULL
-- AS
-- BEGIN
--     SET NOCOUNT ON;
--     SELECT TOP (@top)
--            employee_id, employee_code, full_name, name_normalized,
--            department_id, department_name, email
--     FROM   dbo.employee
--     WHERE  is_active = 1
--       AND  (@department_id IS NULL OR department_id = @department_id)
--       AND  (name_normalized LIKE @q + N'%'          -- index seek, the common case
--             OR full_name    LIKE N'%' + @q + N'%'
--             OR employee_code LIKE @q + N'%')
--     ORDER BY CASE WHEN name_normalized LIKE @q + N'%' THEN 0 ELSE 1 END, full_name
--     OPTION (RECOMPILE);
-- END
*/

IF OBJECT_ID(N'dbo.sp_employee_search', N'P') IS NOT NULL
    DROP PROCEDURE dbo.sp_employee_search;
GO
