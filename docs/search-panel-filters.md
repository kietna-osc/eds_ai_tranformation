# 検索条件 panel: History / Employee filters and Employee CSV download

Branch: `feature/search` (2026-10-13). Not deployed.

The History and Employee screens got a 検索条件 (search conditions) panel with one input per field. This change makes the Function App filter by each field, adds the Employee CSV download, and lists the Power Automate and APIM steps.

```
App 検索 / クリア / ページ切替 / ダウンロード
  → EDS-APIManagement1 (table, content JSON, action)
  → APIM eds-data-api → func-eds-dev
```

## Parameters the app sends

The app builds `content` from the panel. Empty fields are not sent. Dates are UTC ISO strings. `To` is the selected minute + 59 s, so it is inclusive.

### History (`historyList`, `historyExport`)

| Panel | Parameter | Values | Filtered in |
|---|---|---|---|
| 伝票番号 | `slip_no` | text, contains | Function (JS) |
| 受取人 | `recipient_name` | text, contains (不明 = no recipient) | Function (JS) |
| 処理状態 | `status` | `Notified` (通知済み) / `Delivered` (受取済み) | SQL |
| データ区分 | `data_type` | `Identified` (受取人指定あり) / `Unknown` (指定なし（不明）) | SQL |
| 通知日時 From / To | `notified_start` / `notified_end` | ISO datetime, inclusive | SQL |
| — | `tz_offset` | `TimeZoneOffset()`, e.g. -540 | |
| (mobile search box) | `search_keyword` | any of the shown values | Function (JS) |

`status` and `data_type` also accept lower case and the Japanese labels. `status=Identified|Unknown`, sent by older apps, is read as `data_type`.

### Employee (`employeeList`, `employeeExport`)

| Panel | Parameter | Match |
|---|---|---|
| 社員番号 | `employee_id` | contains |
| 社員氏名 | `full_name` | contains |
| メール | `email` | contains |
| 部署 | `department_name` | contains (was exact) |
| 登録日時 From / To | `created_start` / `created_end` | ISO datetime, inclusive |
| (mobile search box) | `search_keyword` | any column |

Text matches ignore case, full-width / half-width and spaces.

## Function App (`api/`)

- `src/historySearch.js`:
  - `parseFilters` validates the query parameters. An invalid value returns 400.
  - `applyRowFilters` handles `slip_no`, `recipient_name` and `search_keyword`.
  - The screen labels changed to 受取済み / 指定なし（不明）. The old labels are still accepted as keywords.
- `src/employeeSearch.js`: Employee filters, plus the CSV (`社員番号,社員氏名,メール,部署`, the import file's columns: no 登録日時 / 更新日時, UTF-8 BOM, CRLF).
- `src/index.js`:
  - `historyList`: only the SQL filters means paging in SQL. Any JS filter means every matching row is read, then filtered and paged.
  - `historyExport`: same filters as the list. The CSV column 処理状況 is renamed 処理状態.
  - `employeeList`: no filter means paging in SQL. Any filter means filtering in JS.
  - **New** `employeeExport`: `GET /api/employees/export`. Same filters as the list, 登録日時 (`created_start` / `created_end`) included since 2026-10-19 (before that it was ignored). Uses the same Blob container and 15-minute link as the History download.
- No SQL or stored procedure changes (the DB is frozen).
- Tests: `cd api && npm test` (24 tests). They use fake DB and Blob objects, so no install or Azure access is needed.

## Deploy order

1. Function App.
2. APIM.
3. Flow.
4. App.

The new parameters are optional, so an old app still works with the new API and flow.

### 1. Function App

Deploy `api/` to `func-eds-dev` as usual. No new app settings.

### 2. APIM `eds-data-api`

- **Add the operation** `employee-export` with `GET /employees/export`. Do this in the portal under APIs → eds-data-api → + Add operation, or by importing `apim/eds-data-api.openapi.json`. Without it, APIM answers 404.
- **Optional:** the new query parameters on `history-list`, `history-export` and `employee-list` are only documented in the OpenAPI file. APIM forwards undeclared query parameters anyway.

### 3. Flow `EDS-APIManagement1`

In each `Parse …` action, add the listed properties to the schema. In each HTTP action, add the listed lines to **Queries**. Write every value as `@{coalesce(body('<Parse action>')?['<name>'], '')}`. An empty value is ignored by the API.

**a) History → `historyList`**
- `Parse_list_params` schema: `slip_no`, `recipient_name`, `data_type`, `notified_start` and `notified_end`, each `{"type": ["string", "null"]}`. Also change `status` to `["string", "null"]`.
- `Query_history` queries: add `slip_no`, `recipient_name`, `data_type`, `notified_start`, `notified_end`. Keep `status`, `search_keyword` and `tz_offset`. `department_id` can be removed; the API ignores it.

