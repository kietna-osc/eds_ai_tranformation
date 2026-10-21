/* EDS — history / ocr_history: one new row per Planner task change (no UPDATE)

   Until now the Planner flows overwrote the package's history row (status,
   delivered_at), so the earlier state was lost: a reopened task even cleared
   delivered_at. From this script on, every change of the task INSERTs a new row
   ("version") into dbo.history and a matching row into dbo.ocr_history; rows already
   written are never changed. The History screen shows the latest version of each
   package.

     1. No new column. Every version of a package keeps created_at = when it was
        registered; updated_at of a version is when that row was written. When the
        status changed: delivered_at for a Delivered version (Planner's
        completedDateTime), updated_at for a reopened one (Planner does not record
        when a task is reopened, so this is when the sync found it).
     2. Versions of one package share its planner_task_id (one task per package), so
        UQ_history_planner_task becomes the non-unique IX_history_planner_task. A
        package without a task has one row only. The latest version is the highest
        history_id (created_at has whole seconds only, two changes can share one).
     3. Procedures (same names, parameters and result columns as before):
        sp_history_insert_v2    Register. Rejects a planner_task_id already registered
                                (50002, what the unique index did for flow retries).
        sp_history_list         History screen (sp_history_list_v2 calls it): latest
                                version of each package; filters apply to that version.
                                history_id = the package's first row, so it never
                                changes; created_at = registered, updated_at = when
                                the latest version was written.
        sp_set_delivered        Inserts a Delivered version. Already Delivered: nothing
                                added.
        sp_history_planner_sync Inserts a Notified version for each reopened task and a
                                Delivered version for each completion the trigger missed.
        sp_history_set_planner_task  Links a task to a package that has none yet (only
                                its single row exists); never relinks.
        Each new history row gets an ocr_history row: the same package columns, plus the
        ocr_* / operator_* values of the package's latest earlier ocr_history row that has
        any (normally the Register row). Earlier rows are found through history_id, not
        ocr_history.planner_task_id: a Register log written before its task was linked
        (the old sp_history_set_planner_task updated history only) has none.

     4. An earlier draft of this script added task_changed_at to history and
        ocr_history. It duplicated delivered_at (Done) and updated_at (reopen), so
        step 3 drops it where it exists, after the procedures above stop using it.

   Safe to re-run. Deploy order: this script -> Function App (the old Function App
   also keeps working with this script). */

