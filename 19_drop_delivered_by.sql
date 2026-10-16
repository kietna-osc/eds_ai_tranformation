/* EDS — drop history.delivered_by / ocr_history.delivered_by (受取担当者)

   Nothing ever filled delivered_by and nothing reads it; it only fed the empty
   受取担当者 column of the History CSV. Safe to re-run.
     1. Procedures recreated without delivered_by (same as 02_procs.sql):
        sp_history_list, sp_set_delivered, sp_ocr_history_insert, sp_history_planner_sync.
     2. The two columns are dropped.

   Deploy order: 17 -> 18 -> Function App -> this script (Azure Portal Query editor).
   The Function App must go first: the old one still sends @delivered_by, which
   sp_set_delivered / sp_ocr_history_insert no longer accept. Needs 18 (the
   operator columns used by sp_ocr_history_insert). */

------------------------------------------------------------------ 1. procedures
CREATE OR ALTER PROCEDURE dbo.sp_history_list
    @page             INT          = 1,
    @page_size        INT          = 50,
    @status           VARCHAR(20)  = NULL,
    @data_type        VARCHAR(20)  = NULL,
    @employee_id      NVARCHAR(50) = NULL,
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
        sender_name,
        sender_content,
        sender_address,
        employee_id,
        recipient_name,
        recipient_department_name,
        status,
        data_type,
        notified_at,
        delivered_at,
        planner_task_id,
        created_at,
        updated_at,
        COUNT(*) OVER() AS total_count
    FROM dbo.history
    WHERE (@status IS NULL OR status = @status)
      AND (@data_type IS NULL OR data_type = @data_type)
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


CREATE OR ALTER PROCEDURE dbo.sp_set_delivered
    @planner_task_id NVARCHAR(100) = NULL,
    @history_id      BIGINT        = NULL,
    @delivered_at    DATETIME2(0)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @planner_task_id IS NULL AND @history_id IS NULL
        THROW 50001, 'sp_set_delivered requires @planner_task_id or @history_id.', 1;

    UPDATE dbo.history
    SET    delivered_at = COALESCE(delivered_at, @delivered_at, SYSUTCDATETIME()),
           status       = 'Delivered'
    WHERE  (@planner_task_id IS NOT NULL AND planner_task_id = @planner_task_id)
       OR  (@history_id      IS NOT NULL AND history_id      = @history_id);

    SELECT @@ROWCOUNT AS rows_updated;
END
GO


CREATE OR ALTER PROCEDURE dbo.sp_ocr_history_insert
    @history_id                 BIGINT         = NULL,
    @slip_no                    NVARCHAR(100),
    @image_url                  NVARCHAR(MAX),
    @sender_name                NVARCHAR(200)  = NULL,
    @sender_content             NVARCHAR(1000) = NULL,
    @sender_address             NVARCHAR(500)  = NULL,
    @employee_id                NVARCHAR(50)   = NULL,
    @recipient_name             NVARCHAR(200)  = NULL,
    @recipient_department_name  NVARCHAR(200)  = NULL,
    @status                     VARCHAR(20)    = 'Notified',
    @data_type                  VARCHAR(20),
    @notified_at                DATETIME2(0)   = NULL,
    @delivered_at               DATETIME2(0)   = NULL,
    @planner_task_id            NVARCHAR(100)  = NULL,
    @ocr_receipt_name           NVARCHAR(200)  = NULL,
    @ocr_receipt_department     NVARCHAR(200)  = NULL,
    @ocr_slip_no                NVARCHAR(100)  = NULL,
    @ocr_sender_name            NVARCHAR(200)  = NULL,
    @ocr_sender_content         NVARCHAR(1000) = NULL,
    @ocr_sender_address         NVARCHAR(500)  = NULL,
    @ocr_model_name             NVARCHAR(200)  = NULL,
    @operator_name              NVARCHAR(200)  = NULL,
    @operator_email             NVARCHAR(320)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @slip_no IS NULL OR LTRIM(RTRIM(@slip_no)) = N''
        THROW 50001, 'sp_ocr_history_insert requires @slip_no.', 1;
    IF @image_url IS NULL OR LTRIM(RTRIM(@image_url)) = N''
        THROW 50001, 'sp_ocr_history_insert requires @image_url.', 1;
    IF @data_type IS NULL OR @data_type NOT IN ('Identified', 'Unknown')
        THROW 50001, 'sp_ocr_history_insert requires @data_type Identified or Unknown.', 1;
    IF @status IS NULL OR @status NOT IN ('Notified', 'Delivered')
        THROW 50001, 'sp_ocr_history_insert requires @status Notified or Delivered.', 1;

    INSERT dbo.ocr_history (
        history_id, slip_no, image_url,
        sender_name, sender_content, sender_address,
        employee_id, recipient_name, recipient_department_name,
        status, data_type, notified_at, delivered_at, planner_task_id,
        ocr_receipt_name, ocr_receipt_department, ocr_slip_no,
        ocr_sender_name, ocr_sender_content, ocr_sender_address, ocr_model_name,
        operator_name, operator_email
    )
    VALUES (
        @history_id, @slip_no, @image_url,
        @sender_name, @sender_content, @sender_address,
        @employee_id, @recipient_name, @recipient_department_name,
        @status, @data_type, @notified_at, @delivered_at, @planner_task_id,
        @ocr_receipt_name, @ocr_receipt_department, @ocr_slip_no,
        @ocr_sender_name, @ocr_sender_content, @ocr_sender_address, @ocr_model_name,
        @operator_name, @operator_email
    );

    SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS ocr_id;
