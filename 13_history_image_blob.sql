/* EDS — scanned images in Azure Blob Storage, live release (branch release/history-blob)

   Additive and safe to re-run. Nothing existing is changed in a way the current
   Function App cannot handle:
     1. dbo.history: adds image_blob_path and preview_blob_path (empty for old rows).
     2. dbo.history.employee_id: becomes NVARCHAR(50) if it is still a number type,
        like dbo.employee.employee_id (some ids do not fit in INT, e.g. 10000000004).
        Skipped when it is already text.
     3. New procedures sp_history_list_v2 and sp_history_insert_v2, used by the new
        Function App. sp_history_list and sp_history_insert are left exactly as they
        are, so the previous Function App package keeps working (rollback).
     4. EXECUTE on the two new procedures for [func-eds-dev].

   Run against eds-db in the Azure Portal Query editor. Everything runs in one
   transaction; any error rolls the whole change back and names the cause. */

SET XACT_ABORT ON;
BEGIN TRANSACTION;

------------------------------------------------------------------ 1. new columns
IF COL_LENGTH('dbo.history', 'image_blob_path') IS NULL
    ALTER TABLE dbo.history ADD image_blob_path NVARCHAR(500) NULL;
IF COL_LENGTH('dbo.history', 'preview_blob_path') IS NULL
    ALTER TABLE dbo.history ADD preview_blob_path NVARCHAR(500) NULL;

------------------------------------------------------------------ 2. employee_id as text
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.history') AND name = 'employee_id'
      AND system_type_id IN (TYPE_ID('int'), TYPE_ID('bigint'), TYPE_ID('smallint'), TYPE_ID('decimal'), TYPE_ID('numeric'))
)
BEGIN
    DECLARE @hadIndex BIT = CASE WHEN EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_employee_id' AND object_id = OBJECT_ID('dbo.history')) THEN 1 ELSE 0 END;
    IF @hadIndex = 1 DROP INDEX IX_history_employee_id ON dbo.history;
    -- Fails (and rolls back) if another index or constraint uses the column; the error names it.
    ALTER TABLE dbo.history ALTER COLUMN employee_id NVARCHAR(50) NULL;
    IF @hadIndex = 1 CREATE INDEX IX_history_employee_id ON dbo.history (employee_id);
    PRINT 'dbo.history.employee_id -> NVARCHAR(50)';
END
ELSE PRINT 'dbo.history.employee_id is already text (no change)';

COMMIT;
GO

------------------------------------------------------------------ 3a. list + pagination
CREATE OR ALTER PROCEDURE dbo.sp_history_list_v2
    @page             INT           = 1,
    @page_size        INT           = 50,
    @status           VARCHAR(20)   = NULL,
    @department_id    INT           = NULL,
    @employee_id      NVARCHAR(50)  = NULL,
    @notified_start   DATETIME2(0)  = NULL,
    @notified_end     DATETIME2(0)  = NULL,
    @delivered_start  DATETIME2(0)  = NULL,
    @delivered_end    DATETIME2(0)  = NULL
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        history_id,
        slip_no,
        image_url,
        image_blob_path,
        preview_blob_path,
        sender_name,
        sender_content,
        sender_address,
        employee_id,
        recipient_name,
        recipient_department_id,
        recipient_department_name,
        status,
        notified_at,
        delivered_at,
        delivered_by,
        planner_task_id,
        created_at,
        updated_at,
        COUNT(*) OVER() AS total_count
    FROM dbo.history
    WHERE (@status IS NULL OR status = @status)
      AND (@department_id IS NULL OR recipient_department_id = @department_id)
      AND (@employee_id IS NULL OR employee_id = @employee_id)
      AND (@notified_start IS NULL OR notified_at >= @notified_start)
      AND (@notified_end IS NULL OR notified_at <= @notified_end)
      AND (@delivered_start IS NULL OR delivered_at >= @delivered_start)
      AND (@delivered_end IS NULL OR delivered_at <= @delivered_end)
    ORDER BY created_at DESC, history_id DESC
    OFFSET (@page - 1) * @page_size ROWS
    FETCH NEXT @page_size ROWS ONLY
    OPTION (RECOMPILE);
END
GO

------------------------------------------------------------------ 3b. append
CREATE OR ALTER PROCEDURE dbo.sp_history_insert_v2
    @slip_no                   NVARCHAR(100)  = NULL,
    @image_url                 NVARCHAR(MAX)  = NULL,
    @image_blob_path           NVARCHAR(500)  = NULL,
    @preview_blob_path         NVARCHAR(500)  = NULL,
    @sender_name               NVARCHAR(200)  = NULL,
    @sender_content            NVARCHAR(1000) = NULL,
    @sender_address            NVARCHAR(500)  = NULL,
    @employee_id               NVARCHAR(50)   = NULL,
    @recipient_name            NVARCHAR(200)  = NULL,
    @recipient_department_id   INT            = NULL,
    @recipient_department_name NVARCHAR(200)  = NULL,
    @status                    VARCHAR(20)    = 'Unknown',
    @notified_at               DATETIME2(0)   = NULL,
    @planner_task_id           NVARCHAR(100)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    INSERT dbo.history (slip_no, image_url, image_blob_path, preview_blob_path,
                        sender_name, sender_content, sender_address,
                        employee_id,
                        recipient_name, recipient_department_id, recipient_department_name,
                        status, notified_at, planner_task_id)
    VALUES (@slip_no, @image_url, @image_blob_path, @preview_blob_path,
            @sender_name, @sender_content, @sender_address,
            @employee_id,
            @recipient_name, @recipient_department_id, @recipient_department_name,
            @status, @notified_at, @planner_task_id);

    SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS history_id;
END
GO

------------------------------------------------------------------ 4. permissions
GRANT EXECUTE ON OBJECT::dbo.sp_history_list_v2   TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_history_insert_v2 TO [func-eds-dev];
GO

------------------------------------------------------------------ check
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'history'
  AND COLUMN_NAME IN ('employee_id', 'image_url', 'image_blob_path', 'preview_blob_path');

SELECT o.name AS procedure_name, pe.permission_name
FROM sys.database_permissions pe
JOIN sys.objects o ON o.object_id = pe.major_id
JOIN sys.database_principals pr ON pr.principal_id = pe.grantee_principal_id
WHERE pr.name = 'func-eds-dev' AND o.name LIKE 'sp_history_%_v2';
