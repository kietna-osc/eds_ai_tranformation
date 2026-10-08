/* EDS — dbo.employee back to the designed schema (01_schema.sql), with CSV import support.

   The live dbo.employee was recreated on 2026-10-06 08:31 UTC with six columns
   (employee_id NVARCHAR(50), full_name, department_name, email, created_at, updated_at).
   The app and EDS-APIManagement1 expect the designed table: employee_id INT,
   employee_code (社員番号), name_normalized, department_id, is_active.

   1. Copies the current table to dbo.employee_backup_20261008 (kept; drop it later).
   2. Re-creates dbo.employee as in 01_schema.sql, with its indexes and trigger.
   3. Copies the 2,007 rows:
        employee_code   = old employee_id (the 社員番号, e.g. 2012, 10000000004, test-3)
        employee_id     = the old id where it is a positive whole number that fits in INT
                          (history rows keep pointing at the same person); a new number otherwise
        name_normalized = full_name (as the CSV import does)
        department_id   = dbo.department matched by name (spaces and full-width digits ignored)
        email           = NULL when empty; is_active = 1
   4. Re-creates the employee procedures as in 02_procs.sql, plus sp_employee_upsert (CSV import).
   5. EXECUTE on sp_employee_upsert for [func-eds-dev].

   dbo.history is not touched. Run against eds-db in the Azure Portal Query editor.
   Steps 1-3 run in one transaction; any error rolls them back and the table stays as it was.
   Not meant to be run twice: it stops if the backup table already exists. */

SET XACT_ABORT ON;

IF OBJECT_ID('dbo.employee_backup_20261008', 'U') IS NOT NULL
    THROW 50000, 'dbo.employee_backup_20261008 already exists: this script has already run.', 1;
IF COL_LENGTH('dbo.employee', 'employee_code') IS NOT NULL
    THROW 50000, 'dbo.employee already has employee_code: nothing to migrate.', 1;

BEGIN TRANSACTION;

------------------------------------------------------------------ 1. backup
SELECT * INTO dbo.employee_backup_20261008 FROM dbo.employee;

------------------------------------------------------------------ 2. designed table
DROP TABLE dbo.employee;

