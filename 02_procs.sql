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
    @department_id    INT          = NULL,
    @employee_id      INT          = NULL,
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
        recipient_department_id,
        recipient_department_name,
        status,
        notified_at,
        delivered_at,
        delivered_by,
        planner_task_id,
        created_at,
        updated_at,
        COUNT(*) OVER() AS total_count
    FROM dbo.history
    WHERE (@status IS NULL OR status = @status)
      AND (@department_id IS NULL OR recipient_department_id = @department_id)
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
    @slip_no                   NVARCHAR(100)  = NULL,
    @image_url                 NVARCHAR(MAX)  = NULL,  -- base64 data URI; a shorter type silently truncates it
    @sender_name               NVARCHAR(200)  = NULL,
    @sender_content            NVARCHAR(1000) = NULL,
    @sender_address            NVARCHAR(500)  = NULL,
    @employee_id               INT            = NULL,
    @recipient_name            NVARCHAR(200)  = NULL,
    @recipient_department_id   INT            = NULL,
    @recipient_department_name NVARCHAR(200)  = NULL,
    @status                    VARCHAR(20)    = 'Unknown',
    @notified_at               DATETIME2(0)   = NULL,
    @planner_task_id           NVARCHAR(100)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    INSERT dbo.history (slip_no, image_url, sender_name, sender_content, sender_address,
                        employee_id,
                        recipient_name, recipient_department_id, recipient_department_name,
                        status, notified_at, planner_task_id)
    VALUES (@slip_no, @image_url, @sender_name, @sender_content, @sender_address,
            @employee_id,
            @recipient_name, @recipient_department_id, @recipient_department_name,
            @status, @notified_at, @planner_task_id);

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
-- Identification status (Unknown | Identified) is left unchanged.
CREATE OR ALTER PROCEDURE dbo.sp_set_delivered
    @planner_task_id NVARCHAR(100) = NULL,
    @history_id      BIGINT        = NULL,
    @delivered_by    NVARCHAR(320) = NULL,
    @delivered_at    DATETIME2(0)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    IF @planner_task_id IS NULL AND @history_id IS NULL
        THROW 50001, 'sp_set_delivered requires @planner_task_id or @history_id.', 1;

    UPDATE dbo.history
    SET    delivered_at = COALESCE(delivered_at, @delivered_at, SYSUTCDATETIME()),
           delivered_by = COALESCE(delivered_by, @delivered_by)
    WHERE  (@planner_task_id IS NOT NULL AND planner_task_id = @planner_task_id)
       OR  (@history_id      IS NOT NULL AND history_id      = @history_id);

    SELECT @@ROWCOUNT AS rows_updated;
END
GO

--------------------------------------------------------- Employee page: list + pagination
-- Filters (department, name keyword) are applied first, then page/page_size
-- determine the returned chunk. search_keyword is optional; omitted means all names.
CREATE OR ALTER PROCEDURE dbo.sp_employee_list
    @page            INT          = 1,
    @page_size       INT          = 50,
    @department_id   INT          = NULL,
    @search_keyword  NVARCHAR(200) = NULL
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        employee_id,
        employee_code,
        full_name,
        name_normalized,
        department_id,
        department_name,
        email,
        is_active,
        created_at,
        updated_at,
        COUNT(*) OVER() AS total_count
    FROM dbo.employee
    WHERE (@department_id IS NULL OR department_id = @department_id)
      AND (@search_keyword IS NULL
           OR name_normalized  LIKE @search_keyword + N'%'
           OR full_name        LIKE N'%' + @search_keyword + N'%'
           OR employee_code    LIKE @search_keyword + N'%'
           OR department_name  LIKE N'%' + @search_keyword + N'%'
           OR email            LIKE N'%' + @search_keyword + N'%')
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
    @department_id   INT = NULL,
    @top             INT = 10
