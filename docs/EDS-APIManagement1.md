# EDS-APIManagement1 — Power App gọi API

Flow **EDS-APIManagement1** là một cổng. Power App không gọi APIM trực tiếp. Mỗi lần chạy flow truyền 3 tham số, flow gọi đúng endpoint, rồi trả body JSON về Power App để parse.

## Ba tham số

| Tham số flow | Title | Ý nghĩa |
| --- | --- | --- |
| `text` | `table` | Bảng: `employee`, `history`, `department` |
| `text_1` | `content` | Chuỗi JSON của object request. Không có field thì gửi `"{}"` |
| `text_2` | `action` | Tên function trong `api/src/index.js` |

Trong Power App, `content` phải là chuỗi JSON, không phải record:

```powerfx
'EDS-APIManagement1'.Run(
    "department",
    JSON({ department_name: "営業部" }),
    "departmentInsert"
)
```

`JSON()` giữ đúng kiểu: số là number, `true`/`false` là boolean. `is_active` phải là boolean. Chuỗi `"false"` bị API đọc thành `true`.

Flow parse `content`, ghép query hoặc body, gọi APIM, rồi trả **status** và **body** về Power App. Schema bên dưới là schema của body đó.

Datetime trong response là chuỗi UTC, ví dụ `2026-09-24T00:00:00.000Z`.

## Bảng action

| table | action | Method | Path |
| --- | --- | --- | --- |
| `employee` | `employeeList` | GET | `/employees` |
| `employee` | `employeeInsert` | POST | `/employees` |
| `employee` | `employeeDelete` | DELETE | `/employees/{employee_id}` |
| `employee` | `employeeMatch` | GET | `/employees/match` |
| `employee` | `fuzzySearch` | POST | `/employees/fuzzy-search` |
| `history` | `historyList` | GET | `/history` |
| `history` | `historyInsert` | POST | `/history` |
| `history` | `historySetPlannerTask` | PATCH | `/history/{history_id}/planner-task` |
| `history` | `historySetDelivered` | POST | `/history/delivered` |
| `department` | `departmentList` | GET | `/departments` |
| `department` | `departmentInsert` | POST | `/departments` |

`employee.department_id` là số tự do trên nhân viên. Nó không phải khóa ngoại sang bảng `department`.

## Lỗi chung

Mọi action có thể trả body lỗi:

```json
{
  "type": "object",
  "properties": {
    "error": { "type": "string" },
    "requestId": { "type": "string" }
  },
  "required": ["error"]
}
```

| Status | Khi nào |
| --- | --- |
| 400 | Thiếu field bắt buộc, `status` sai, datetime không hợp lệ |
| 404 | Không tìm thấy `employee_id` hoặc `history_id` |
| 409 | Trùng `employee_id`, `employee_code`, hoặc `department_name`. `history_id` của OCR không tồn tại cũng ra 409 |
| 500 | Lỗi SQL khác. Body có thêm `requestId` |

---

## employee

### employeeList

Lấy một trang nhân viên. `department_id` là filter bằng đúng. `search_keyword` là contains trên `full_name`, `department_name`, `email`, và prefix trên `name_normalized`, `employee_code`.

`content` mẫu:

```json
{
  "page": 1,
  "pageSize": 50,
  "department_id": 3,
  "search_keyword": "前川"
}
```

Request schema. Mọi field đều optional. Bỏ field hoặc để rỗng nghĩa là không lọc. `page` mặc định 1, `pageSize` mặc định 50, tối đa 200.

```json
{
  "type": "object",
  "properties": {
    "page": { "type": "integer" },
    "pageSize": { "type": "integer" },
    "department_id": { "type": ["integer", "null"] },
    "search_keyword": { "type": ["string", "null"] }
  }
}
```

Response **200**:

