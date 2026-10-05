/* Department catalog taken from dbo.employee in 03_seed_data.sql.
   department_id 1-20 matches employee.department_id.
   Four names that appear on employees with department_id NULL are inserted after, as 21-24.
   employee.department_id is not a foreign key, so those four employee rows stay NULL. */
SET NOCOUNT ON;

DELETE FROM dbo.department;
DBCC CHECKIDENT ('dbo.department', RESEED, 0) WITH NO_INFOMSGS;
GO

SET IDENTITY_INSERT dbo.department ON;

INSERT dbo.department (department_id, department_name) VALUES
(1,  N'第１営業本部'),
(2,  N'第２営業本部'),
(3,  N'第１ソリューション本部第１部門'),
(4,  N'第１ソリューション本部第２部門'),
(5,  N'第２ソリューション本部第１部門'),
(6,  N'第２ソリューション本部第２部門'),
(7,  N'第３ソリューション本部第１部門'),
(8,  N'第３ソリューション本部第２部門'),
(9,  N'デジタルコンサルティング本部'),
(10, N'ソリューション開発'),
(11, N'エンベデッドシステム'),
(12, N'エンタープライズシステム'),
(13, N'ITプラットフォーム'),
(14, N'カスタマーサポート部'),
(15, N'品質管理部'),
(16, N'DX推進部'),
(17, N'総務部'),
(18, N'経理部'),
(19, N'人事・人財開発部'),
(20, N'経営企画部');

SET IDENTITY_INSERT dbo.department OFF;
GO

INSERT dbo.department (department_name) VALUES
(N'EDS Solution Partners'),
(N'EDS本社 特定システム 事業部'),
(N'Exeo Dig. Sol.'),
(N'デジタル戦略室');
GO

SELECT department_id, department_name
FROM dbo.department
ORDER BY department_id;
