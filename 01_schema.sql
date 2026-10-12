/* EDS Phase 2 — schema v1.1
   Azure SQL Database: eds-db
   Source of truth: EDS_Phase2_DB_Schema_v1.0.xlsx (sheets: employee, history, Index & ràng buộc)
   Convention: snake_case; PK <table>_id; is_* flags; created_at / updated_at in UTC. */

------------------------------------------------------------------- employee
-- Read-only replica of the SharePoint employee list.
-- employee_id is the employee code (社員番号), not an identity integer.
-- Rebuild when an older shape (employee_code / INT identity) is still present.
IF OBJECT_ID('dbo.TR_employee_updated_at', 'TR') IS NOT NULL
    DROP TRIGGER dbo.TR_employee_updated_at;
GO
IF OBJECT_ID('dbo.employee', 'U') IS NOT NULL
   AND COL_LENGTH('dbo.employee', 'employee_code') IS NOT NULL
    DROP TABLE dbo.employee;
GO
IF OBJECT_ID('dbo.employee', 'U') IS NULL
CREATE TABLE dbo.employee
(
    employee_id      NVARCHAR(50)    NOT NULL,
    full_name        NVARCHAR(200)   NOT NULL,
    department_name  NVARCHAR(200)   NOT NULL,
    email            NVARCHAR(320)   NOT NULL,
    created_at       DATETIME2(0)    NOT NULL CONSTRAINT DF_employee_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at       DATETIME2(0)    NOT NULL CONSTRAINT DF_employee_updated_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_employee PRIMARY KEY CLUSTERED (employee_id)
);
GO

-- SQL Server has no ON UPDATE CURRENT_TIMESTAMP; updated_at is maintained by trigger.
IF OBJECT_ID('dbo.TR_employee_updated_at', 'TR') IS NOT NULL DROP TRIGGER dbo.TR_employee_updated_at;
GO
CREATE TRIGGER dbo.TR_employee_updated_at ON dbo.employee AFTER UPDATE AS
BEGIN
    SET NOCOUNT ON;
    UPDATE e SET updated_at = SYSUTCDATETIME()
    FROM dbo.employee e JOIN inserted i ON e.employee_id = i.employee_id;
END
GO

-------------------------------------------------------------------- history
IF OBJECT_ID('dbo.history', 'U') IS NULL
CREATE TABLE dbo.history
(
    history_id                 BIGINT          IDENTITY(1,1) NOT NULL,
    slip_no                    NVARCHAR(100)   NOT NULL,
    image_url                  NVARCHAR(MAX)   NOT NULL,
    sender_name                NVARCHAR(200)   NULL,
    sender_content             NVARCHAR(1000)  NULL,
    sender_address             NVARCHAR(500)   NULL,
    employee_id                NVARCHAR(50)    NULL,  -- snapshot of employee code, not a foreign key
    recipient_name             NVARCHAR(200)   NULL,
    recipient_department_name  NVARCHAR(200)   NULL,
    status                     VARCHAR(20)     NOT NULL CONSTRAINT DF_history_status     DEFAULT ('Notified'),
    data_type                  VARCHAR(20)     NOT NULL,
    notified_at                DATETIME2(0)    NULL,
    delivered_at               DATETIME2(0)    NULL,
    delivered_by               NVARCHAR(320)   NULL,
    planner_task_id            NVARCHAR(100)   NULL,
    created_at                 DATETIME2(0)    NOT NULL CONSTRAINT DF_history_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at                 DATETIME2(0)    NOT NULL CONSTRAINT DF_history_updated_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_history          PRIMARY KEY CLUSTERED (history_id),
    CONSTRAINT CK_history_status    CHECK (status IN ('Notified', 'Delivered')),
    CONSTRAINT CK_history_data_type CHECK (data_type IN ('Identified', 'Unknown'))
);
GO

-- Existing databases created before v1.1: add sender columns and tighten status.
IF COL_LENGTH('dbo.history', 'sender_name') IS NULL
    ALTER TABLE dbo.history ADD sender_name NVARCHAR(200) NULL;
IF COL_LENGTH('dbo.history', 'sender_content') IS NULL
    ALTER TABLE dbo.history ADD sender_content NVARCHAR(1000) NULL;
IF COL_LENGTH('dbo.history', 'sender_address') IS NULL
    ALTER TABLE dbo.history ADD sender_address NVARCHAR(500) NULL;
IF COL_LENGTH('dbo.history', 'data_type') IS NULL
    ALTER TABLE dbo.history ADD data_type VARCHAR(20) NULL;
GO

-- Drop the old status check before rewriting its values.
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_history_status' AND parent_object_id = OBJECT_ID('dbo.history'))
    ALTER TABLE dbo.history DROP CONSTRAINT CK_history_status;
IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_history_data_type' AND parent_object_id = OBJECT_ID('dbo.history'))
    ALTER TABLE dbo.history DROP CONSTRAINT CK_history_data_type;