```json
{
  "type": "object",
  "properties": {
    "page": { "type": "integer" },
    "pageSize": { "type": "integer" },
    "totalCount": { "type": "integer" },
    "totalPages": { "type": "integer" },
    "count": { "type": "integer" },
    "value": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "employee_id": { "type": "integer" },
          "employee_code": { "type": "string" },
          "full_name": { "type": "string" },
          "name_normalized": { "type": ["string", "null"] },
          "department_id": { "type": ["integer", "null"] },
          "department_name": { "type": ["string", "null"] },
          "email": { "type": ["string", "null"] },
          "is_active": { "type": "boolean" },
          "created_at": { "type": "string" },
          "updated_at": { "type": "string" }
        },
        "required": [
          "employee_id", "employee_code", "full_name", "name_normalized",
          "department_id", "department_name", "email", "is_active",
          "created_at", "updated_at"
        ]
      }
    }
  },
  "required": ["page", "pageSize", "totalCount", "totalPages", "count", "value"]
}
```

`count` là số dòng của trang hiện tại. `totalCount` là tổng dòng khớp filter. Không có dòng thì `value` là `[]`, `count` và `totalCount` là 0.

### employeeInsert

`employee_id` do Power App gửi, API không tự tăng. `employee_id`, `employee_code`, `full_name` là bắt buộc.

`content` mẫu:

```json
{
  "employee_id": 2100,
  "employee_code": "E2100",
  "full_name": "田中 太郎",
  "name_normalized": "たなかたろう",
  "department_id": 3,
  "department_name": "営業部",
  "email": "tanaka@example.com",
  "is_active": true
}
```

Request schema:

```json
{
  "type": "object",
  "properties": {
    "employee_id": { "type": "integer" },
    "employee_code": { "type": "string" },
    "full_name": { "type": "string" },
    "name_normalized": { "type": ["string", "null"] },
    "department_id": { "type": ["integer", "null"] },
    "department_name": { "type": ["string", "null"] },
    "email": { "type": ["string", "null"] },
    "is_active": { "type": "boolean" }
  },
  "required": ["employee_id", "employee_code", "full_name"]
}
```

Bỏ `name_normalized` thì API ghi bằng `full_name`. Bỏ `is_active` thì API ghi `true`.

Response **201**:

```json
{
  "type": "object",
  "properties": {
    "value": {
      "type": "object",
      "properties": {
        "employee_id": { "type": "integer" },
        "employee_code": { "type": "string" },
        "full_name": { "type": "string" },
        "name_normalized": { "type": ["string", "null"] },
        "department_id": { "type": ["integer", "null"] },
        "department_name": { "type": ["string", "null"] },
        "email": { "type": ["string", "null"] },
        "is_active": { "type": "boolean" },
        "created_at": { "type": "string" },
        "updated_at": { "type": "string" }
      },
      "required": [
        "employee_id", "employee_code", "full_name", "name_normalized",
        "department_id", "department_name", "email", "is_active",
        "created_at", "updated_at"
      ]
    }
  },
  "required": ["value"]
}
```

**400** khi thiếu `employee_id`, `employee_code` hoặc `full_name`. **409** khi `employee_id` hoặc `employee_code` đã tồn tại: `{ "error": "同じデータが既に登録されています" }`.

### employeeDelete

Xóa nhân viên. Dòng `history` giữ nguyên `employee_id`.

`content` mẫu. Flow lấy `employee_id` đưa vào path:

```json
{ "employee_id": 2100 }
```

Request schema:

```json
{
  "type": "object",
  "properties": {
    "employee_id": { "type": "integer" }
  },
  "required": ["employee_id"]
}
```

Response **200**:

```json
{
  "type": "object",
  "properties": {
    "deleted": { "type": "integer" }
  },
  "required": ["deleted"]
}
```

