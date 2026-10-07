/* EDS — dbo.history_blob.employee_id as text (branch feature/history-blob)

   Live dbo.employee stores employee_id as NVARCHAR, and some ids do not fit in
   INT (for example 10000000004). dbo.history_blob was created with INT, so a
   registration for such an employee was rejected. This changes the column to
   NVARCHAR(50), the same as the employee table.

   Run against eds-db once, then run 09_history_blob.sql again: that re-creates
   the procedures with the NVARCHAR(50) parameter. Safe to re-run. */

IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.history_blob') AND name = 'employee_id'
      AND system_type_id <> TYPE_ID('nvarchar')
)
BEGIN
    IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_history_blob_employee_id' AND object_id = OBJECT_ID('dbo.history_blob'))
        DROP INDEX IX_history_blob_employee_id ON dbo.history_blob;

    ALTER TABLE dbo.history_blob ALTER COLUMN employee_id NVARCHAR(50) NULL;

    CREATE INDEX IX_history_blob_employee_id ON dbo.history_blob (employee_id);
    PRINT 'dbo.history_blob.employee_id -> NVARCHAR(50)';
END
ELSE PRINT 'dbo.history_blob.employee_id is already NVARCHAR';

-- Check: should show nvarchar, 50.
SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'history_blob' AND COLUMN_NAME = 'employee_id';