GO
IF EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_history_status' AND parent_object_id = OBJECT_ID('dbo.history'))
    ALTER TABLE dbo.history DROP CONSTRAINT DF_history_status;
GO

-- Move the old status vocabulary (Unknown | Identified) into data_type.
-- status becomes the handover state: Delivered when delivered_at is set, otherwise Notified.
IF EXISTS (SELECT 1 FROM dbo.history WHERE status IN ('Unknown', 'Identified'))
BEGIN
    UPDATE dbo.history
    SET    data_type = CASE
               WHEN status = 'Identified' THEN 'Identified'
               WHEN status = 'Unknown' THEN 'Unknown'
               ELSE data_type
           END
    WHERE  status IN ('Unknown', 'Identified');

    UPDATE dbo.history
    SET    status = CASE WHEN delivered_at IS NOT NULL THEN 'Delivered' ELSE 'Notified' END
    WHERE  status IN ('Unknown', 'Identified');
END
GO
UPDATE dbo.history
SET    data_type = CASE WHEN employee_id IS NOT NULL THEN 'Identified' ELSE 'Unknown' END
WHERE  data_type IS NULL;
UPDATE dbo.history SET slip_no = N'' WHERE slip_no IS NULL;
UPDATE dbo.history SET image_url = N'' WHERE image_url IS NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_history_status' AND parent_object_id = OBJECT_ID('dbo.history'))
    ALTER TABLE dbo.history ADD CONSTRAINT DF_history_status DEFAULT ('Notified') FOR status;
ALTER TABLE dbo.history ALTER COLUMN image_url NVARCHAR(MAX) NOT NULL;
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_slip_no' AND object_id = OBJECT_ID('dbo.history'))
    DROP INDEX IX_history_slip_no ON dbo.history;
