/* EDS — history with images in Azure Blob Storage (branch feature/history-blob)

   dbo.history_blob is a separate copy of dbo.history with two extra columns:
       image_blob_path    path of the original image in the blob container
       preview_blob_path  path of the 320 px preview
   Only the blob variant (func-eds-blob-dev, EDS-NotifySelected-blob) uses it.
   dbo.history and its procedures are not touched.

   Run against eds-db after 01_schema.sql and 02_procs.sql. Safe to re-run. */

----------------------------------------------------------------- history_blob
IF OBJECT_ID('dbo.history_blob', 'U') IS NULL
CREATE TABLE dbo.history_blob
(
    history_id                 BIGINT          IDENTITY(1,1) NOT NULL,
    slip_no                    NVARCHAR(100)   NULL,
    image_url                  NVARCHAR(MAX)   NULL,  -- SharePoint URL or path, kept as fallback
    image_blob_path            NVARCHAR(500)   NULL,  -- e.g. 2026/10/<id>.jpg
    preview_blob_path          NVARCHAR(500)   NULL,  -- e.g. 2026/10/<id>_preview.jpg
    sender_name                NVARCHAR(200)   NULL,
    sender_content             NVARCHAR(1000)  NULL,
    sender_address             NVARCHAR(500)   NULL,
    employee_id                INT             NULL,  -- snapshot id, not a foreign key
    recipient_name             NVARCHAR(200)   NULL,
    recipient_department_id    INT             NULL,
    recipient_department_name  NVARCHAR(200)   NULL,
    status                     VARCHAR(20)     NOT NULL CONSTRAINT DF_history_blob_status     DEFAULT ('Unknown'),
    notified_at                DATETIME2(0)    NULL,
    delivered_at               DATETIME2(0)    NULL,
    delivered_by               NVARCHAR(320)   NULL,
    planner_task_id            NVARCHAR(100)   NULL,
    created_at                 DATETIME2(0)    NOT NULL CONSTRAINT DF_history_blob_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at                 DATETIME2(0)    NOT NULL CONSTRAINT DF_history_blob_updated_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_history_blob        PRIMARY KEY CLUSTERED (history_id),
    CONSTRAINT CK_history_blob_status CHECK (status IN ('Unknown', 'Identified'))
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_blob_created_at' AND object_id = OBJECT_ID('dbo.history_blob'))
CREATE INDEX IX_history_blob_created_at ON dbo.history_blob (created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_blob_status' AND object_id = OBJECT_ID('dbo.history_blob'))
CREATE INDEX IX_history_blob_status ON dbo.history_blob (status, created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_blob_slip_no' AND object_id = OBJECT_ID('dbo.history_blob'))
CREATE INDEX IX_history_blob_slip_no ON dbo.history_blob (slip_no);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_blob_employee_id' AND object_id = OBJECT_ID('dbo.history_blob'))
CREATE INDEX IX_history_blob_employee_id ON dbo.history_blob (employee_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_blob_department' AND object_id = OBJECT_ID('dbo.history_blob'))
CREATE INDEX IX_history_blob_department ON dbo.history_blob (recipient_department_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_history_blob_planner_task' AND object_id = OBJECT_ID('dbo.history_blob'))
CREATE UNIQUE INDEX UQ_history_blob_planner_task ON dbo.history_blob (planner_task_id)
    WHERE planner_task_id IS NOT NULL;
GO

IF OBJECT_ID('dbo.TR_history_blob_updated_at', 'TR') IS NOT NULL DROP TRIGGER dbo.TR_history_blob_updated_at;
GO
CREATE TRIGGER dbo.TR_history_blob_updated_at ON dbo.history_blob AFTER UPDATE AS
BEGIN
    SET NOCOUNT ON;
    UPDATE h SET updated_at = SYSUTCDATETIME()
    FROM dbo.history_blob h JOIN inserted i ON h.history_id = i.history_id;
END
GO

------------------------------------------------- list + pagination (same as sp_history_list)
CREATE OR ALTER PROCEDURE dbo.sp_history_blob_list
    @page             INT          = 1,
    @page_size        INT          = 50,
    @status           VARCHAR(20)  = NULL,
    @department_id    INT          = NULL,
    @employee_id      INT          = NULL,
    @notified_start   DATETIME2(0) = NULL,
    @notified_end     DATETIME2(0) = NULL,
    @delivered_start  DATETIME2(0) = NULL,
    @delivered_end    DATETIME2(0) = NULL
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
    FROM dbo.history_blob
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

------------------------------------------------ append (end of EDS-NotifySelected-blob)
CREATE OR ALTER PROCEDURE dbo.sp_history_blob_insert
    @slip_no                   NVARCHAR(100)  = NULL,
    @image_url                 NVARCHAR(MAX)  = NULL,
    @image_blob_path           NVARCHAR(500)  = NULL,
    @preview_blob_path         NVARCHAR(500)  = NULL,
    @sender_name               NVARCHAR(200)  = NULL,
    @sender_content            NVARCHAR(1000) = NULL,
    @sender_address            NVARCHAR(500)  = NULL,
    @employee_id               INT            = NULL,
    @recipient_name            NVARCHAR(200)  = NULL,
    @recipient_department_id   INT            = NULL,
    @recipient_department_name NVARCHAR(200)  = NULL,
    @status                    VARCHAR(20)    = 'Unknown',
    @notified_at               DATETIME2(0)   = NULL,
    @planner_task_id           NVARCHAR(100)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    INSERT dbo.history_blob (slip_no, image_url, image_blob_path, preview_blob_path,
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
