# History screen: download one page at a time when searching

Status: **implemented 2026-10-08** (branch `feature/history-search`), in the function instead of SQL: `historyList` takes `search_keyword` (and `tz_offset`), filters with `api/src/historySearch.js` (伝票番号, 受取人, 処理状況, データ区分, 通知日時; NFKC, case and spaces ignored; date keywords), then pages. The CSV download uses the same matcher. The text below describes the situation before.

Written while the base64 variant was live (see `docs/SETUP.md` → "Base64 variant"). With SharePoint URLs in `image_url`, rows are small, so a search that downloads every row is cheap today. The change becomes necessary again if base64 is turned back on, or once the table grows large.

## Current behaviour

The History screen (`srcHistory`) loads rows through `EDS-APIManagement1` → APIM → `historyList` → `dbo.sp_history_list`.

| | Without a keyword | With a keyword |
|---|---|---|
| What is downloaded | One page: `page = gblPage`, `pageSize = gblPageSize` (the user's choice) | **Every row in the table**, 200 rows per call: page 1, then one call for each remaining page |
| Where the filter runs | — | In the app: `Filter(colHistory, Lower(varHistSearch) in Lower(slip & " " & recipient & " " & status & " " & dataType))` |
| What is shown | `colHistory` as returned | `LastN(FirstN(<filtered rows>, gblPage * gblPageSize), gblPageSize)` |
| Changing page or page size | New call to the server | No call; the app re-slices the rows it already has |

Code locations:

- `powerplatform/canvas-app/Src/srcHistory.fx.yaml`: the search branch in `OnVisible` (`"pageSize":200` calls and the `ForAll(Sequence(totalPages - 1, 2))` loop) and the same code in `btnHistFetch.OnSelect`
- `srcHistory.fx.yaml`: `galHistory.Items` and `galHistMobile.Items`, the search branch with `Filter` + `FirstN` / `LastN`
- `powerplatform/canvas-app/Src/Components/cmpPager.fx.yaml`: `btnPgFetch.OnSelect` skips the fetch when `varHistSearch` is not blank

`historyList` has no keyword parameter, so the app cannot ask the server for "page N of the matching rows". It downloads everything and filters locally.

## Why this is a problem now

`image_url` holds the scanned image as base64, about 0.8 MB per row. A search downloads every image in the table, however many rows match and whatever page size the user chose.

- Today, 60 rows: one search is about 50 MB.
- The flow now passes `pageSize` correctly (fixed 2026-10-06; it used to drop it, so every call returned 50 rows). Each search call can therefore return up to 200 rows, about 160 MB, which will time out or fail with a 502.
- The table grows with every registration, so the search gets slower over time.

A Power Apps Monitor trace of one 50-row page (about 48 MB) took about 23.5 s to load: 3.5 s in the function, about 7 s in the flow and APIM, about 9 s of download, and 3 s of parsing in the app.

## Target behaviour

With a keyword, the app downloads **one page at a time at the user's page size**, exactly as without a keyword. The server filters the rows, counts the matches and returns the requested page.

The filter must move to the server. Downloading one page and filtering it in the app would give wrong results: matches on other pages would be missing, and `totalCount` and the page count would be wrong.

## Changes needed

Deploy in this order. The new parameter is optional, so each step works with the old versions of the others.

### 1. SQL: `dbo.sp_history_list` (`02_procs.sql`)

- New parameter `@search_keyword NVARCHAR(200) = NULL`.
- New condition, building the same text the app searches today. The status and data-type labels are computed, not stored:

  ```sql
  AND (@search_keyword IS NULL
       OR CONCAT(slip_no, N' ',
                 ISNULL(NULLIF(recipient_name, N''), N'不明'), N' ',
                 CASE WHEN delivered_at IS NULL THEN N'通知済み' ELSE N'荷物受取済み' END, N' ',
                 CASE WHEN status = 'Identified' THEN N'受取人指定あり' ELSE N'受取人不明' END)
          LIKE N'%' + @kw + N'%' ESCAPE N'\')
  ```

  `@kw` is `@search_keyword` with `\`, `%`, `_` and `[` escaped. Without escaping, a keyword containing `%` or `_` would match too much.
- `COUNT(*) OVER()` and `OFFSET / FETCH` already run after the `WHERE`, so `total_count` and the page then cover the matching rows only.
- Performance: `LIKE '%…%'` cannot use an index and scans the table. That is fine at this size, because the scan reads the small columns, not `image_url`.

### 2. Function: `historyList` (`api/src/index.js`)

- Read `search_keyword`: `strOrNull(q.get('search_keyword'), 200)`.
- Pass it to the procedure: `['search_keyword', sql.NVarChar(200), searchKeyword]`.

`employeeList` already does this (`api/src/index.js`, `sp_employee_list`).

### 3. Flow: `EDS-APIManagement1` → `historyList` (`powerplatform/flows/EDS-APIManagement1.json`)

- `Parse_list_params` → schema: add `"search_keyword": { "type": "string" }`.
- `Query_history` → queries: add `"search_keyword": "@{body('Parse_list_params')?['search_keyword']}"`.

`employeeList` already does this (`Parse_list_params_1` / `Query_employee`).

### 4. App: `srcHistory` and `cmpPager`

- **Fetch with a keyword** (`srcHistory.OnVisible` and `btnHistFetch.OnSelect`): replace the search branch (`pageSize 200` + `ForAll` over every page) with one call, the same as without a keyword plus the keyword:

  ```
  'EDS-APIManagement1'.Run("history",
      "{""page"":" & gblPage & ",""pageSize"":" & gblPageSize &
      If(IsBlank(varHistSearch), "", ",""search_keyword"":" & JSON(varHistSearch)) & "}",
      "historyList")
  ```

  The two branches then become one. Keep the `IfError(…, "")` wrapper and the `varHistLoading` handling.
- **`cmpPager` → `btnPgFetch.OnSelect`**: remove `If(IsBlank(varHistSearch), …)` so changing page or page size fetches again while searching too. Send `search_keyword` as above.
- **`galHistory.Items` / `galHistMobile.Items`**: remove the search branch. Both cases show `colHistory` with the row number `(gblPage - 1) * gblPageSize + seq.Value`.
- No change to the pager labels; they already use `varHistTotal` (from `totalCount`) and `gblPageSize`.

### 5. Docs

- `docs/EDS-APIManagement1.md` → `historyList`: add `search_keyword` to the request schema.
- `apim/eds-data-api.openapi.json` → `GET /history`: add the `search_keyword` query parameter.

## Behaviour differences to accept

- **Matching rules.** Today the app uses Power Fx `Lower(…) in …`. After the change, SQL uses the database collation. Upper and lower case match the same way, but full-width vs half-width characters and hiragana vs katakana may match differently. Test with typical Japanese keywords.
- **Each page change while searching calls the server.** Today, after a slow first search, paging is instant. After the change, every page change takes as long as a normal page load, which is short at small page sizes.
- **Results are live.** Rows registered while the user is paging can shift rows between pages, the same as paging without a keyword today.

## Related

- The page size itself is still costly with base64: each row carries a full image (about 0.8 MB). Removing `image_url` from `historyList` and loading each image separately (or storing a small thumbnail) would make every page load fast, with or without a keyword. That is a separate change.
- Deploying the app: `EDS-App-Desktop-phase2-base64` is not in Dataverse or in a solution, so it cannot be published from the command line. Use Power Apps Studio (open the `.msapp`, then Save as and Publish), or Export package / Import package with **Update**.
