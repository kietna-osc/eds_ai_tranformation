/* EDS — dbo.employee: remove is_active (soft delete) and phone

   Undoes 22_employee_active_phone.sql, which is no longer in the repository: the
   feature was dropped. Before 22, dbo.employee had neither column.

   1. Procedures, copied unchanged from 02_procs.sql (no phone, no is_active):
        sp_employee_list, sp_match_candidates, sp_employee_fuzzy_roster,
        sp_employee_insert, sp_employee_update, sp_employee_delete (deletes the row),
        sp_employee_upsert
   2. Employees soft-deleted by 22 (is_active = 0) are deleted for good.
      history.employee_id is not a foreign key, so their history rows are kept.
   3. The default constraint of is_active, then the columns is_active and phone.

   Works whether or not 22 was run: each step checks the columns first, and the
   statement that reads is_active is dynamic SQL, so every batch compiles on a table
   without the columns. Safe to run more than once.

   Order: deploy the Function App without phone / is_active first
   (deploy-*.ps1 -Parts api,apim), then this script (-Parts sql). The Function App
   of 22 passes @phone / @is_active / @permanent, which these procedures do not have.
   deploy/lib/sql.js runs the whole file in one transaction. Run by hand, a batch that
   fails leaves the earlier ones applied; that state still works with the Function App
   above, and running the file again finishes it. */

SET XACT_ABORT ON;
GO

---------------------------------------------------------------------- 1. procedures
CREATE OR ALTER PROCEDURE dbo.sp_employee_list
    @page             INT           = 1,
    @page_size        INT           = 50,
    @department_name  NVARCHAR(200) = NULL,
    @search_keyword   NVARCHAR(200) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        employee_id,
        full_name,
        department_name,
        email,
        created_at,
        updated_at,
        COUNT(*) OVER() AS total_count
    FROM dbo.employee
    WHERE (@department_name IS NULL OR department_name = @department_name)
      AND (@search_keyword IS NULL
           OR full_name       LIKE N'%' + @search_keyword + N'%'
           OR employee_id     LIKE @search_keyword + N'%'
           OR department_name LIKE N'%' + @search_keyword + N'%'
           OR email           LIKE N'%' + @search_keyword + N'%')
    ORDER BY full_name, employee_id
    OFFSET (@page - 1) * @page_size ROWS
    FETCH NEXT @page_size ROWS ONLY
    OPTION (RECOMPILE);
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_match_candidates
    @name_normalized NVARCHAR(200),
    @department_name NVARCHAR(200) = NULL,
    @top             INT = 10
AS
BEGIN
    SET NOCOUNT ON;
    SELECT TOP (@top)
           employee_id, full_name, department_name, email,
           CASE WHEN REPLACE(full_name, N' ', N'') = @name_normalized THEN 100
                WHEN REPLACE(full_name, N' ', N'') LIKE @name_normalized + N'%' THEN 80
                ELSE 60 END
           + CASE WHEN @department_name IS NOT NULL AND department_name = @department_name
                  THEN 10 ELSE 0 END AS match_score
    FROM   dbo.employee
    WHERE  REPLACE(full_name, N' ', N'') = @name_normalized
        OR REPLACE(full_name, N' ', N'') LIKE @name_normalized + N'%'
        OR @name_normalized LIKE REPLACE(full_name, N' ', N'') + N'%'
    ORDER BY match_score DESC, full_name
    OPTION (RECOMPILE);
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_employee_fuzzy_roster
AS
BEGIN
    SET NOCOUNT ON;
    SELECT employee_id, full_name, department_name, email
    FROM   dbo.employee
    ORDER BY full_name, employee_id;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_employee_insert
    @employee_id      NVARCHAR(50),
    @full_name        NVARCHAR(200),
    @department_name  NVARCHAR(200),
    @email            NVARCHAR(320)
AS
BEGIN
    SET NOCOUNT ON;
    IF @employee_id IS NULL OR LTRIM(RTRIM(@employee_id)) = N''
        THROW 50001, 'sp_employee_insert requires @employee_id.', 1;
    IF @full_name IS NULL OR LTRIM(RTRIM(@full_name)) = N''
        THROW 50001, 'sp_employee_insert requires @full_name.', 1;
    IF @department_name IS NULL OR LTRIM(RTRIM(@department_name)) = N''
        THROW 50001, 'sp_employee_insert requires @department_name.', 1;
    IF @email IS NULL OR LTRIM(RTRIM(@email)) = N''
        THROW 50001, 'sp_employee_insert requires @email.', 1;
    IF EXISTS (SELECT 1 FROM dbo.employee WHERE employee_id = @employee_id)
        THROW 50002, N'このIDは既に他の従業員に使用されている', 1;
    IF EXISTS (SELECT 1 FROM dbo.employee WHERE email = @email)
        THROW 50003, N'このメールアドレスは既に他の従業員に使用されている', 1;

    INSERT dbo.employee (employee_id, full_name, department_name, email)
    VALUES (@employee_id, @full_name, @department_name, @email);

    SELECT employee_id, full_name, department_name, email, created_at, updated_at
    FROM   dbo.employee
    WHERE  employee_id = @employee_id;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_employee_update
    @employee_id      NVARCHAR(50),
    @full_name        NVARCHAR(200),
    @department_name  NVARCHAR(200),
    @email            NVARCHAR(320)