**b) History → `historyExport`**
- `Parse_export_params` schema: `slip_no`, `recipient_name`, `status`, `data_type`, `notified_start`, `notified_end` (all `["string", "null"]`).
- `Export_history` queries: the same 6 names, next to `search_keyword` and `tz_offset`.

**c) Employee → `employeeList`**
- `Parse_list_params_1` schema: `employee_id`, `full_name`, `email`, `department_name`, `created_start`, `created_end` (all `["string", "null"]`). Change `search_keyword` to `["string", "null"]`.
- `Query_employee` queries: add the same 6 names. `department_id` can be removed.

**d) Employee → new case `employeeExport`.** Copy the `historyExport` case: in the History switch use … → Copy to my clipboard, then paste it into `Employee_Route` → + Add case.

| Item | Value |
|---|---|
| Case equals | `employeeExport` |
| `Parse_export_params_emp` content | `@triggerBody()?['text_1']`, schema properties `employee_id`, `full_name`, `email`, `department_name`, `created_start`, `created_end`, `search_keyword` (`["string", "null"]`) and `tz_offset` (`["integer", "null"]`) |
| `Export_employee` (HTTP) | `GET https://apim-eds-dev.azure-api.net/eds/employees/export`, header `Authorization: Bearer @{body('Get_auth_token')?['access_token']}`, queries `employee_id`, `full_name`, `email`, `department_name`, `created_start`, `created_end`, `search_keyword` (each `@{coalesce(body('Parse_export_params_emp')?['<name>'], '')}`) and `tz_offset` (`tz_offset`: `@{coalesce(body('Parse_export_params_emp')?['tz_offset'], -540)}`), retry policy none |
| `Respond_export_emp` | Run after `Export_employee` Succeeded, body `response = @{body('Export_employee')}`, `action = @{triggerBody()?['text_2']}` |
| `Respond_export_emp_1` | Run after `Export_employee` Failed / TimedOut / Skipped, body `error = データのダウンロードに失敗しました。しばらくしてから再度お試しください。` |

The app calls it with `'EDS-APIManagement1'.Run("employee", <filters JSON>, "employeeExport")` and reads `rowCount` and `file.url` from `response`.

### 4. App

Open `app-builds/EDS-newest_20261012084823.msapp` in Power Apps Studio. Then Save and Publish.
- **Panels:** 検索 sends the panel fields. クリア empties every field and reloads the list. Paging keeps the last search (`gblHsQuery` / `gblEsQuery`).
- **Employee screen:** the ダウンロード button calls `employeeExport`.
- **Opening the screen:** the History list loads with the spec defaults (処理状態 = 通知済み, 通知日時 = today −7 days to today).

## Test after deploying

| # | Do | Expect |
|---|---|---|
| 1 | History: open the screen | Only 通知済み rows notified within the last 7 days |
| 2 | 処理状態 = 受取済み, 検索 | Only 受取済み rows; the pager count changes |
| 3 | データ区分 = 受取人指定あり | Only that type |
| 4 | 伝票番号 = part of a slip number | Rows containing it |
| 5 | 受取人 = 不明 | Rows without a recipient |
| 6 | クリア | All fields empty, every row, page 1 |
| 7 | ダウンロード with conditions | The CSV has the same rows as the screen; the header shows 処理状態 |
| 8 | Employee: 部署 = part of a name, 検索 | Matching employees |
| 9 | Employee ダウンロード | A CSV with only 社員番号, 社員氏名, メール, 部署; importing it again works |