------------------------------------------------------------------ 1. planner_task_id index
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_history_planner_task' AND object_id = OBJECT_ID('dbo.history'))
    DROP INDEX UQ_history_planner_task ON dbo.history;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_planner_task' AND object_id = OBJECT_ID('dbo.history'))
    CREATE INDEX IX_history_planner_task ON dbo.history (planner_task_id, history_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ocr_history_planner_task' AND object_id = OBJECT_ID('dbo.ocr_history'))
    CREATE INDEX IX_ocr_history_planner_task ON dbo.ocr_history (planner_task_id, ocr_id);
GO

------------------------------------------------------------------ 2. procedures
------------------------------------------------- History page: list + pagination
-- Latest version of each package (versions share planner_task_id; a package without
-- a task is its own single row). Filters apply to that latest version, then
-- page/page_size determine the returned chunk.
-- history_id is the package's first row, so a row keeps its id when a version is
-- added; created_at is when it was registered, updated_at when the latest version
-- was written.
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

    WITH versions AS (
        SELECT h.*,
               ROW_NUMBER()      OVER (PARTITION BY k.package_key ORDER BY h.history_id DESC) AS version_desc,
               MIN(h.history_id) OVER (PARTITION BY k.package_key) AS package_history_id,
               MIN(h.created_at) OVER (PARTITION BY k.package_key) AS registered_at
        FROM dbo.history h
        CROSS APPLY (SELECT ISNULL(h.planner_task_id, N'#' + CONVERT(NVARCHAR(20), h.history_id)) AS package_key) k
    )
    SELECT
        package_history_id AS history_id,
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
        registered_at      AS created_at,
        updated_at,
        history_id         AS version_history_id,
        COUNT(*) OVER() AS total_count
    FROM versions
    WHERE version_desc = 1
      AND (@status IS NULL OR status = @status)
      AND (@data_type IS NULL OR data_type = @data_type)
      AND (@employee_id IS NULL OR employee_id = @employee_id)
      AND (@notified_start IS NULL OR notified_at >= @notified_start)
      AND (@notified_end IS NULL OR notified_at <= @notified_end)
      AND (@delivered_start IS NULL OR delivered_at >= @delivered_start)
      AND (@delivered_end IS NULL OR delivered_at <= @delivered_end)
    ORDER BY registered_at DESC, package_history_id DESC
    OFFSET (@page - 1) * @page_size ROWS
    FETCH NEXT @page_size ROWS ONLY
    OPTION (RECOMPILE);
END
GO

-- Links a Planner task to a package registered without one (its only row and its
-- ocr_history row). A package that already has a task, or a task already used by
-- another package, is left alone (rows_updated 0); the same link again returns 1.
CREATE OR ALTER PROCEDURE dbo.sp_history_set_planner_task
    @history_id      BIGINT,
    @planner_task_id NVARCHAR(100)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    DECLARE @rows INT;

    BEGIN TRANSACTION;
    IF EXISTS (SELECT 1 FROM dbo.history WHERE history_id = @history_id AND planner_task_id = @planner_task_id)
        SET @rows = 1;
    ELSE
    BEGIN
        UPDATE dbo.history
        SET    planner_task_id = @planner_task_id
        WHERE  history_id = @history_id
          AND  planner_task_id IS NULL
          AND  NOT EXISTS (SELECT 1 FROM dbo.history WITH (UPDLOCK, HOLDLOCK)
                           WHERE planner_task_id = @planner_task_id);
        SET @rows = @@ROWCOUNT;
        IF @rows > 0
            UPDATE dbo.ocr_history
            SET    planner_task_id = @planner_task_id
            WHERE  history_id = @history_id AND planner_task_id IS NULL;
    END
    COMMIT TRANSACTION;

    SELECT @rows AS rows_updated;
END
GO

--------------------------------------------- Planner task completed
-- Adds a Delivered version of the package (history + ocr_history). Idempotent: the
-- Planner trigger can fire more than once, and when the latest version is already
-- Delivered nothing is added (rows_updated is still 1). Accepts either key.
CREATE OR ALTER PROCEDURE dbo.sp_set_delivered
    @planner_task_id NVARCHAR(100) = NULL,
    @history_id      BIGINT        = NULL,
    @delivered_at    DATETIME2(0)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @planner_task_id IS NULL AND @history_id IS NULL
        THROW 50001, 'sp_set_delivered requires @planner_task_id or @history_id.', 1;

    IF @planner_task_id IS NULL
    BEGIN
        SELECT @planner_task_id = planner_task_id FROM dbo.history WHERE history_id = @history_id;
        IF @@ROWCOUNT = 0
        BEGIN
            SELECT 0 AS rows_updated;
            RETURN;
        END
        IF @planner_task_id IS NULL
            THROW 50001, 'This package has no Planner task, so it cannot be marked delivered.', 1;
    END

    DECLARE @latest BIGINT, @latest_status VARCHAR(20);
    DECLARE @new TABLE (history_id BIGINT NOT NULL PRIMARY KEY);

    BEGIN TRANSACTION;
    -- UPDLOCK + HOLDLOCK: a concurrent trigger or sync for this task waits here.
    SELECT TOP (1) @latest = history_id, @latest_status = status
    FROM   dbo.history WITH (UPDLOCK, HOLDLOCK)
    WHERE  planner_task_id = @planner_task_id
    ORDER  BY history_id DESC;

    IF @latest IS NULL
    BEGIN
        COMMIT TRANSACTION;
        SELECT 0 AS rows_updated;
        RETURN;
    END

    IF @latest_status <> 'Delivered'
    BEGIN
        INSERT dbo.history (slip_no, image_url, sender_name, sender_content, sender_address,
                            employee_id, recipient_name, recipient_department_name,
                            status, data_type, notified_at, delivered_at, planner_task_id,
                            created_at)
        OUTPUT inserted.history_id INTO @new (history_id)
        SELECT slip_no, image_url, sender_name, sender_content, sender_address,
               employee_id, recipient_name, recipient_department_name,
               'Delivered', data_type, notified_at,
               COALESCE(@delivered_at, SYSUTCDATETIME()), planner_task_id, created_at
        FROM   dbo.history
        WHERE  history_id = @latest;

        INSERT dbo.ocr_history (
            history_id, slip_no, image_url,
            sender_name, sender_content, sender_address,
            employee_id, recipient_name, recipient_department_name,
            status, data_type, notified_at, delivered_at, planner_task_id,
            ocr_receipt_name, ocr_receipt_department, ocr_slip_no,
            ocr_sender_name, ocr_sender_content, ocr_sender_address, ocr_model_name,
            operator_name, operator_email
        )
        SELECT h.history_id, h.slip_no, h.image_url,
               h.sender_name, h.sender_content, h.sender_address,
               h.employee_id, h.recipient_name, h.recipient_department_name,
               h.status, h.data_type, h.notified_at, h.delivered_at, h.planner_task_id,
               p.ocr_receipt_name, p.ocr_receipt_department, p.ocr_slip_no,
               p.ocr_sender_name, p.ocr_sender_content, p.ocr_sender_address, p.ocr_model_name,
               p.operator_name, p.operator_email
        FROM   dbo.history h
        JOIN   @new n ON n.history_id = h.history_id
        OUTER APPLY (SELECT TOP (1) o.*
                     FROM   dbo.ocr_history o
                     JOIN   dbo.history hp ON hp.history_id = o.history_id
                     WHERE  hp.planner_task_id = h.planner_task_id AND hp.history_id <> h.history_id
                     ORDER  BY CASE WHEN COALESCE(o.operator_name, o.operator_email, o.ocr_receipt_name,
                                                  o.ocr_receipt_department, o.ocr_slip_no, o.ocr_sender_name,
                                                  o.ocr_sender_content, o.ocr_sender_address,
                                                  o.ocr_model_name) IS NOT NULL THEN 0 ELSE 1 END,
                               o.ocr_id DESC) p;
    END
    COMMIT TRANSACTION;

    SELECT 1 AS rows_updated;
END
GO

------------------------------------------------ Append history (same columns as sp_history_insert)
-- Register (EDS-NotifySelected -> POST /api/history). Also logs the read in ocr_history
-- (raw ocr_* values and who pressed Register) in the same transaction: both rows or
-- neither, so the flow's retry never leaves a history row without its log.
-- A planner_task_id that is already registered is rejected (50002 -> 409): later rows
-- of a task are versions of its package, added by the Planner procedures only.
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
    IF @planner_task_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM dbo.history WITH (UPDLOCK, HOLDLOCK)
                   WHERE planner_task_id = @planner_task_id)
        THROW 50002, N'同じデータが既に登録されています', 1;

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