-- Dynamic SQL: these statements refer to the new columns, so they are compiled only
-- when they run, after the old table has been dropped.
EXEC (N'CREATE TABLE dbo.employee
(
    employee_id      INT             IDENTITY(1,1) NOT NULL,
    employee_code    NVARCHAR(50)    NOT NULL,
    full_name        NVARCHAR(200)   NOT NULL,
    name_normalized  NVARCHAR(200)   NULL,
    department_id    INT             NULL,
    department_name  NVARCHAR(200)   NULL,
    email            NVARCHAR(320)   NULL,
    is_active        BIT             NOT NULL CONSTRAINT DF_employee_is_active  DEFAULT (1),
    created_at       DATETIME2(0)    NOT NULL CONSTRAINT DF_employee_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at       DATETIME2(0)    NOT NULL CONSTRAINT DF_employee_updated_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_employee       PRIMARY KEY CLUSTERED (employee_id),
    CONSTRAINT UQ_employee_code  UNIQUE (employee_code)
)');

EXEC (N'CREATE INDEX IX_employee_name_normalized ON dbo.employee (name_normalized)
    INCLUDE (full_name, department_id, department_name, email)
    WHERE is_active = 1');

EXEC (N'CREATE INDEX IX_employee_department_id ON dbo.employee (department_id)
    WHERE is_active = 1');

------------------------------------------------------------------ 3. data
-- Department lookup: names compared without spaces and with full-width digits as half-width,
-- the same rule as sp_employee_upsert.
SELECT b.employee_id                          AS old_id,
       TRY_CONVERT(INT, b.employee_id)        AS old_int,
       b.full_name, b.department_name, NULLIF(LTRIM(RTRIM(b.email)), N'') AS email,
       b.created_at, b.updated_at,
       (SELECT TOP 1 d.department_id FROM dbo.department d
        WHERE TRANSLATE(REPLACE(REPLACE(d.department_name, N' ', N''), N'　', N''), N'０１２３４５６７８９', N'0123456789')
            = TRANSLATE(REPLACE(REPLACE(b.department_name, N' ', N''), N'　', N''), N'０１２３４５６７８９', N'0123456789')
        ORDER BY d.department_id) AS department_id
INTO #src
FROM dbo.employee_backup_20261008 b;

-- Old ids that are positive whole numbers keep their number.
EXEC (N'SET IDENTITY_INSERT dbo.employee ON;
INSERT dbo.employee (employee_id, employee_code, full_name, name_normalized, department_id, department_name,
                     email, is_active, created_at, updated_at)
SELECT old_int, old_id, full_name, full_name, department_id, department_name, email, 1, created_at, updated_at
FROM #src
WHERE old_int > 0 AND old_id = CAST(old_int AS NVARCHAR(50));
SET IDENTITY_INSERT dbo.employee OFF;');

-- Everything else (e.g. 10000000004, test-3) gets the next free number.
EXEC (N'INSERT dbo.employee (employee_code, full_name, name_normalized, department_id, department_name,
                     email, is_active, created_at, updated_at)
SELECT old_id, full_name, full_name, department_id, department_name, email, 1, created_at, updated_at
FROM #src
WHERE NOT (old_int > 0 AND old_id = CAST(old_int AS NVARCHAR(50)))
ORDER BY old_id;');

IF (SELECT COUNT(*) FROM dbo.employee) <> (SELECT COUNT(*) FROM dbo.employee_backup_20261008)
    THROW 50000, 'Row count mismatch after copy; rolled back.', 1;

DROP TABLE #src;
COMMIT;
GO

CREATE TRIGGER dbo.TR_employee_updated_at ON dbo.employee AFTER UPDATE AS
BEGIN
    SET NOCOUNT ON;
    UPDATE e SET updated_at = SYSUTCDATETIME()
    FROM dbo.employee e JOIN inserted i ON e.employee_id = i.employee_id;
END
GO

------------------------------------------------------------------ 4. procedures (02_procs.sql)
--------------------------------------------------------- Employee page: list + pagination
-- Filters (department, name keyword) are applied first, then page/page_size
-- determine the returned chunk. search_keyword is optional; omitted means all names.
CREATE OR ALTER PROCEDURE dbo.sp_employee_list
    @page            INT          = 1,
    @page_size       INT          = 50,
    @department_id   INT          = NULL,
    @search_keyword  NVARCHAR(200) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        employee_id,
        employee_code,
        full_name,
        name_normalized,
        department_id,
        department_name,
        email,
        is_active,
        created_at,
        updated_at,
        COUNT(*) OVER() AS total_count
    FROM dbo.employee
    WHERE (@department_id IS NULL OR department_id = @department_id)
      AND (@search_keyword IS NULL
           OR name_normalized  LIKE @search_keyword + N'%'
           OR full_name        LIKE N'%' + @search_keyword + N'%'
           OR employee_code    LIKE @search_keyword + N'%'
           OR department_name  LIKE N'%' + @search_keyword + N'%'
           OR email            LIKE N'%' + @search_keyword + N'%')
    ORDER BY full_name, employee_id
    OFFSET (@page - 1) * @page_size ROWS
    FETCH NEXT @page_size ROWS ONLY
    OPTION (RECOMPILE);
END
GO

------------------------------------------- OCR name -> candidate employees
-- Referenced by the schema sheet as the consumer of IX_employee_name_normalized.
-- @name_normalized must already be normalised by normalize.js (NFKC,
-- katakana->hiragana, whitespace stripped) so both sides match.
CREATE OR ALTER PROCEDURE dbo.sp_match_candidates
    @name_normalized NVARCHAR(200),
    @department_id   INT = NULL,
    @top             INT = 10
AS
BEGIN
    SET NOCOUNT ON;
    SELECT TOP (@top)
           employee_id, employee_code, full_name, department_id, department_name, email,
           CASE WHEN name_normalized = @name_normalized THEN 100    -- exact
                WHEN name_normalized LIKE @name_normalized + N'%' THEN 80
                ELSE 60 END
           + CASE WHEN @department_id IS NOT NULL AND department_id = @department_id
                  THEN 10 ELSE 0 END AS match_score
    FROM   dbo.employee
    WHERE  is_active = 1
      AND  (name_normalized = @name_normalized
            OR name_normalized LIKE @name_normalized + N'%'
            OR @name_normalized LIKE name_normalized + N'%')
    ORDER BY match_score DESC, full_name
    OPTION (RECOMPILE);
END
GO

------------------------------------------- Roster for OCR fuzzy match
-- Active employees only; matching (exact / Levenshtein) runs in the Function.
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

--------------------------------------------------------- Insert employee
-- Caller supplies employee_id (IDENTITY_INSERT) so Power Apps can keep a
-- stable key. Duplicate PK / employee_code raises SQL 2627; the API maps that
-- to 409.
CREATE OR ALTER PROCEDURE dbo.sp_employee_insert
    @employee_id      INT,
    @employee_code    NVARCHAR(50),
    @full_name        NVARCHAR(200),
    @name_normalized  NVARCHAR(200) = NULL,
    @department_id    INT           = NULL,
    @department_name  NVARCHAR(200) = NULL,
    @email            NVARCHAR(320) = NULL,
    @is_active        BIT           = 1
AS
BEGIN
    SET NOCOUNT ON;
    IF @employee_id IS NULL OR @employee_id <= 0
        THROW 50001, 'sp_employee_insert requires a positive @employee_id.', 1;
    IF @employee_code IS NULL OR LTRIM(RTRIM(@employee_code)) = N''
        THROW 50001, 'sp_employee_insert requires @employee_code.', 1;
    IF @full_name IS NULL OR LTRIM(RTRIM(@full_name)) = N''
        THROW 50001, 'sp_employee_insert requires @full_name.', 1;

    IF @name_normalized IS NULL OR LTRIM(RTRIM(@name_normalized)) = N''
        SET @name_normalized = @full_name;

    BEGIN TRY
        SET IDENTITY_INSERT dbo.employee ON;
        INSERT dbo.employee (
            employee_id, employee_code, full_name, name_normalized,
            department_id, department_name, email, is_active
        )
        VALUES (
            @employee_id, @employee_code, @full_name, @name_normalized,
            @department_id, @department_name, @email, ISNULL(@is_active, 1)
        );
        SET IDENTITY_INSERT dbo.employee OFF;
    END TRY
    BEGIN CATCH
        SET IDENTITY_INSERT dbo.employee OFF;
        THROW;
    END CATCH

    SELECT employee_id, employee_code, full_name, name_normalized,
           department_id, department_name, email, is_active, created_at, updated_at
    FROM   dbo.employee
    WHERE  employee_id = @employee_id;
END
GO

--------------------------------------------------------- Delete employee
-- Hard delete by employee_id. history.employee_id is not a foreign key, so
-- package rows that still store this id are left in place.
CREATE OR ALTER PROCEDURE dbo.sp_employee_delete
    @employee_id INT
AS
BEGIN
    SET NOCOUNT ON;
    IF @employee_id IS NULL OR @employee_id <= 0
        THROW 50001, 'sp_employee_delete requires a positive @employee_id.', 1;

    DELETE FROM dbo.employee WHERE employee_id = @employee_id;
    SELECT @@ROWCOUNT AS rows_deleted;
END
GO

--------------------------------------------------------- CSV import (upsert)
-- @rows is a JSON array of already-validated rows:
--   [{"employee_code","full_name","email","department_name"}, ...]
-- An existing employee_code is updated with the file's data; a new one is
-- inserted (is_active = 1, employee_id from IDENTITY). The whole batch is one
-- transaction with XACT_ABORT, so any failure leaves no row written.
-- department_id comes from dbo.department by name, ignoring spaces and
-- full/half-width digits (same rule as 08_sync_employee_department_id.sql).
-- Returns one row per employee_code with action 'inserted' | 'updated'.
CREATE OR ALTER PROCEDURE dbo.sp_employee_upsert
    @rows NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @rows IS NULL OR ISJSON(@rows) <> 1
        THROW 50001, 'sp_employee_upsert requires @rows as a JSON array.', 1;

    DECLARE @src TABLE
    (
        employee_code    NVARCHAR(50)  NOT NULL PRIMARY KEY,
        full_name        NVARCHAR(200) NOT NULL,
        email            NVARCHAR(320) NULL,
        department_name  NVARCHAR(200) NULL,
        department_id    INT           NULL
    );

    INSERT @src (employee_code, full_name, email, department_name)
    SELECT employee_code, full_name, NULLIF(email, N''), NULLIF(department_name, N'')
    FROM   OPENJSON(@rows) WITH (
               employee_code    NVARCHAR(50)  '$.employee_code',
               full_name        NVARCHAR(200) '$.full_name',
               email            NVARCHAR(320) '$.email',
               department_name  NVARCHAR(200) '$.department_name');

    UPDATE s
    SET    s.department_id = d.department_id
    FROM   @src AS s
    JOIN   dbo.department AS d
      ON   TRANSLATE(REPLACE(REPLACE(s.department_name, N' ', N''), N'　', N''), N'０１２３４５６７８９', N'0123456789')
         = TRANSLATE(REPLACE(REPLACE(d.department_name, N' ', N''), N'　', N''), N'０１２３４５６７８９', N'0123456789');

    DECLARE @result TABLE (employee_code NVARCHAR(50), action VARCHAR(10));

    BEGIN TRANSACTION;

    UPDATE e
    SET    e.full_name       = s.full_name,
           e.name_normalized = s.full_name,
           e.email           = s.email,
           e.department_name = s.department_name,
           e.department_id   = s.department_id
    OUTPUT inserted.employee_code, 'updated' INTO @result
    FROM   dbo.employee AS e
    JOIN   @src AS s ON s.employee_code = e.employee_code;

    INSERT dbo.employee (employee_code, full_name, name_normalized,
                         department_id, department_name, email, is_active)
    OUTPUT inserted.employee_code, 'inserted' INTO @result
    SELECT s.employee_code, s.full_name, s.full_name,
           s.department_id, s.department_name, s.email, 1
    FROM   @src AS s
    WHERE  NOT EXISTS (SELECT 1 FROM dbo.employee AS e WHERE e.employee_code = s.employee_code);

    COMMIT TRANSACTION;

    SELECT employee_code, action FROM @result ORDER BY action, employee_code;
END
GO

------------------------------------------------------------------ 5. permissions
GRANT EXECUTE ON OBJECT::dbo.sp_employee_upsert TO [func-eds-dev];
GO

------------------------------------------------------------------ check
SELECT 'rows' AS what, CAST(COUNT(*) AS NVARCHAR(50)) AS value FROM dbo.employee
UNION ALL SELECT 'kept their old number', CAST(COUNT(*) AS NVARCHAR(50)) FROM dbo.employee WHERE employee_code = CAST(employee_id AS NVARCHAR(50))
UNION ALL SELECT 'new number (non-numeric or too large old id)', CAST(COUNT(*) AS NVARCHAR(50)) FROM dbo.employee WHERE employee_code <> CAST(employee_id AS NVARCHAR(50))
UNION ALL SELECT 'with department_id', CAST(COUNT(*) AS NVARCHAR(50)) FROM dbo.employee WHERE department_id IS NOT NULL
UNION ALL SELECT 'backup rows', CAST(COUNT(*) AS NVARCHAR(50)) FROM dbo.employee_backup_20261008;
