# History CSV download

Branch: **`feature/history-csv-download`** (on top of `release/history-blob`).

The ダウンロード button on the History screen (`btnHistDownload`, and `btnHistMDownload` on mobile) downloads History as a CSV file:
- With no search keyword: every row.
- With a keyword: the same rows the screen shows for that keyword.

```
App ダウンロード → EDS-APIManagement1 ("history", {search_keyword, tz_offset}, "historyExport")
  → GET /eds/history/export → func-eds-dev historyExport
       reads dbo.history (sp_history_list_v2), filters like the screen, builds the CSV
       → Blob Storage stedsimages1008 / history-exports / yyyy/mm/<id>/history_yyyymmdd_hhmmss.csv
       → returns a read-only download link, valid 15 min
  → the app calls Download(link) → the browser saves the file
```

## The file

- Columns: 履歴ID, 伝票番号, 処理状況, データ区分, 受取人, 受取部署, 品名, 送り主, 送り主住所, 通知日時, 受取日時.
- The labels are the same as on the screen (通知済み / 荷物受取済み, 受取人指定あり / 受取人不明, 不明 for no recipient).
- Times are in the user's time zone (`TimeZoneOffset()`), formatted `yyyy/mm/dd hh:mm`.
- UTF-8 with a BOM and CRLF line endings, so Japanese Excel opens it directly.
- Cells starting with `= + - @` (OCR text) get a leading `'`, so Excel does not run them as formulas.
- Export files are deleted automatically after 1 day (lifecycle rule `delete-history-exports-after-1-day`). The download link expires after 15 minutes.

## What was deployed (2026-10-08)

| Part | Change | Who |
|---|---|---|
| Storage `stedsimages1008` | Container `history-exports` (private) + lifecycle rule | Claude |
| Function `func-eds-dev` | `GET /api/history/export` (`historyCsv.js`, `csv.js`, `blobImages.storeExport`). No new settings. | Claude |
| APIM `eds-data-api` | Operation `history-export` `GET /history/export` | Claude |
| Flow `EDS-APIManagement1` | New `historyExport` case in `History_Route` (`Parse_export_params` → `Export_history` → `Respond_export`) | Claude |
| App `EDS-App-Desktop-phase2` | `OnSelect` of `btnHistDownload` and `btnHistMDownload` (`powerplatform/canvas-app/Src/srcHistory.fx.yaml`) | You, in Studio, then Publish |

Rollback:
- Function: previous package URL in `powerapps/backup-2026-10-08/func-eds-dev-package-url-before-csv.txt`.
- Flow: `powerapps/backup-2026-10-08/EDS-APIManagement1-before-export.json`.
- App: remove the two `OnSelect` formulas.

## Limits

- At most 100,000 rows per file (logged if reached).
- The keyword search is case-insensitive, like `Lower(...) in` on the screen.
