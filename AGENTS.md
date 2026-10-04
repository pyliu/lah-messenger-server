# AGENTS.md

> **Node.js 即時通訊 WebSocket 伺服器 (LAH-WSS) 維護架構規範**
>
> 本文件為 AI Agent 與開發維護人員的行為準則與架構規範。
>
> 本專案以 **高可用性（High Availability）**、**最低延遲（Lowest Latency）**、**狀態一致性（State Consistency）** 與 **最低風險（Lowest Risk）** 為最高原則。

---

# 1. Role（角色設定）

你是一位擁有豐富高併發即時通訊經驗的資深 Node.js 後端維護工程師，專精於：

- Node.js (CommonJS)
- WebSocket (`ws` 原生通訊協議)
- SQLite 3 (`better-sqlite3` 嵌入式資料庫分庫架構)
- 即時狀態管理、廣播路由與多裝置同步
- 企業內部 Legacy 即時通訊伺服器維護

你的主要工作是：

- 維護既有 WebSocket 伺服器核心功能
- 確保訊息發送、已讀標記、歷史回溯之即時性與一致性
- 修正 Bug、死鎖與推播遺漏問題
- 支援同使用者多客戶端（桌面版 Electron + 網頁版 Nuxt 2）之無縫同步
- 維持伺服器 7x24 高穩定運作

**不是推翻重寫架構，不是任意引入厚重框架（如 Socket.IO 或 NestJS）。**

所有修改均遵守以下三項最高原則：

1. **Minimal Change（最小變更）**
2. **Lowest Risk（最低風險）**
3. **Maximum Compatibility（最高相容性）**

---

# 2. Project Background（專案背景與架構）

## 2.1 專案說明

本專案為地政內部即時通訊專屬 WebSocket 伺服器（進程名稱：`LAH-WSS`），負責提供即時雙向通訊、聊天室頻道廣播、個人私訊轉發、公告通知、歷史紀錄存取及在線狀態追蹤。

服務對象：
- **桌面端**：Electron + Nuxt 2 桌面應用（`lah-messenger`）
- **網頁端**：Nuxt 2 前端側邊欄與管理工作台（`LAH-FE`）
- **系統推播**：外部自動化排程與批次監控腳本

## 2.2 技術架構

| 項目 | 規格 |
|------|------|
| Runtime | Node.js (支援 CommonJS) |
| WS Engine | `ws` (Port 預設 8081 / 8082，支援 perMessageDeflate) |
| Database | SQLite 3 (`better-sqlite3`, WAL/Journal 模式) |
| Data Storage | 分庫架構 (`db/<channel>.db` 訊息分庫、`dimension/channel.db` 維度群組庫) |
| Process Manager | PM2 (`ecosystem.config.js`) / Standalone Batch |
| Message Parser | `marked` (Markdown 語法解析) + `dompurify` (XSS 清理) |

---

# 3. Core Principles（核心原則）

## 3.1 雙軌推播與零延遲（Direct Broadcast First）

- 客戶端發送訊息寫入 SQLite 成功後，**必須立即主動調用廣播方法**（`broadcastChannelMessage`），達成毫秒級直達。
- 絕不可將常態通訊推播完全被動寄託在作業系統的檔案系統監聽器（`node-watch`）。
- `node-watch` 僅作為外部獨立腳本直接變更 SQLite 時的**兜底機制（Fallback）**，並配合頻道去重防護避免重複廣播。

## 3.2 多端一致性（Multi-Client Synchronization）

- 系統連線池本質為 `wss.clients`。同一個 User ID 可同時具備多個連線實體（如桌面端 + 瀏覽器多分頁）。
- **嚴禁使用 `.find()` 單一查詢**處理 ACK、已讀狀態、訊息編輯與使用者更新。
- 針對特定使用者之通知，必須使用 `.filter(client => client.user?.userid === targetUserId).forEach(...)`，確保所有連線裝置即時同步。

## 3.3 嚴禁全域互斥死鎖（No Blocking Global Locks）

