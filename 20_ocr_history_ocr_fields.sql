/* EDS — ocr_history.ocr_* (what the OCR read, before the operator edited it)

   18_ocr_history_operator.sql made Register (POST /api/history) write the ocr_history
   row, but only with the confirmed package fields and the operator: the seven ocr_*
   columns stayed NULL. sp_history_insert_v2 now takes them too.

   Safe to re-run. New parameters default to NULL, so the Function App in production
   (which does not send them yet) keeps working.

   Deploy order: this script -> Function App -> EDS-ProcessLabel / EDS-NotifySelected /
   Power App. */

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