AS
BEGIN
    SET NOCOUNT ON;
    SELECT TOP (@top)
           employee_id, employee_code, full_name, department_id, department_name, email,
           CASE WHEN name_normalized = @name_normalized THEN 100    -- exact
                WHEN name_normalized LIKE @name_normalized + N'%' THEN 80
                ELSE 60 END
           + CASE WHEN @department_id IS NOT NULL AND department_id = @department_id
                  THEN 10 ELSE 0 END AS match_score
    FROM   dbo.employee
    WHERE  is_active = 1
      AND  (name_normalized = @name_normalized
            OR name_normalized LIKE @name_normalized + N'%'
            OR @name_normalized LIKE name_normalized + N'%')
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
    WHERE  is_active = 1
    ORDER BY full_name, employee_id;
END
GO

--------------------------------------------------------- Insert employee
-- Caller supplies employee_id (IDENTITY_INSERT) so Power Apps can keep a
-- stable key. Duplicate PK / employee_code raises SQL 2627; the API maps that
-- to 409.
CREATE OR ALTER PROCEDURE dbo.sp_employee_insert
    @employee_id      INT,
    @employee_code    NVARCHAR(50),
    @full_name        NVARCHAR(200),
    @name_normalized  NVARCHAR(200) = NULL,
    @department_id    INT           = NULL,
    @department_name  NVARCHAR(200) = NULL,
    @email            NVARCHAR(320) = NULL,
    @is_active        BIT           = 1
AS
BEGIN
    SET NOCOUNT ON;
    IF @employee_id IS NULL OR @employee_id <= 0
        THROW 50001, 'sp_employee_insert requires a positive @employee_id.', 1;
    IF @employee_code IS NULL OR LTRIM(RTRIM(@employee_code)) = N''
        THROW 50001, 'sp_employee_insert requires @employee_code.', 1;
    IF @full_name IS NULL OR LTRIM(RTRIM(@full_name)) = N''
        THROW 50001, 'sp_employee_insert requires @full_name.', 1;

    IF @name_normalized IS NULL OR LTRIM(RTRIM(@name_normalized)) = N''
        SET @name_normalized = @full_name;

    BEGIN TRY
        SET IDENTITY_INSERT dbo.employee ON;
        INSERT dbo.employee (
            employee_id, employee_code, full_name, name_normalized,
            department_id, department_name, email, is_active
        )
        VALUES (
            @employee_id, @employee_code, @full_name, @name_normalized,
            @department_id, @department_name, @email, ISNULL(@is_active, 1)
        );
        SET IDENTITY_INSERT dbo.employee OFF;
    END TRY
    BEGIN CATCH
        SET IDENTITY_INSERT dbo.employee OFF;
        THROW;
    END CATCH

    SELECT employee_id, employee_code, full_name, name_normalized,
           department_id, department_name, email, is_active, created_at, updated_at
    FROM   dbo.employee
    WHERE  employee_id = @employee_id;
END
GO

--------------------------------------------------------- Delete employee
-- Hard delete by employee_id. history.employee_id is not a foreign key, so
-- package rows that still store this id are left in place.
CREATE OR ALTER PROCEDURE dbo.sp_employee_delete
    @employee_id INT
AS
BEGIN
    SET NOCOUNT ON;
    IF @employee_id IS NULL OR @employee_id <= 0
        THROW 50001, 'sp_employee_delete requires a positive @employee_id.', 1;

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
    @history_id      BIGINT         = NULL,
    @name            NVARCHAR(200)  = NULL,
    @department      NVARCHAR(200)  = NULL,
    @slip_no         NVARCHAR(100)  = NULL,
    @sender_name     NVARCHAR(200)  = NULL,
    @sender_content  NVARCHAR(1000) = NULL,
    @sender_address  NVARCHAR(500)  = NULL,
    @model_name      NVARCHAR(200)  = NULL
AS
BEGIN
    SET NOCOUNT ON;
    INSERT dbo.ocr_history (
        history_id, name, department, slip_no,
        sender_name, sender_content, sender_address, model_name
    )
    VALUES (
        @history_id, @name, @department, @slip_no,
        @sender_name, @sender_content, @sender_address, @model_name
    );

    SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS id;
END
GO