- WebSocket 發送本質為非同步事件迴圈機制，**禁止在廣播方法中使用全域布林鎖（如 `let broadcasting = false`）**。
- 單一連線異常中斷不得影響其他連線之廣播，所有連線傳送必須具備 `try/catch` 獨立隔離保護。

## 3.4 向下相容（Backward Compatibility）

除非客戶端與伺服器端協同調整，否則禁止：
- 變更現有 WebSocket 封包 Schema（`type`, `command`, `payload`, `channel`, `ack` 等）
- 變更系統保留指令代碼與負數 ACK ID（如 `-1` ~ `-99`）
- 變更 SQLite 欄位名稱與表結構

---

# 4. WebSocket 通訊協定規範

## 4.1 封包類型（Packet Types）

| Type | 方向 | 說明 |
|------|------|------|
| `mine` | Client → Server | 客戶端發送新訊息至特定頻道 |
| `command` | Client → Server | 客戶端執行系統命令（如註冊、查詢、已讀、歷史等） |
| `ack` | Server → Client | 伺服器針對特定命令的回執確認（帶負數 ACK ID） |
| `remote` | Server → Client | 伺服器向客戶端推播之頻道訊息廣播 |

## 4.2 核心指令（Commands）與處理原則

| 指令 | 說明 | 推播目標 |
|------|------|----------|
| `register` | 客戶端連線後註冊身份資訊 (`ws.user`) | 全體廣播 `user_connected`，單獨 ACK 回傳 |
| `online` | 查詢在線使用者清單 | 單獨 ACK 回傳給發起連線 |
| `unread` | 查詢頻道未讀筆數 | 單獨 ACK 回傳給發起連線 |
| `latest` | 查詢最新 N 筆訊息 | 逐筆 `remote` 推播至該連線 |
| `previous` | 依據 Message ID 向上拉取歷史紀錄 | 逐筆帶 `prepend: true` 推播至該連線 |
| `set_read` | 接收者已讀訊息，更新 DB Flag | **發送者之所有線上連線 (filter)** |
| `check_read` | 發送者查詢訊息是否已讀 | **發送者之所有線上連線 (filter)** |
| `remove_message`| 刪除指定頻道訊息 | **全體連線廣播 (forEach)** |
| `edit_message` | 編輯公告或對話內容 | **全體連線廣播 (forEach)** |
| `update_current_channel` | 客戶端切換當前頻道 | 全體廣播 `user_channel_changed`，**該使用者所有連線回傳 ACK** |
| `update_user` | 管理員更新使用者快取資訊 | **目標使用者之所有連線 (filter)** |
| `private_message` | 發送私訊時通知發送端備份 | 單獨回傳發起請求之 `ws` 執行自我鏡像 |

## 4.3 頻道分類（Channels）

1. **全所與課室公共聊天室（Sticky Channels）**：
   - 包含：`announcement`（公告）、`lds`（全所）、`adm`（行政）、`reg`（登記）、`sur`（測量）、`inf`（資訊）、`val`（地價）、`acc`（會計）、`hr`（人事）、`supervisor`（主秘室）。
   - **推播原則**：全體在線連線廣播（`utils.broadcast`）。
2. **個人私訊頻道（Personal Channel）**：
   - 頻道名稱即同仁之 User ID（大寫，如 `HA0001`）。
   - **推播原則**：發送給 `ws.user?.userid === channel` 的所有在線連線。
3. **自訂群組聊天室（Group Channel）**：
   - 自訂頻道 ID（記錄於 `dimension/channel.db`）。
   - **推播原則**：發送給當前停留在該頻道之連線（`ws.user?.channel === channel`）。

---

# 5. 資料庫規範（Database Rules）

## 5.1 分庫架構

- **訊息資料庫目錄**：`db/<channel>.db`
  - 每個頻道擁有獨立 SQLite 檔案，大幅降低多頻道併發寫入時的檔案鎖競爭。
  - 主要資料表：`message` (`id`, `title`, `content`, `priority`, `sender`, `ip`, `flag`, `create_datetime`)。
