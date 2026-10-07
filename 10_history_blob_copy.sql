/* EDS — one-time copy of dbo.history into dbo.history_blob (branch feature/history-blob)

   Copies every row, keeping history_id, except rows whose image_url is a base64
   data URI (left over from the rolled-back base64 variant). Copied rows have no
   blob paths, so the History screen shows their SharePoint thumbnail as before.
   After the copy the two tables are independent: live registrations keep going
   to dbo.history, blob-variant registrations go to dbo.history_blob.

   Run against eds-db after 09_history_blob.sql. Does nothing if
   dbo.history_blob already has rows. */

SET XACT_ABORT ON;

IF EXISTS (SELECT 1 FROM dbo.history_blob)
BEGIN
    PRINT 'dbo.history_blob already has rows; nothing copied.';
END
ELSE
BEGIN
    BEGIN TRANSACTION;

    SET IDENTITY_INSERT dbo.history_blob ON;

    INSERT dbo.history_blob (history_id, slip_no, image_url, sender_name, sender_content, sender_address,
                             employee_id, recipient_name, recipient_department_id, recipient_department_name,
                             status, notified_at, delivered_at, delivered_by, planner_task_id,
                             created_at, updated_at)
    SELECT history_id, slip_no, image_url, sender_name, sender_content, sender_address,
           employee_id, recipient_name, recipient_department_id, recipient_department_name,
           status, notified_at, delivered_at, delivered_by, planner_task_id,
           created_at, updated_at
    FROM dbo.history
    WHERE image_url IS NULL OR image_url NOT LIKE 'data:%';

    PRINT CONCAT(@@ROWCOUNT, ' rows copied.');

    SET IDENTITY_INSERT dbo.history_blob OFF;

    COMMIT;
END
GO

-- Check: row counts of both tables (history may include base64 rows not copied).
SELECT 'history' AS tbl, COUNT(*) AS rows_ FROM dbo.history
UNION ALL
SELECT 'history_blob', COUNT(*) FROM dbo.history_blob;