ALTER TABLE dbo.history ALTER COLUMN slip_no NVARCHAR(100) NOT NULL;
ALTER TABLE dbo.history ALTER COLUMN data_type VARCHAR(20) NOT NULL;
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_history_status' AND parent_object_id = OBJECT_ID('dbo.history'))
    ALTER TABLE dbo.history ADD CONSTRAINT CK_history_status CHECK (status IN ('Notified', 'Delivered'));
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_history_data_type' AND parent_object_id = OBJECT_ID('dbo.history'))
    ALTER TABLE dbo.history ADD CONSTRAINT CK_history_data_type CHECK (data_type IN ('Identified', 'Unknown'));
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_created_at' AND object_id = OBJECT_ID('dbo.history'))
CREATE INDEX IX_history_created_at ON dbo.history (created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_status' AND object_id = OBJECT_ID('dbo.history'))
CREATE INDEX IX_history_status ON dbo.history (status, created_at DESC);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_slip_no' AND object_id = OBJECT_ID('dbo.history'))
CREATE INDEX IX_history_slip_no ON dbo.history (slip_no);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_employee_id' AND object_id = OBJECT_ID('dbo.history'))
CREATE INDEX IX_history_employee_id ON dbo.history (employee_id);
GO
IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_department' AND object_id = OBJECT_ID('dbo.history'))
    DROP INDEX IX_history_department ON dbo.history;
GO
IF COL_LENGTH('dbo.history', 'recipient_department_id') IS NOT NULL
    ALTER TABLE dbo.history DROP COLUMN recipient_department_id;
IF COL_LENGTH('dbo.history', 'image_blob_path') IS NOT NULL
    ALTER TABLE dbo.history DROP COLUMN image_blob_path;
IF COL_LENGTH('dbo.history', 'preview_blob_path') IS NOT NULL
    ALTER TABLE dbo.history DROP COLUMN preview_blob_path;
GO
-- One Planner task maps to exactly one package; NULLs are not constrained.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_history_planner_task' AND object_id = OBJECT_ID('dbo.history'))
CREATE UNIQUE INDEX UQ_history_planner_task ON dbo.history (planner_task_id)
    WHERE planner_task_id IS NOT NULL;
GO

-- Drop the employee foreign key so deleting an employee does not require
-- deleting history rows that still store that employee_id.
IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_history_employee' AND parent_object_id = OBJECT_ID('dbo.history'))
    ALTER TABLE dbo.history DROP CONSTRAINT FK_history_employee;
GO

-- Older history rows stored the integer identity. Keep the digits as text.
-- The index must be dropped before the column type can change.
IF EXISTS (
    SELECT 1
    FROM sys.columns c
    JOIN sys.types t ON c.user_type_id = t.user_type_id
    WHERE c.object_id = OBJECT_ID('dbo.history')
      AND c.name = 'employee_id'
      AND t.name = 'int'
)
BEGIN
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_employee_id' AND object_id = OBJECT_ID('dbo.history'))
        DROP INDEX IX_history_employee_id ON dbo.history;
    ALTER TABLE dbo.history ALTER COLUMN employee_id NVARCHAR(50) NULL;
END
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_employee_id' AND object_id = OBJECT_ID('dbo.history'))
CREATE INDEX IX_history_employee_id ON dbo.history (employee_id);
GO

IF COL_LENGTH('dbo.history', 'ocr_name') IS NOT NULL
    ALTER TABLE dbo.history DROP COLUMN ocr_name;
IF COL_LENGTH('dbo.history', 'ocr_department') IS NOT NULL
    ALTER TABLE dbo.history DROP COLUMN ocr_department;
GO

----------------------------------------------------------------- department
IF OBJECT_ID('dbo.department', 'U') IS NULL
CREATE TABLE dbo.department
(
    department_id    INT             IDENTITY(1,1) NOT NULL,
    department_name  NVARCHAR(200)   NOT NULL,
    created_at       DATETIME2(0)    NOT NULL CONSTRAINT DF_department_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at       DATETIME2(0)    NOT NULL CONSTRAINT DF_department_updated_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_department          PRIMARY KEY CLUSTERED (department_id),
    CONSTRAINT UQ_department_name     UNIQUE (department_name)
);
GO

IF OBJECT_ID('dbo.TR_department_updated_at', 'TR') IS NOT NULL DROP TRIGGER dbo.TR_department_updated_at;
GO
CREATE TRIGGER dbo.TR_department_updated_at ON dbo.department AFTER UPDATE AS
BEGIN
    SET NOCOUNT ON;
    UPDATE d SET updated_at = SYSUTCDATETIME()
    FROM dbo.department d JOIN inserted i ON d.department_id = i.department_id;
END
GO

--------------------------------------------------------------- ocr_history
-- One row per OCR read: package columns plus the raw OCR values.
-- history_id is nullable so ON DELETE SET NULL can clear it when the package is removed.
-- Rebuild when the previous shape (column id, no ocr_id) is still present.
IF OBJECT_ID('dbo.ocr_history', 'U') IS NOT NULL
   AND COL_LENGTH('dbo.ocr_history', 'ocr_id') IS NULL
    DROP TABLE dbo.ocr_history;
GO
IF OBJECT_ID('dbo.ocr_history', 'U') IS NULL
CREATE TABLE dbo.ocr_history
(
    ocr_id                     BIGINT          IDENTITY(1,1) NOT NULL,
    history_id                 BIGINT          NULL,
    slip_no                    NVARCHAR(100)   NOT NULL,
    image_url                  NVARCHAR(MAX)   NOT NULL,
    sender_name                NVARCHAR(200)   NULL,
    sender_content             NVARCHAR(1000)  NULL,
    sender_address             NVARCHAR(500)   NULL,
    employee_id                NVARCHAR(50)    NULL,
    recipient_name             NVARCHAR(200)   NULL,
    recipient_department_name  NVARCHAR(200)   NULL,
    status                     VARCHAR(20)     NOT NULL CONSTRAINT DF_ocr_history_status DEFAULT ('Notified'),
    data_type                  VARCHAR(20)     NOT NULL,
    notified_at                DATETIME2(0)    NULL,
    delivered_at               DATETIME2(0)    NULL,
    delivered_by               NVARCHAR(320)   NULL,
    planner_task_id            NVARCHAR(100)   NULL,
    ocr_receipt_name           NVARCHAR(200)   NULL,
    ocr_receipt_department     NVARCHAR(200)   NULL,
    ocr_slip_no                NVARCHAR(100)   NULL,
    ocr_sender_name            NVARCHAR(200)   NULL,
    ocr_sender_content         NVARCHAR(1000)  NULL,
    ocr_sender_address         NVARCHAR(500)   NULL,
    ocr_model_name             NVARCHAR(200)   NULL,
    created_at                 DATETIME2(0)    NOT NULL CONSTRAINT DF_ocr_history_created_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_ocr_history PRIMARY KEY CLUSTERED (ocr_id),
    CONSTRAINT FK_ocr_history_history FOREIGN KEY (history_id) REFERENCES dbo.history (history_id) ON DELETE SET NULL,
    CONSTRAINT CK_ocr_history_status CHECK (status IN ('Notified', 'Delivered')),
    CONSTRAINT CK_ocr_history_data_type CHECK (data_type IN ('Identified', 'Unknown'))
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ocr_history_history_id' AND object_id = OBJECT_ID('dbo.ocr_history'))
CREATE INDEX IX_ocr_history_history_id ON dbo.ocr_history (history_id);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ocr_history_created_at' AND object_id = OBJECT_ID('dbo.ocr_history'))
CREATE INDEX IX_ocr_history_created_at ON dbo.ocr_history (created_at DESC);
GO

IF OBJECT_ID('dbo.TR_history_updated_at', 'TR') IS NOT NULL DROP TRIGGER dbo.TR_history_updated_at;
GO
CREATE TRIGGER dbo.TR_history_updated_at ON dbo.history AFTER UPDATE AS
BEGIN
    SET NOCOUNT ON;
    UPDATE h SET updated_at = SYSUTCDATETIME()
    FROM dbo.history h JOIN inserted i ON h.history_id = i.history_id;
END
GO