AS
BEGIN
    SET NOCOUNT ON;
    IF @employee_id IS NULL OR LTRIM(RTRIM(@employee_id)) = N''
        THROW 50001, 'sp_employee_update requires @employee_id.', 1;
    IF @full_name IS NULL OR LTRIM(RTRIM(@full_name)) = N''
        THROW 50001, 'sp_employee_update requires @full_name.', 1;
    IF @department_name IS NULL OR LTRIM(RTRIM(@department_name)) = N''
        THROW 50001, 'sp_employee_update requires @department_name.', 1;
    IF @email IS NULL OR LTRIM(RTRIM(@email)) = N''
        THROW 50001, 'sp_employee_update requires @email.', 1;

    UPDATE dbo.employee
    SET    full_name = @full_name,
           department_name = @department_name,
           email = @email
    WHERE  employee_id = @employee_id;

    SELECT employee_id, full_name, department_name, email, created_at, updated_at
    FROM   dbo.employee
    WHERE  employee_id = @employee_id;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_employee_delete
    @employee_id NVARCHAR(50)
AS
BEGIN
    SET NOCOUNT ON;
    IF @employee_id IS NULL OR LTRIM(RTRIM(@employee_id)) = N''
        THROW 50001, 'sp_employee_delete requires @employee_id.', 1;

    DELETE FROM dbo.employee WHERE employee_id = @employee_id;
    SELECT @@ROWCOUNT AS rows_deleted;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_employee_upsert
    @rows NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @incoming TABLE (
        employee_id     NVARCHAR(50)  NOT NULL PRIMARY KEY,
        full_name       NVARCHAR(200) NOT NULL,
        email           NVARCHAR(320) NOT NULL,
        department_name NVARCHAR(200) NOT NULL
    );

    INSERT @incoming (employee_id, full_name, email, department_name)
    SELECT employee_id, full_name, email, department_name
    FROM OPENJSON(@rows)
    WITH (
        employee_id     NVARCHAR(50)  '$.employee_id',
        full_name       NVARCHAR(200) '$.full_name',
        email           NVARCHAR(320) '$.email',
        department_name NVARCHAR(200) '$.department_name'
    );

    DECLARE @result TABLE (
        employee_id NVARCHAR(50) NOT NULL,
        action      NVARCHAR(10) NOT NULL
    );

    MERGE dbo.employee AS e
    USING @incoming AS i ON e.employee_id = i.employee_id
    WHEN MATCHED THEN
        UPDATE SET e.full_name = i.full_name,
                   e.email = i.email,
                   e.department_name = i.department_name
    WHEN NOT MATCHED THEN
        INSERT (employee_id, full_name, email, department_name)
        VALUES (i.employee_id, i.full_name, i.email, i.department_name)
    OUTPUT inserted.employee_id, $action INTO @result;

    SELECT employee_id, action FROM @result;
END
GO

------------------------------------------------- 2. soft-deleted employees: delete
IF COL_LENGTH('dbo.employee', 'is_active') IS NOT NULL
    EXEC sp_executesql N'DELETE FROM dbo.employee WHERE is_active = 0;
SELECT @@ROWCOUNT AS soft_deleted_rows_removed;';
GO

------------------------------------------------- 3. default constraint and columns
DECLARE @drop_defaults NVARCHAR(MAX) =
    (SELECT STRING_AGG(N'ALTER TABLE dbo.employee DROP CONSTRAINT ' + QUOTENAME(dc.name) + N';', N' ')
     FROM   sys.default_constraints dc
     JOIN   sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
     WHERE  dc.parent_object_id = OBJECT_ID(N'dbo.employee')
       AND  c.name IN (N'is_active', N'phone'));
IF @drop_defaults IS NOT NULL
    EXEC sp_executesql @drop_defaults;
GO
IF COL_LENGTH('dbo.employee', 'is_active') IS NOT NULL
    ALTER TABLE dbo.employee DROP COLUMN is_active;
GO
IF COL_LENGTH('dbo.employee', 'phone') IS NOT NULL
    ALTER TABLE dbo.employee DROP COLUMN phone;
GO
