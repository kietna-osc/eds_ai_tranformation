/* EDS — Planner -> History status sync (branch feature/planner-sync)

   Additive and safe to re-run. Nothing existing changes:
     1. New procedure sp_history_planner_sync, used by POST /api/history/planner-sync
        (Function App, plannerSync.js) and the scheduled flow EDS-PlannerStatusSync.
     2. EXECUTE on it for [func-eds-dev].
   sp_set_delivered and the "When a task is completed" flow are left as they are.

   Run against eds-db in the Azure Portal Query editor, BEFORE deploying the Function
   App that calls it. */

------------------------------------------------------------------ 1. procedure
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

------------------------------------------------------------------ 2. permissions
GRANT EXECUTE ON OBJECT::dbo.sp_history_planner_sync TO [func-eds-dev];
GO

------------------------------------------------------------------ check
SELECT o.name AS procedure_name, pe.permission_name
FROM sys.database_permissions pe
JOIN sys.objects o ON o.object_id = pe.major_id
JOIN sys.database_principals pr ON pr.principal_id = pe.grantee_principal_id
WHERE pr.name = 'func-eds-dev' AND o.name = 'sp_history_planner_sync';
