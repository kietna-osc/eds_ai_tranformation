/* EDS — dbo.employee: is_active (soft delete) and phone

   1. Two columns. Existing rows become active and have no phone:
        phone      NVARCHAR(20) NULL       half-width digits (checked by the app and the API),
                                           text so a leading 0 is kept
        is_active  BIT NOT NULL DEFAULT 1  BIT is SQL Server's boolean (1 = true); the API
                                           reads and writes it as JSON true / false
   2. Procedures (same names; every new parameter has a default, so the Function App
      deployed before this script keeps working):
        sp_employee_list          + phone, is_active
        sp_employee_insert        + @phone, @is_active (default active). 社員番号 and email
                                  stay unique over every row, deleted ones included.
        sp_employee_update        + @phone / @update_phone (0 = keep the phone),
                                  @is_active (NULL = keep). is_active 1 restores a deleted
                                  employee.
        sp_employee_delete        + @permanent. 0: soft delete (is_active = 0) of an active
                                  employee. 1: hard delete of an employee that is already
                                  deleted. Returns rows_deleted and found (the id exists).
        sp_employee_upsert        CSV import. Rows may carry phone. A 社員番号 already in the
                                  table only gets its phone filled when it has none; nothing
                                  else of an existing employee is changed.
        sp_employee_fuzzy_roster, sp_match_candidates   active employees only (OCR
                                  receiver candidates).
   Run against eds-db in the Azure Portal Query editor. Safe to run more than once. */

SET XACT_ABORT ON;
GO

---------------------------------------------------------------------- 1. columns
IF COL_LENGTH('dbo.employee', 'phone') IS NULL
    ALTER TABLE dbo.employee ADD phone NVARCHAR(20) NULL;
GO
IF COL_LENGTH('dbo.employee', 'is_active') IS NULL
    ALTER TABLE dbo.employee ADD is_active BIT NOT NULL
        CONSTRAINT DF_employee_is_active DEFAULT (1);
GO

---------------------------------------------------------------------- 2. procedures
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
        phone,
        is_active,
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
    WHERE  is_active = 1
      AND (REPLACE(full_name, N' ', N'') = @name_normalized
        OR REPLACE(full_name, N' ', N'') LIKE @name_normalized + N'%'
        OR @name_normalized LIKE REPLACE(full_name, N' ', N'') + N'%')
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
    WHERE  is_active = 1
    ORDER BY full_name, employee_id;
END
GO

-- 50002: employee_id already used. 50003: email already used (deleted employees included).
CREATE OR ALTER PROCEDURE dbo.sp_employee_insert
    @employee_id      NVARCHAR(50),
    @full_name        NVARCHAR(200),
    @department_name  NVARCHAR(200),
    @email            NVARCHAR(320),
    @phone            NVARCHAR(20) = NULL,
    @is_active        BIT          = 1
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

    INSERT dbo.employee (employee_id, full_name, department_name, email, phone, is_active)
    VALUES (@employee_id, @full_name, @department_name, @email,
            NULLIF(LTRIM(RTRIM(@phone)), N''), ISNULL(@is_active, 1));

    SELECT employee_id, full_name, department_name, email, phone, is_active, created_at, updated_at
    FROM   dbo.employee
    WHERE  employee_id = @employee_id;
END
GO

-- employee_id is the key and is not changed. @update_phone = 0 keeps the phone,
-- @is_active NULL keeps the state. updated_at is set by TR_employee_updated_at.
CREATE OR ALTER PROCEDURE dbo.sp_employee_update
    @employee_id      NVARCHAR(50),
    @full_name        NVARCHAR(200),
    @department_name  NVARCHAR(200),
    @email            NVARCHAR(320),
    @phone            NVARCHAR(20) = NULL,
    @update_phone     BIT          = 0,
    @is_active        BIT          = NULL
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
           email = @email,
           phone = CASE WHEN @update_phone = 1 THEN NULLIF(LTRIM(RTRIM(@phone)), N'') ELSE phone END,
           is_active = ISNULL(@is_active, is_active)
    WHERE  employee_id = @employee_id;

    SELECT employee_id, full_name, department_name, email, phone, is_active, created_at, updated_at
    FROM   dbo.employee
    WHERE  employee_id = @employee_id;
END
GO

-- @permanent = 0: soft delete (active -> deleted). @permanent = 1: removes the row, only
-- when it is already deleted. rows_deleted = rows changed; found = the id exists, so the
-- caller can tell "not found" from "wrong state". history.employee_id is not a foreign key.
CREATE OR ALTER PROCEDURE dbo.sp_employee_delete
    @employee_id NVARCHAR(50),
    @permanent   BIT = 0
AS
BEGIN
    SET NOCOUNT ON;
    IF @employee_id IS NULL OR LTRIM(RTRIM(@employee_id)) = N''
        THROW 50001, 'sp_employee_delete requires @employee_id.', 1;

    DECLARE @found BIT = CASE WHEN EXISTS (SELECT 1 FROM dbo.employee WHERE employee_id = @employee_id)
                              THEN 1 ELSE 0 END;
    DECLARE @n INT;
    IF ISNULL(@permanent, 0) = 1
    BEGIN
        DELETE FROM dbo.employee WHERE employee_id = @employee_id AND is_active = 0;
        SET @n = @@ROWCOUNT;
    END
    ELSE
    BEGIN
        UPDATE dbo.employee SET is_active = 0 WHERE employee_id = @employee_id AND is_active = 1;
        SET @n = @@ROWCOUNT;
    END
    SELECT @n AS rows_deleted, @found AS found;
END
GO

-- @rows: JSON array of { employee_id, full_name, email, department_name, phone? }.
-- New employees are inserted (active). An existing one only gets its phone filled when it
-- has none. One transaction.
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
        department_name NVARCHAR(200) NOT NULL,
        phone           NVARCHAR(20)  NULL
    );

    INSERT @incoming (employee_id, full_name, email, department_name, phone)
    SELECT employee_id, full_name, email, department_name, NULLIF(LTRIM(RTRIM(phone)), N'')
    FROM OPENJSON(@rows)
    WITH (
        employee_id     NVARCHAR(50)  '$.employee_id',
        full_name       NVARCHAR(200) '$.full_name',
        email           NVARCHAR(320) '$.email',
        department_name NVARCHAR(200) '$.department_name',
        phone           NVARCHAR(20)  '$.phone'
    );

    DECLARE @result TABLE (
        employee_id NVARCHAR(50) NOT NULL,
        action      NVARCHAR(10) NOT NULL
    );

    MERGE dbo.employee AS e
    USING @incoming AS i ON e.employee_id = i.employee_id
    WHEN MATCHED AND e.phone IS NULL AND i.phone IS NOT NULL THEN
        UPDATE SET e.phone = i.phone
    WHEN NOT MATCHED THEN
        INSERT (employee_id, full_name, email, department_name, phone)
        VALUES (i.employee_id, i.full_name, i.email, i.department_name, i.phone)
    OUTPUT inserted.employee_id, $action INTO @result;

    SELECT employee_id, action FROM @result;
END
GO