------------------------------------------------ Daily reconciliation with Planner
-- Called by POST /api/history/planner-sync with every task of the EDS plan.
-- Compares each task with the latest version of its package and adds a version
-- (history + ocr_history) when they disagree:
-- Task open + latest delivered      -> Notified version, delivered_at NULL.
--   Skipped when the latest version was delivered after @snapshot_at: the task list
--   is older than that delivery, so the task was completed again in the meantime.
-- Task completed + latest not delivered -> Delivered version, delivered_at =
--   completed_at (an existing delivered_at is kept).
-- New versions keep the package's created_at (registered).
-- Packages whose task is not in @tasks_json are never touched.
-- 50004: more than @max_revert packages would be reverted; everything is rolled back.
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

    DECLARE @latest TABLE
    (
        history_id   BIGINT        NOT NULL PRIMARY KEY,
        action       VARCHAR(10)   NOT NULL,   -- revert | deliver
        completed_at DATETIME2(0)  NULL
    );
    DECLARE @new TABLE (history_id BIGINT NOT NULL PRIMARY KEY);
    DECLARE @reverted_count INT, @delivered_count INT;

    BEGIN TRANSACTION;

    -- Latest version of each task's package, locked until commit.
    INSERT @latest (history_id, action, completed_at)
    SELECT v.history_id,
           CASE WHEN t.is_completed = 1 THEN 'deliver' ELSE 'revert' END,
           t.completed_at
    FROM   @planner_tasks t
    CROSS APPLY (SELECT TOP (1) h.history_id, h.status, h.delivered_at
                 FROM   dbo.history h WITH (UPDLOCK, HOLDLOCK)
                 WHERE  h.planner_task_id = t.planner_task_id
                 ORDER  BY h.history_id DESC) v
    WHERE  (t.is_completed = 0
            AND (v.status = 'Delivered' OR v.delivered_at IS NOT NULL)
            AND (v.delivered_at IS NULL OR v.delivered_at < @snapshot_at))
       OR  (t.is_completed = 1 AND v.status <> 'Delivered');

    SELECT @reverted_count  = COUNT(CASE WHEN action = 'revert'  THEN 1 END),
           @delivered_count = COUNT(CASE WHEN action = 'deliver' THEN 1 END)
    FROM   @latest;

    IF @reverted_count > @max_revert
    BEGIN
        DECLARE @too_many_reverts NVARCHAR(400) = FORMATMESSAGE(
            N'planner sync stopped: %d rows would go back to Notified, more than max_revert (%d). Nothing was changed.',
            @reverted_count, @max_revert);
        THROW 50004, @too_many_reverts, 1;  -- XACT_ABORT rolls the transaction back
    END

    INSERT dbo.history (slip_no, image_url, sender_name, sender_content, sender_address,
                        employee_id, recipient_name, recipient_department_name,
                        status, data_type, notified_at, delivered_at, planner_task_id,
                        created_at)
    OUTPUT inserted.history_id INTO @new (history_id)
    SELECT h.slip_no, h.image_url, h.sender_name, h.sender_content, h.sender_address,
           h.employee_id, h.recipient_name, h.recipient_department_name,
           CASE l.action WHEN 'deliver' THEN 'Delivered' ELSE 'Notified' END,
           h.data_type, h.notified_at,
           CASE l.action WHEN 'deliver' THEN COALESCE(h.delivered_at, l.completed_at, @snapshot_at) END,
           h.planner_task_id,
           h.created_at
    FROM   @latest l
    JOIN   dbo.history h ON h.history_id = l.history_id
    ORDER  BY h.history_id;

    INSERT dbo.ocr_history (
        history_id, slip_no, image_url,
        sender_name, sender_content, sender_address,
        employee_id, recipient_name, recipient_department_name,
        status, data_type, notified_at, delivered_at, planner_task_id,
        ocr_receipt_name, ocr_receipt_department, ocr_slip_no,
        ocr_sender_name, ocr_sender_content, ocr_sender_address, ocr_model_name,
        operator_name, operator_email
    )
    SELECT h.history_id, h.slip_no, h.image_url,
           h.sender_name, h.sender_content, h.sender_address,
           h.employee_id, h.recipient_name, h.recipient_department_name,
           h.status, h.data_type, h.notified_at, h.delivered_at, h.planner_task_id,
           p.ocr_receipt_name, p.ocr_receipt_department, p.ocr_slip_no,
           p.ocr_sender_name, p.ocr_sender_content, p.ocr_sender_address, p.ocr_model_name,
           p.operator_name, p.operator_email
    FROM   dbo.history h
    JOIN   @new n ON n.history_id = h.history_id
    OUTER APPLY (SELECT TOP (1) o.*
                 FROM   dbo.ocr_history o
                 JOIN   dbo.history hp ON hp.history_id = o.history_id
                 WHERE  hp.planner_task_id = h.planner_task_id AND hp.history_id <> h.history_id
                 ORDER  BY CASE WHEN COALESCE(o.operator_name, o.operator_email, o.ocr_receipt_name,
                                              o.ocr_receipt_department, o.ocr_slip_no, o.ocr_sender_name,
                                              o.ocr_sender_content, o.ocr_sender_address,
                                              o.ocr_model_name) IS NOT NULL THEN 0 ELSE 1 END,
                           o.ocr_id DESC) p
    ORDER  BY h.history_id;

    COMMIT TRANSACTION;

    SELECT (SELECT COUNT(*) FROM @planner_tasks) AS checked_count,
           @reverted_count                       AS reverted_count,
           @delivered_count                      AS delivered_count;
END
GO

------------------------------------------------------------------ 3. drop task_changed_at (earlier draft)
-- Runs after the procedures are recreated without it. Values are not needed:
-- Done = delivered_at, reopen = updated_at of that version.
IF COL_LENGTH('dbo.history', 'task_changed_at') IS NOT NULL
    ALTER TABLE dbo.history DROP COLUMN task_changed_at;
IF COL_LENGTH('dbo.ocr_history', 'task_changed_at') IS NOT NULL
    ALTER TABLE dbo.ocr_history DROP COLUMN task_changed_at;
GO