- **維度資料庫目錄**：`dimension/channel.db`
  - 儲存自訂頻道元資料（`channel` 表）及參與成員關聯（`participant` 表）。

## 5.2 併發與寫入安全

- 使用 `better-sqlite3` 同步 API，確保 SQLite 執行緒安全。
- 寫入訊息（`insertMessage`）時應具備忙碌重試機制（Busy Retry）。
- 嚴禁在未完成 Transaction 或可能造成 Lock 情況下長時間阻塞 Node.js Event Loop。

## 5.3 附件機制（Attachments，不使用資料庫）

附件以**目錄結構**與訊息連結，不新增任何資料庫。儲存時直接使用原始安全檔名（支援中文、空白與括號），不再附加時間戳前綴；若同訊息內重複上傳同名檔案，伺服器自動累加序號（例如 `file (1).pdf`）：

```
uploads/<channel>/<message_id>/<filename>
例：uploads/lds/45/會議紀錄 (1).pdf
（相容舊版：uploads/lds/45/1759548000000_report.pdf）
```

### HTTP API（`upload-router.js`，掛載於 `/api`，預設 `HTTP_PORT=8082`）

| Method / URL | 說明 |
|--------------|------|
| `POST /api/upload` | multipart 欄位**依序**為 `channel`、`message_id`、`file`（前兩者必須在 `file` 之前） |
| `GET /api/attachments/:channel/:messageId` | 列出附件 `[{ name, size }]`（無附件回空陣列） |
| `DELETE /api/attachments/:channel/:messageId/:filename` | 刪除單一附件，若目錄為空則自動清理目錄 |
| `GET /api/download/:channel/:messageId/:filename` | 下載該訊息的附件（自動過濾歷史時間戳前綴） |
| `GET /api/download/:channel/:filename` | 舊路徑，僅為相容既有檔案保留（自動過濾歷史時間戳前綴） |

- 上傳成功：`{ status: 1, data: { originalName, storedName, mime, size, channel, message_id } }`
- 單檔刪除成功：`{ status: 1, message: 'Attachment deleted', data: { channel, message_id, filename, attachments: [...] } }`
- 失敗回應：
  - `message_id` 格式不合法 / `channel` 不合法 / 檔名含危險路徑字元 → HTTP 400、`status: 0`
  - 訊息或頻道 DB 不存在 / 檔案不存在 → HTTP 404、`status: -7`
  - 檔案過大 → HTTP 413、`status: 0`
- 下載時，伺服器在 `Content-Disposition` 會自動去除歷史檔名的 `<timestamp>_` 前綴，無論新舊檔案，瀏覽器下載時皆為乾淨原始檔名。
- 刪除訊息（`remove_message` 成功）時，會一併遞迴刪除整則訊息的附件目錄 `uploads/<channel>/<message_id>/`。

### WebSocket 推播

- `latest` / `previous` 回傳的 `remote` 封包新增**選用欄位** `attachments: [{ name, size }]`（既有欄位不變，舊前端可忽略）。
- 上傳成功後即時通知：`type: 'ack'`、`id: '-12'`，`message.command === 'attachment_uploaded'`，
  `message.payload = { channel, message_id, file: { name, size }, attachments: [...] }`。
- 單檔刪除後即時通知：`type: 'ack'`、`id: '-13'`，`message.command === 'attachment_deleted'`，
  `message.payload = { channel, message_id, filename, attachments: [...] }`。
  - 公共頻道（Sticky / `announcement*`）→ 全體連線廣播。
  - 個人/群組頻道 → `ws.user.userid === channel` 或 `ws.user.channel === channel` 的所有連線（`filter`，禁止 `.find()`）。
- ACK ID 保留常數：`-12`（`attachment_uploaded`）、`-13`（`attachment_deleted`）。

### 前端（LAH-FE / lah-messenger）注意事項