`deleted` là số dòng đã xóa, thành công thì bằng 1. **404** khi không có nhân viên: `{ "error": "指定された社員IDの従業員が見つかりません。一覧を更新してください。" }` (employeeUpdate cũng vậy). **409** khi còn history tham chiếu (FK): `{ "error": "この従業員は履歴データで使用されているため削除できません" }`. **500**: `{ "error": "サーバーでエラーが発生しました。…（requestId: …）", "requestId": "…" }`. employeeUpdate trả **409** `{ "error": "このメールアドレスは既に他の従業員に使用されている" }` khi email (trim, không phân biệt hoa thường) đã thuộc nhân viên khác; kiểm tra trong JS vì `sp_employee_update` không có. Message lỗi của employeeUpdate / employeeDelete là tiếng Nhật vì flow đưa thẳng `error` lên popup của app.

### employeeMatch

Tìm gần đúng theo tên đã chuẩn hóa sẵn (NFKC, katakana sang hiragana, bỏ khoảng trắng). API không tự chuẩn hóa `name`.

`content` mẫu:

```json
{
  "name": "たなかたろう",
  "department_id": 3,
  "top": 10
}
```

Request schema. `name` bắt buộc. `top` mặc định 10, tối đa 50.

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "department_id": { "type": ["integer", "null"] },
    "top": { "type": "integer" }
  },
  "required": ["name"]
}
```

Response **200**:

```json
{
  "type": "object",
  "properties": {
    "count": { "type": "integer" },
    "value": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "employee_id": { "type": "integer" },
          "employee_code": { "type": "string" },
          "full_name": { "type": "string" },
          "department_id": { "type": ["integer", "null"] },
          "department_name": { "type": ["string", "null"] },
          "email": { "type": ["string", "null"] },
          "match_score": { "type": "integer" }
        },
        "required": [
          "employee_id", "employee_code", "full_name",
          "department_id", "department_name", "email", "match_score"
        ]
      }
    }
  },
  "required": ["count", "value"]
}
```

`match_score`: 100 tên khớp đúng, 80 tên bắt đầu bằng keyword, 60 chiều ngược lại, cộng 10 nếu trùng `department_id`. **400** khi thiếu `name`.

### fuzzySearch

So OCR receiver với nhân viên `is_active = 1`. Không cần gửi roster. Tên field nhận cả camelCase và snake_case. Power App dùng camelCase.

`content` mẫu:

```json
{
  "receiverName": "前川 雄亮",
  "department": "営業部",
  "nameWeight": 0.85,
  "topK": 3,
  "fuzzyThreshold": 90
}
```

Request schema. Mọi field optional.

```json
{
  "type": "object",
  "properties": {
    "receiverName": { "type": "string" },
    "receiver_name": { "type": "string" },
    "department": { "type": "string" },
    "nameWeight": { "type": "number" },
    "name_weight": { "type": "number" },
    "topK": { "type": "integer" },
    "top_k": { "type": "integer" },
    "fuzzyThreshold": { "type": "number" },
    "fuzzy_threshold": { "type": "number" }
  }
}
```

Mặc định: `nameWeight` 0.85, `topK` 3, `fuzzyThreshold` 90. `receiverName` rỗng thì trả `topK` người đầu danh sách, điểm đều 0.

Response **200**. `employee_id` ở endpoint này là **string**.

```json
{
  "type": "object",
  "properties": {
    "match_type": {
      "type": "string",
      "enum": ["none", "exact_name", "top_k"]
    },
    "candidates": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "employee_id": { "type": "string" },
          "name": { "type": "string" },
          "department": { "type": "string" },
          "email": { "type": "string" },
          "name_score": { "type": "number" },
          "department_score": { "type": "number" },
          "score": { "type": "number" }
        },
        "required": [
          "employee_id", "name", "department", "email",
          "name_score", "department_score", "score"
        ]
      }
    }
  },
  "required": ["match_type", "candidates"]
}
```

`match_type`: `none` khi không có nhân viên active, `exact_name` khi tên khớp sau chuẩn hóa, `top_k` khi so fuzzy. `score` là điểm tổng hợp.

---

## history

`status` chỉ có `Unknown` và `Identified`.

`image_url` (`NVARCHAR(MAX)`) là URL hoặc relative path SharePoint của ảnh scan (`/Shared%20Documents/...`). Màn hình History (`srcHistory` → `imgHistScan.Image`) lấy thumbnail từ SharePoint theo tên file.

Phiên bản lưu ảnh dạng base64 trong `image_url` nằm ở branch `feature/history-base64` (flow `EDS-NotifySelected-base64`, đang tắt).

### historyList

Mỗi kiện hàng hiện **1 dòng = phiên bản mới nhất**. Từ `21_history_versions.sql`, mỗi lần task Planner thay đổi sẽ INSERT thêm 1 dòng vào `history` (và `ocr_history`) chứ không UPDATE; các phiên bản của một kiện chung `planner_task_id`. Filter áp lên phiên bản mới nhất. `history_id` là dòng đầu tiên của kiện (không đổi khi có phiên bản mới). Mọi phiên bản giữ `created_at` = lúc đăng ký. `updated_at` là lúc ghi phiên bản mới nhất. `task_changed_at` là lúc trạng thái đổi: Done = `completedDateTime` của Planner; reopen = `snapshot_at` của lần sync phát hiện (Planner không ghi thời điểm mở lại); `null` ở dòng đăng ký.

`department_id` lọc theo `recipient_department_id`. Khoảng ngày là inclusive: `notified_at`/`delivered_at` từ start đến end. Chuỗi chỉ có ngày được hiểu là `00:00:00Z`, nên end của cả ngày phải là `2026-09-10T23:59:59Z`.

`content` mẫu:

```json
{
  "page": 1,
  "pageSize": 50,
  "status": "Identified",
  "department_id": 3,
  "employee_id": 1838,
  "notified_start": "2026-09-01T00:00:00Z",
  "notified_end": "2026-09-10T23:59:59Z",
  "delivered_start": null,
  "delivered_end": null
}
```

Request schema. Mọi field optional. `page` mặc định 1, `pageSize` mặc định 50, tối đa 200.

```json
{
  "type": "object",
  "properties": {
    "page": { "type": "integer" },
    "pageSize": { "type": "integer" },
    "status": { "type": ["string", "null"], "enum": ["Unknown", "Identified", null] },
    "department_id": { "type": ["integer", "null"] },
    "employee_id": { "type": ["integer", "null"] },
    "notified_start": { "type": ["string", "null"] },
    "notified_end": { "type": ["string", "null"] },
    "delivered_start": { "type": ["string", "null"] },
    "delivered_end": { "type": ["string", "null"] }
  }
}
```

Response **200**:

```json
{
  "type": "object",
  "properties": {
    "page": { "type": "integer" },
    "pageSize": { "type": "integer" },
    "totalCount": { "type": "integer" },
    "totalPages": { "type": "integer" },
    "count": { "type": "integer" },
    "value": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "history_id": { "type": "integer" },
          "slip_no": { "type": ["string", "null"] },
          "image_url": { "type": ["string", "null"] },
          "sender_name": { "type": ["string", "null"] },
          "sender_content": { "type": ["string", "null"] },
          "sender_address": { "type": ["string", "null"] },
          "employee_id": { "type": ["integer", "null"] },
          "recipient_name": { "type": ["string", "null"] },
          "recipient_department_id": { "type": ["integer", "null"] },
          "recipient_department_name": { "type": ["string", "null"] },
          "status": { "type": "string", "enum": ["Unknown", "Identified"] },
          "notified_at": { "type": ["string", "null"] },
          "delivered_at": { "type": ["string", "null"] },
          "planner_task_id": { "type": ["string", "null"] },
          "task_changed_at": { "type": ["string", "null"] },
          "created_at": { "type": "string" },
          "updated_at": { "type": "string" }
        },
        "required": [
          "history_id", "slip_no", "image_url",
          "sender_name", "sender_content", "sender_address",
          "employee_id", "recipient_name",
          "recipient_department_id", "recipient_department_name",
          "status", "notified_at", "delivered_at",
          "planner_task_id", "created_at", "updated_at"
        ]
      }
    }
  },
  "required": ["page", "pageSize", "totalCount", "totalPages", "count", "value"]
}
```

**400** khi `status` khác `Unknown`/`Identified`, hoặc một mốc ngày không parse được.

### historyInsert

Mọi field optional. Có `employee_id` mà không gửi `status` thì API ghi `Identified`. Không có `employee_id` thì ghi `Unknown`.

`image_url` không bị cắt độ dài. Các field text khác vẫn bị cắt theo độ dài cột.

Cùng transaction, API ghi thêm 1 dòng `ocr_history` (cùng `history_id`, cùng thông tin package) kèm người bấm Register: `operator_name` (Power Apps `User().FullName`) và `operator_email` (`User().Email`). Flow EDS-NotifySelected lấy 2 giá trị này từ payload app gửi lên. Không gửi thì 2 cột là NULL.

Dòng `ocr_history` đó cũng lưu giá trị OCR **gốc** (trước khi người dùng sửa trên màn hình) qua 7 field `ocr_*`. Các field này chỉ lưu vào `ocr_history`, không lưu vào `history`:

| Field | Nguồn (EDS-ProcessLabel) |
| --- | --- |
| `ocr_receipt_name` | `receiver_name` |
| `ocr_receipt_department` | `department` |
| `ocr_slip_no` | `slip_no` |
| `ocr_sender_name` | `sender_name` |
| `ocr_sender_content` | `sender_info` |
| `ocr_sender_address` | `sender_department` |
| `ocr_model_name` | `model_name` |

Không gửi thì cột là NULL. Đây là cách duy nhất để ghi `ocr_history`; endpoint cũ `POST /ocr-history` (action `ocrHistoryInsert`) đã bị bỏ.

`content` mẫu:

```json
{
  "slip_no": "SL-1001",
  "image_url": "https://example.com/slip.jpg",
  "sender_name": "山田",
  "sender_content": "書類",
  "sender_address": "東京",
  "employee_id": 1838,
  "recipient_name": "前川 雄亮",
  "recipient_department_id": 3,
  "recipient_department_name": "営業部",
  "status": "Identified",
  "notified_at": "2026-09-24T01:00:00Z",
  "planner_task_id": null,
  "operator_name": "受付 花子",
  "operator_email": "hanako@smartosc.com",
  "ocr_receipt_name": "前川 雄介",
  "ocr_receipt_department": "営業部",
  "ocr_slip_no": "SL-1001",
  "ocr_sender_name": "山田",
  "ocr_sender_content": "書類",
  "ocr_sender_address": "東京",
  "ocr_model_name": "gpt-5.5"
}
```

Request schema:

```json
{
  "type": "object",
  "properties": {
    "slip_no": { "type": ["string", "null"] },
    "image_url": { "type": ["string", "null"] },
    "sender_name": { "type": ["string", "null"] },
    "sender_content": { "type": ["string", "null"] },
    "sender_address": { "type": ["string", "null"] },
    "employee_id": { "type": ["integer", "null"] },
    "recipient_name": { "type": ["string", "null"] },
    "recipient_department_id": { "type": ["integer", "null"] },
    "recipient_department_name": { "type": ["string", "null"] },
    "status": { "type": ["string", "null"], "enum": ["Unknown", "Identified", null] },
    "notified_at": { "type": ["string", "null"] },
    "planner_task_id": { "type": ["string", "null"] },
    "operator_name": { "type": ["string", "null"] },
    "operator_email": { "type": ["string", "null"] },
    "ocr_receipt_name": { "type": ["string", "null"] },
    "ocr_receipt_department": { "type": ["string", "null"] },
    "ocr_slip_no": { "type": ["string", "null"] },
    "ocr_sender_name": { "type": ["string", "null"] },
    "ocr_sender_content": { "type": ["string", "null"] },
    "ocr_sender_address": { "type": ["string", "null"] },
    "ocr_model_name": { "type": ["string", "null"] }
  }
}
```

Response **201**:

```json
{
  "type": "object",
  "properties": {
    "history_id": { "type": "integer" }
  },
  "required": ["history_id"]
}
```

### historySetPlannerTask

Gắn Planner task vào kiện đã tạo. `history_id` nằm trong `content`, flow đưa vào path.

`content` mẫu:

```json
{
  "history_id": 12,
  "planner_task_id": "abc-task-id"
}
```

Request schema:

```json
{
  "type": "object",
  "properties": {
    "history_id": { "type": "integer" },
    "planner_task_id": { "type": "string" }
  },
  "required": ["history_id", "planner_task_id"]
}
```

Response **200**:

```json
{
  "type": "object",
  "properties": {
    "updated": { "type": "integer" }
  },
  "required": ["updated"]
}
```

`updated` là 1 khi gắn được. **400** khi thiếu id hoặc `planner_task_id`. **404**: `{ "error": "history_id not found" }`.

### historySetDelivered

Đánh dấu đã giao: thêm 1 phiên bản `Delivered` của kiện (dòng mới trong `history` và `ocr_history`, không UPDATE). Cần `planner_task_id` hoặc `history_id` (của bất kỳ phiên bản nào). Kiện đã là `Delivered` thì không thêm gì, nên trigger bắn lặp vô hại. `task_changed_at` là `completedDateTime` của task trên Planner; bỏ trống thì lấy `delivered_at`.

`content` mẫu:

```json
{
  "history_id": 12,
  "planner_task_id": "abc-task-id",
  "delivered_at": "2026-09-24T02:00:00Z",
  "task_changed_at": "2026-09-24T01:59:30Z"
}
```

Request schema:

```json
{
  "type": "object",
  "properties": {
    "history_id": { "type": ["integer", "null"] },
    "planner_task_id": { "type": ["string", "null"] },
    "delivered_at": { "type": ["string", "null"] },
    "task_changed_at": { "type": ["string", "null"] }
  }
}
```

Response **200** cùng schema `{ "updated": integer }` của `historySetPlannerTask`. **400**: `{ "error": "planner_task_id or history_id is required" }`, hoặc kiện không có task Planner (`This package has no Planner task, so it cannot be marked delivered.`). **404**: `{ "error": "no matching package" }`.

### historyPlannerSync

Đồng bộ trạng thái History theo Planner, `POST /history/planner-sync`. **Không đi qua flow EDS-APIManagement1.** Flow theo lịch `EDS-PlannerStatusSync` gọi thẳng APIM (19:00 các ngày làm việc). Flow đọc toàn bộ task của plan EDS và gửi mỗi task một dòng:

So sánh task với **phiên bản mới nhất** của kiện, lệch thì INSERT thêm 1 phiên bản (history + ocr_history), không UPDATE:

- Task đang mở (bị reopen) mà phiên bản mới nhất là 受取済み → thêm phiên bản `Notified`, `delivered_at` = null, `task_changed_at` = `snapshot_at` (Planner không ghi thời điểm reopen, nên lấy lúc sync đọc Planner). Phiên bản 受取済み cũ vẫn còn.
- Task đã Done mà phiên bản mới nhất vẫn là 通知済み → thêm phiên bản `Delivered`, `delivered_at` = `task_changed_at` = `completed_at` của task.
- Kiện mà task **không có** trong danh sách (task bị xóa, hoặc thuộc trang chưa đọc) thì không bị đụng tới.

Hai cơ chế an toàn:

- `snapshot_at` là thời điểm flow bắt đầu đọc Planner (`utcNow()` lấy **trước** bước list task). Nó cũng là `task_changed_at` của phiên bản reopen. Dòng được set Delivered **sau** mốc này (bởi flow "When a task is completed") thì không bị revert, vì danh sách task cũ hơn lần Done đó.
- `max_revert`: nếu số dòng cần revert vượt ngưỡng thì không đổi gì, trả **409**. Mặc định là 50, tối đa 1000.

Request mẫu:

```json
{
  "snapshot_at": "2026-10-14T10:00:00Z",
  "max_revert": 50,
  "tasks": [
    { "planner_task_id": "vJKMDVFT9UmMe9_5-3vTNGUAB1Ib", "completed": true,  "completed_at": "2026-10-14T03:12:00Z" },
    { "planner_task_id": "aB12cd34Ef56gh78Ij90kl12Mn34", "completed": false, "completed_at": null }
  ]
}
```

Request schema:

```json
{
  "type": "object",
  "properties": {
    "snapshot_at": { "type": "string", "format": "date-time" },
    "max_revert": { "type": "integer", "minimum": 0, "maximum": 1000, "default": 50 },
    "tasks": {
      "type": "array",
      "maxItems": 20000,
      "items": {
        "type": "object",
        "properties": {
          "planner_task_id": { "type": "string", "maxLength": 100 },
          "completed": { "type": "boolean" },
          "completed_at": { "type": ["string", "null"] }
        },
        "required": ["planner_task_id", "completed"]
      }
    }
  },
  "required": ["snapshot_at", "tasks"]
}
```

Response **200**:

```json
{
  "type": "object",
  "properties": {
    "checked": { "type": "integer" },
    "reverted": { "type": "integer" },
    "delivered": { "type": "integer" },
    "duplicates": { "type": "integer" }
  },
  "required": ["checked", "reverted", "delivered", "duplicates"]
}
```

`checked` là số task đã nhận sau khi bỏ id trùng, `reverted` là số dòng về 通知済み, `delivered` là số dòng thành 受取済み, `duplicates` là số task bị gửi trùng id. **400** khi thiếu `snapshot_at` hoặc `snapshot_at` ở tương lai quá 5 phút (gửi `utcNow()`, có `Z`), `max_revert` sai, hoặc có task sai format (message ghi rõ vị trí, ví dụ `tasks[3].completed must be true or false`). **409**: `{ "error": "planner sync stopped: 60 rows would go back to Notified, more than max_revert (50). Nothing was changed." }`.

Code: `api/src/plannerSync.js` kiểm tra request, handler `historyPlannerSync` nằm trong `api/src/index.js`, proc `dbo.sp_history_planner_sync` nằm trong `17_history_planner_sync.sql`.

---

## department

### departmentList

Trả toàn bộ catalog, không phân trang, không filter. `content` là `"{}"`.

Request schema:

```json
{ "type": "object", "properties": {} }
```

Response **200**, sắp theo `department_name` rồi `department_id`:

```json
{
  "type": "object",
  "properties": {
    "count": { "type": "integer" },
    "value": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "department_id": { "type": "integer" },
          "department_name": { "type": "string" },
          "created_at": { "type": "string" },
          "updated_at": { "type": "string" }
        },
        "required": ["department_id", "department_name", "created_at", "updated_at"]
      }
    }
  },
  "required": ["count", "value"]
}
```

### departmentInsert

Chỉ gửi tên. `department_id`, `created_at`, `updated_at` do SQL tạo.

`content` mẫu:

```json
{ "department_name": "営業部" }
```

Request schema:

```json
{
  "type": "object",
  "properties": {
    "department_name": { "type": "string" }
  },
  "required": ["department_name"]
}
```

Response **201**:

```json
{
  "type": "object",
  "properties": {
    "value": {
      "type": "object",
      "properties": {
        "department_id": { "type": "integer" },
        "department_name": { "type": "string" },
        "created_at": { "type": "string" },
        "updated_at": { "type": "string" }
      },
      "required": ["department_id", "department_name", "created_at", "updated_at"]
    }
  },
  "required": ["value"]
}
```

**400** khi thiếu tên. **409** khi tên đã có: `{ "error": "同じデータが既に登録されています" }`.