END
GO


CREATE OR ALTER PROCEDURE dbo.sp_history_planner_sync
    @tasks_json  NVARCHAR(MAX),
    @snapshot_at DATETIME2(0),
    @max_revert  INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @planner_tasks TABLE
    (
        planner_task_id NVARCHAR(100) NOT NULL PRIMARY KEY,
        is_completed    BIT           NOT NULL,
        completed_at    DATETIME2(0)  NULL
    );

    -- Style 127 reads ISO 8601 with the trailing Z sent by the Function App.
    INSERT @planner_tasks (planner_task_id, is_completed, completed_at)
    SELECT planner_task_id, completed, TRY_CONVERT(DATETIME2(0), completed_at, 127)
    FROM OPENJSON(@tasks_json)
         WITH (planner_task_id NVARCHAR(100) '$.planner_task_id',
               completed       BIT           '$.completed',
               completed_at    NVARCHAR(40)  '$.completed_at');

    DECLARE @reverted_count INT, @delivered_count INT;

    BEGIN TRANSACTION;

    -- Reopened in Planner -> back to 通知済み.
    UPDATE h
    SET    status       = 'Notified',
           delivered_at = NULL
    FROM   dbo.history h
    JOIN   @planner_tasks t ON t.planner_task_id = h.planner_task_id
    WHERE  t.is_completed = 0
      AND  (h.status = 'Delivered' OR h.delivered_at IS NOT NULL)
      AND  (h.delivered_at IS NULL OR h.delivered_at < @snapshot_at);
    SET @reverted_count = @@ROWCOUNT;

    IF @reverted_count > @max_revert
    BEGIN
        DECLARE @too_many_reverts NVARCHAR(400) = FORMATMESSAGE(
            N'planner sync stopped: %d rows would go back to Notified, more than max_revert (%d). Nothing was changed.',
            @reverted_count, @max_revert);
        THROW 50004, @too_many_reverts, 1;  -- XACT_ABORT rolls the transaction back
    END

    -- Completed in Planner but the trigger missed it -> 受取済み.
    UPDATE h
    SET    status       = 'Delivered',
           delivered_at = COALESCE(h.delivered_at, t.completed_at, @snapshot_at)
    FROM   dbo.history h
    JOIN   @planner_tasks t ON t.planner_task_id = h.planner_task_id
    WHERE  t.is_completed = 1
      AND  h.status <> 'Delivered';
    SET @delivered_count = @@ROWCOUNT;

    COMMIT TRANSACTION;

    SELECT (SELECT COUNT(*) FROM @planner_tasks) AS checked_count,
           @reverted_count                       AS reverted_count,
           @delivered_count                      AS delivered_count;
END
GO

------------------------------------------------------------------ 2. columns
IF COL_LENGTH('dbo.history', 'delivered_by') IS NOT NULL
    ALTER TABLE dbo.history DROP COLUMN delivered_by;
GO
IF COL_LENGTH('dbo.ocr_history', 'delivered_by') IS NOT NULL
    ALTER TABLE dbo.ocr_history DROP COLUMN delivered_by;
GO