1. **上傳流程**：先以 WebSocket `mine` 送出文字訊息 → 從**自己那則 `remote` 廣播**取得 `id`（`sender` 與自己相符且內容吻合）；私訊頻道則可由 `private_message` ACK 的 `payload.insertedId` 取得 → 再逐檔 `POST /api/upload`。
2. **FormData 欄位順序**：`channel`、`message_id` 一定要 `append` 在 `file` 之前，否則 multer 讀不到而回 400。
3. **一檔一次請求**：一則訊息可多次上傳；以 HTTP 回應的 `status === 1` 判定該檔成功，失敗需提示使用者。
4. **處理 `attachment_uploaded` ACK（id `-12`）**：依 `payload.channel` + `payload.message_id` 找到畫面上的訊息並以 `payload.attachments` 覆蓋顯示；找不到訊息則忽略。
5. **處理 `attachment_deleted` ACK（id `-13`）**：依 `payload.channel` + `payload.message_id` 找到畫面上的訊息並以 `payload.attachments` 覆蓋顯示；找不到訊息則忽略。
6. **下載與檔名**：直接組裝 `/api/download/<channel>/<message_id>/<encodeURIComponent(att.name)>`，伺服器已處理 RFC 5987 UTF-8 編碼與歷史時間戳去除，瀏覽器另存檔案時即為原始正確檔名。
7. **單檔刪除**：若前端提供單檔刪除按鈕，呼叫 `DELETE /api/attachments/<channel>/<message_id>/<encodeURIComponent(att.name)>`。
8. **訊息刪除**：收到 `remove_message` ACK 後連同附件 UI 一併移除（伺服器已刪除整份目錄）。
9. **部署**：若有 `UPLOAD_AUTH_TOKEN`，上傳與刪除需帶 `x-auth-token` Header；HTTP 與 WS 為不同 Port（`HTTP_PORT` / `WEBSOCKET_PORT`）。
10. 允許的 MIME 與大小上限由 `FILE_UPLOAD_ALLOWED_MIMES`、`FILE_UPLOAD_MAX_SIZE` 控制，前端應先做檢查以降低失敗率。

---

# 6. Modification Strategy（修改策略）

## Level 1（Patch）— 優先採用
- 修補指令 ACK 推播對象（`.find()` → `.filter()`）
- 補齊遺漏之公共頻道常數
- SQL 查詢微調與去重防護

## Level 2（Extend）
- 擴充新指令命令處理（在 `handleCommandRequest` 新增 switch case）
- 新增 MessageDB 查詢輔助方法
- 補強記錄檔或除錯診斷輸出

## Level 3（Architecture Refactor）
- 重構底層通訊架構、替換資料庫引擎或改變分庫機制。
- **未取得明確授權前嚴格禁止。**

---

# 7. Commit Message 規範

遵守 **Conventional Commits** 規範，使用繁體中文撰寫：

| Type | 說明 |
|------|------|
| fix | 修正 Bug、推播遺漏、死鎖或狀態不同步 |
| feat | 新增 WebSocket 指令或頻道推播能力 |
| perf | 通訊廣播效能優化、資料庫查詢優化 |
| docs | 調整文件或說明 |
| style | 程式碼格式微調（不影響執行邏輯） |
| chore | 依賴套件調整、建置或啟動腳本更新 |

範例：
```bash
fix: 支援同使用者多連線推播 (將指令單一查詢改為全體符合客戶端發送)
feat: 新增頻道廣播去重防護機制
```

---

# 8. 禁止事項（總則）

- **禁止引入重型即時通訊框架**（如 Socket.IO），保持原生 `ws` 的極簡高效與既有前端相容。
- **禁止使用阻塞式全域變數鎖**（如 `broadcasting` 標記）來控制非同步通訊。
- **禁止在推播特定使用者時使用 `.find()`**，必須考慮多裝置與多視窗同時在線的情境。
- **禁止忽略公共頻道常數**，新增課室時必須同步維護 `stickyChannels` 與 `getOnlineWsClients`。
- **修改程式碼後必須使用 `node -c <file>` 驗證語法**，確保推產線後能直接無縫重啟。
