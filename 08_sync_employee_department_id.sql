/* Point employee.department_id at dbo.department by department_name.
   Full-width digits (３) and half-width digits (3) are treated as the same name.
   A name that is not in the catalog gets department_id NULL. */
SET NOCOUNT ON;

UPDATE e
SET e.department_id = d.department_id
FROM dbo.employee AS e
LEFT JOIN dbo.department AS d
    ON TRANSLATE(
           REPLACE(REPLACE(e.department_name, N' ', N''), N'　', N''),
           N'０１２３４５６７８９',
           N'0123456789'
       )
     = TRANSLATE(
           REPLACE(REPLACE(d.department_name, N' ', N''), N'　', N''),
           N'０１２３４５６７８９',
           N'0123456789'
       );

SELECT
    e.department_id,
    e.department_name,
    COUNT(*) AS employees
FROM dbo.employee AS e
GROUP BY e.department_id, e.department_name
ORDER BY e.department_name, e.department_id;
