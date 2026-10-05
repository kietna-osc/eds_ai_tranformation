/* Drop employee rows whose name or department is null or a placeholder.
   Keeps real names and real department names, including short ones such as 総務部.
   history.employee_id is not a foreign key, so history rows are left in place. */
SET NOCOUNT ON;

SELECT employee_id, employee_code, full_name, department_name, email
FROM dbo.employee
WHERE
    full_name IS NULL
    OR LTRIM(RTRIM(full_name)) = N''
    OR LEN(LTRIM(RTRIM(full_name))) <= 1
    OR LOWER(LTRIM(RTRIM(full_name))) IN (N'abc', N'test', N'demo', N'guest', N'xxx', N'sample', N'dummy')
    OR LOWER(LTRIM(RTRIM(full_name))) LIKE N'demo%'
    OR department_name IS NULL
    OR LTRIM(RTRIM(department_name)) = N''
    OR LOWER(LTRIM(RTRIM(department_name))) IN (N'abc', N'test', N'demo', N'guest', N'xxx', N'sample', N'dummy', N'new department')
    OR LOWER(LTRIM(RTRIM(department_name))) LIKE N'abc%';
GO

DELETE FROM dbo.employee
WHERE
    full_name IS NULL
    OR LTRIM(RTRIM(full_name)) = N''
    OR LEN(LTRIM(RTRIM(full_name))) <= 1
    OR LOWER(LTRIM(RTRIM(full_name))) IN (N'abc', N'test', N'demo', N'guest', N'xxx', N'sample', N'dummy')
    OR LOWER(LTRIM(RTRIM(full_name))) LIKE N'demo%'
    OR department_name IS NULL
    OR LTRIM(RTRIM(department_name)) = N''
    OR LOWER(LTRIM(RTRIM(department_name))) IN (N'abc', N'test', N'demo', N'guest', N'xxx', N'sample', N'dummy', N'new department')
    OR LOWER(LTRIM(RTRIM(department_name))) LIKE N'abc%';
GO
