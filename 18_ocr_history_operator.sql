/* EDS — ocr_history.operator_name / operator_email (who pressed Register)

   Additive and safe to re-run:
     1. Two nullable columns on ocr_history.
     2. sp_history_insert_v2 (POST /api/history, called by EDS-NotifySelected) also writes
        the ocr_history row, operator included, in the same transaction. New parameters
        default to NULL, so the Function App in production keeps working.

   Deploy order: 17 -> this script -> Function App -> 19_drop_delivered_by.sql.
   The new Function App sends @operator_name / @operator_email, which only this
   script's sp_history_insert_v2 accepts. */

------------------------------------------------------------------ 1. columns
IF COL_LENGTH('dbo.ocr_history', 'operator_name') IS NULL
    ALTER TABLE dbo.ocr_history ADD operator_name NVARCHAR(200) NULL;
IF COL_LENGTH('dbo.ocr_history', 'operator_email') IS NULL
    ALTER TABLE dbo.ocr_history ADD operator_email NVARCHAR(320) NULL;
GO

------------------------------------------------------------------ 2. procedure
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
    @operator_email            NVARCHAR(320)  = NULL
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
        operator_name, operator_email
    )
    VALUES (
        @history_id, @slip_no, @image_url,
        @sender_name, @sender_content, @sender_address,
        @employee_id, @recipient_name, @recipient_department_name,
        @status, @data_type, @notified_at, @planner_task_id,
        @operator_name, @operator_email
    );
    COMMIT TRANSACTION;

    SELECT @history_id AS history_id;
END
GO
