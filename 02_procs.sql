/* EDS Phase 2 — stored procedures
   The API identity gets EXECUTE on these and nothing else, so a compromised
   backend is bounded to these operations rather than arbitrary SQL. */

------------------------------------------------- History page: list + filter
-- Serves both "latest 50" (no filters) and "latest 50 matching a filter".
-- OPTION (RECOMPILE) so each filter combination picks its own index instead of
-- reusing a cached plan built for a different one.
------------------------------------------------- History page: list + pagination
-- Filters are applied first, then page/page_size determine the returned chunk.
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

------------------------------------------------ Append (end of Power Automate flow)
CREATE OR ALTER PROCEDURE dbo.sp_history_insert
    @slip_no                   NVARCHAR(100),
    @image_url                 NVARCHAR(MAX),
    @sender_name               NVARCHAR(200)  = NULL,
    @sender_content            NVARCHAR(1000) = NULL,
    @sender_address            NVARCHAR(500)  = NULL,
    @employee_id               NVARCHAR(50)   = NULL,
    @recipient_name            NVARCHAR(200)  = NULL,
    @recipient_department_name NVARCHAR(200)  = NULL,
    @status                    VARCHAR(20)    = 'Notified',
    @data_type                 VARCHAR(20),
    @notified_at               DATETIME2(0)   = NULL,
    @planner_task_id           NVARCHAR(100)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    INSERT dbo.history (slip_no, image_url, sender_name, sender_content, sender_address,
                        employee_id,
                        recipient_name, recipient_department_name,
                        status, data_type, notified_at, planner_task_id)
    VALUES (@slip_no, @image_url, @sender_name, @sender_content, @sender_address,
            @employee_id,
            @recipient_name, @recipient_department_name,
            @status, @data_type, @notified_at, @planner_task_id);

    SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS history_id;
END
GO

-- Called after the flow creates the Planner task, to link it back to the package.
CREATE OR ALTER PROCEDURE dbo.sp_history_set_planner_task
    @history_id      BIGINT,
    @planner_task_id NVARCHAR(100)
AS
BEGIN
    SET NOCOUNT ON;
    UPDATE dbo.history SET planner_task_id = @planner_task_id WHERE history_id = @history_id;
    SELECT @@ROWCOUNT AS rows_updated;
END
GO

--------------------------------------------- Planner task completed
-- Idempotent: the Planner trigger can fire more than once for the same task, and
-- replaying must not move delivered_at. Accepts either key.
-- status becomes Delivered. delivered_at is written only the first time.
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

--------------------------------------------------------- Employee page: list + pagination
-- Filters (department, name keyword) are applied first, then page/page_size
-- determine the returned chunk. search_keyword is optional; omitted means all names.
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

------------------------------------------- OCR name -> candidate employees
-- Referenced by the schema sheet as the consumer of IX_employee_name_normalized.
-- @name_normalized must already be normalised by normalize.js (NFKC,
-- katakana->hiragana, whitespace stripped) so both sides match.
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

------------------------------------------- Roster for OCR fuzzy match
-- Active employees only; matching (exact / Levenshtein) runs in the Function.
CREATE OR ALTER PROCEDURE dbo.sp_employee_fuzzy_roster
AS
BEGIN
    SET NOCOUNT ON;
    SELECT employee_id, full_name, department_name, email
    FROM   dbo.employee
    ORDER BY full_name, employee_id;
END
GO

--------------------------------------------------------- Insert employee
-- employee_id is the employee code.
-- 50002: employee_id already used. 50003: email already used.
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

--------------------------------------------------------- Update employee
-- employee_id is the key and is not changed. The other columns match insert.
-- updated_at is set by TR_employee_updated_at.
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

--------------------------------------------------------- Delete employee
-- Hard delete by employee_id. history.employee_id is not a foreign key, so
-- package rows that still store this id are left in place.
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

--------------------------------------------------------- Department catalog
CREATE OR ALTER PROCEDURE dbo.sp_department_list
AS
BEGIN
    SET NOCOUNT ON;
    SELECT department_id, department_name, created_at, updated_at
    FROM   dbo.department
    ORDER BY department_name, department_id;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_department_insert
    @department_name NVARCHAR(200)
AS
BEGIN
    SET NOCOUNT ON;
    IF @department_name IS NULL OR LTRIM(RTRIM(@department_name)) = N''
        THROW 50001, 'sp_department_insert requires @department_name.', 1;

    INSERT dbo.department (department_name) VALUES (@department_name);
    SELECT department_id, department_name, created_at, updated_at
    FROM   dbo.department
    WHERE  department_id = SCOPE_IDENTITY();
END
GO

--------------------------------------------------------- OCR result log
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

