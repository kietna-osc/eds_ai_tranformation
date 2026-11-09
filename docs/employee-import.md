# Employee CSV import: Studio steps

Do these after `14_employee_schema.sql` has run and `EDS-App-Desktop-phase2-employee-search.msapp` has been imported.
Then Publish.

## 1. Add the flow

Power Apps Studio, `EDS-App-Desktop-phase2`:

1. Left bar → **Power Automate** (or Data) → **Add flow**.
2. Select **`EDS-EmployeeImport`**.

## 2. Add a file picker (Attachments control)

Power Apps only has this control inside a form, so copy it out of a temporary one.

1. Open the screen **`srcEmployeeList`**.
2. **Insert → Edit form**. Set its **Data source** to **`PackageSlipLog`**.
3. Form → **Edit fields** → **Add field** → **Attachments** → Add.
4. In the form, select the **attachment control** inside the Attachments card (named like `DataCardValue…`), press **Ctrl+C**.
5. Click on an empty area of the screen, press **Ctrl+V**.
6. **Delete the form** (select the form → Delete).
7. Rename the pasted control to **`attEmpCsv`** and set these properties:

| Property | Value |
|---|---|
| Items | `Blank()` (replace the formula that refers to the old card) |
| MaxAttachments | `1` |
| AddAttachmentText | `"CSVファイルを選択"` |
| NoAttachmentsText | `""` |
| DisplayMode | `DisplayMode.Edit` |
| Visible | `!gblIsMobile` |
| X | `App.Width * .50` |
| Y | `App.Height * .117` |
| Width | `App.Width * .24` |
| Height | `App.Height * .048` |

If the control shows an error about `Parent` after the form is deleted, check that **Items** is `Blank()` and that no property still refers to `Parent`.

## 3. Import button

`btnEmpImport` (「社員リストインポート」) → **OnSelect**:

```
=If(
    IsEmpty(attEmpCsv.Attachments),
    Notify("インポートするCSVファイルを選択してください", NotificationType.Warning),
    !EndsWith(Lower(First(attEmpCsv.Attachments).Name), ".csv"),
    Notify("CSVファイル (.csv) を選択してください", NotificationType.Error),
    Set(varEmpLoading, true);
    With(
        {res: IfError('EDS-EmployeeImport'.Run({contentBytes: First(attEmpCsv.Attachments).Value, name: First(attEmpCsv.Attachments).Name}), Blank())},
        With(
            {body: IfError(ParseJSON(res.response), Blank())},
            If(
                IsBlank(res) || IsBlank(body),
                Notify("インポートに失敗しました。時間をおいて再度お試しください。", NotificationType.Error),
                !IsBlank(Text(body.error)),
                Notify("CSVファイルの形式が正しくありません: " & Text(body.error), NotificationType.Error),
                Notify(
                    Concat(Table(body.messages), Text(ThisRecord.Value.text), Char(10)),
                    If(Boolean(body.success), NotificationType.Success, NotificationType.Error)
                )
            )
        )
    );
    Set(varEmpLoading, false);
    Reset(attEmpCsv);
    Set(gblPage, 1);
    Select(btnEmpFetch)
)
```

What it shows:
- the import result messages 51–56, e.g. 「インポートが完了しました。3名の従業員を追加しました。」 and, if existing 社員番号 were updated, 「重複コードが…件検出されました：…」
- 「CSVファイルの形式が正しくありません: …」 when the file has no valid header or no data rows

After the import, the file picker is cleared and the employee list reloads from page 1.

## 4. Publish

**Save → Publish.**

## CSV format

UTF-8 (with or without BOM). Header row, then one employee per row:

```
社員番号,社員氏名,メール,部署
E-1001,山田 太郎,yamada@example.jp,営業部
E-1002,佐藤 花子,,総務部
```

- 社員番号 and 社員氏名 are required; メール and 部署 are optional.
- An existing 社員番号 is **updated** with the new values; a new one is **added**.
- Invalid rows are skipped (message 51 says how many). Up to 10,000 rows / 2 MB per file.
- 部署 is matched to the department list by name (spaces and full-width digits ignored).