------------------------------------------------ History list (same columns as sp_history_list)
CREATE OR ALTER PROCEDURE dbo.sp_history_list_v2
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
    EXEC dbo.sp_history_list
        @page, @page_size, @status, @data_type, @employee_id,
        @notified_start, @notified_end, @delivered_start, @delivered_end;
END
GO

------------------------------------------------ Append history (same columns as sp_history_insert)
-- Register (EDS-NotifySelected -> POST /api/history). Also logs the read in ocr_history
-- (raw ocr_* values and who pressed Register) in the same transaction: both rows or
-- neither, so the flow's retry never leaves a history row without its log.
CREATE OR ALTER PROCEDURE dbo.sp_history_insert_v2
    @slip_no                   NVARCHAR(100),
    @image_url                 NVARCHAR(MAX),
    @sender_name               NVARCHAR(200)  = NULL,
    @sender_content            NVARCHAR(1000) = NULL,
    @sender_address            NVARCHAR(500)  = NULL,
    @employee_id               NVARCHAR(50)   = NULL,
    @recipient_name            NVARCHAR(200)  = NULL,
    @recipient_department_name NVARCHAR(200)  = NULL,
    @status                    VARCHAR(20)    = 'Notified',
    @data_type                 VARCHAR(20),
    @notified_at               DATETIME2(0)   = NULL,
    @planner_task_id           NVARCHAR(100)  = NULL,
    @operator_name             NVARCHAR(200)  = NULL,
    @operator_email            NVARCHAR(320)  = NULL,
    @ocr_receipt_name          NVARCHAR(200)  = NULL,
    @ocr_receipt_department    NVARCHAR(200)  = NULL,
    @ocr_slip_no               NVARCHAR(100)  = NULL,
    @ocr_sender_name           NVARCHAR(200)  = NULL,
    @ocr_sender_content        NVARCHAR(1000) = NULL,
    @ocr_sender_address        NVARCHAR(500)  = NULL,
    @ocr_model_name            NVARCHAR(200)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    DECLARE @history_id BIGINT;

    -- Inserts itself (same columns as sp_history_insert) instead of calling it by
    -- position, so it never depends on that procedure's parameter order in the database.
    BEGIN TRANSACTION;
    INSERT dbo.history (slip_no, image_url, sender_name, sender_content, sender_address,
                        employee_id,
                        recipient_name, recipient_department_name,
                        status, data_type, notified_at, planner_task_id)
    VALUES (@slip_no, @image_url, @sender_name, @sender_content, @sender_address,
            @employee_id,
            @recipient_name, @recipient_department_name,
            @status, @data_type, @notified_at, @planner_task_id);
    SET @history_id = SCOPE_IDENTITY();

    INSERT dbo.ocr_history (
        history_id, slip_no, image_url,
        sender_name, sender_content, sender_address,
        employee_id, recipient_name, recipient_department_name,
        status, data_type, notified_at, planner_task_id,
        ocr_receipt_name, ocr_receipt_department, ocr_slip_no,
        ocr_sender_name, ocr_sender_content, ocr_sender_address, ocr_model_name,
        operator_name, operator_email
    )
    VALUES (
        @history_id, @slip_no, @image_url,
        @sender_name, @sender_content, @sender_address,
        @employee_id, @recipient_name, @recipient_department_name,
        @status, @data_type, @notified_at, @planner_task_id,
        @ocr_receipt_name, @ocr_receipt_department, @ocr_slip_no,
        @ocr_sender_name, @ocr_sender_content, @ocr_sender_address, @ocr_model_name,
        @operator_name, @operator_email
    );
    COMMIT TRANSACTION;

    SELECT @history_id AS history_id;
END
GO

------------------------------------------------ Upsert employees from a CSV import
-- @rows is a JSON array of { employee_id, full_name, email, department_name }.
-- employee_id is the employee code (社員番号). One transaction.
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

--------------------------------------------- Planner -> History status sync
-- Brings history rows in line with their Planner task.
--   @tasks_json  [{ "planner_task_id": "...", "completed": true|false, "completed_at": "ISO"|null }]
--   @snapshot_at when the flow started reading Planner (UTC)
--   @max_revert  most rows allowed to go back to Notified in one run
-- Task open + row delivered   -> Notified, delivered_at cleared.
--   Skipped when the row was delivered after @snapshot_at: the task list is older
--   than that delivery, so the task was completed again in the meantime.
-- Task completed + row not delivered -> Delivered, delivered_at = completed_at
--   (an existing delivered_at is kept, like sp_set_delivered).
-- Rows whose task is not in @tasks_json are never touched.
-- 50004: more than @max_revert rows would be reverted; everything is rolled back.
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

GRANT EXECUTE ON OBJECT::dbo.sp_history_list_v2   TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_history_insert_v2 TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_employee_upsert   TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_employee_update   TO [func-eds-dev];
GRANT EXECUTE ON OBJECT::dbo.sp_history_planner_sync TO [func-eds-dev];
GO
