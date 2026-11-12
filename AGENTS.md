# lah-messenger-server — 即時通 WebSocket 伺服器規範

> **系統角色**：地政內部即時通訊 WebSocket 伺服器（`LAH-WSS`），服務桌面端 `lah-messenger`（Tauri 2 + Nuxt 2）、網頁端 `LAH-FE`（`lah-messenger-*.vue`）與外部排程推播。  
> **技術棧**：Node.js (CommonJS)、原生 `ws` ^7.4.6（預設 Port 8081）、Express ^4（附件 HTTP 預設 Port 8082）、`better-sqlite3`、`multer`、`marked` + `dompurify`。**嚴禁引入 Socket.IO 等重型框架。**

---

## 1. 核心併發與推播鐵律

1. **雙軌推播與零延遲（Direct Broadcast First）**：
   - 客戶端訊息寫入 SQLite 成功後，**必須立即主動呼叫 `broadcastChannelMessage`** 達成毫秒級直達。
   - `node-watch` 僅作為外部腳本直接寫入 SQLite 時的兜底機制（Fallback），並配合頻道去重防護避免重複廣播。
2. **同使用者多端同步（嚴禁用 `.find()`）**：
   - 同一 User ID 可同時擁有多個連線（桌面端 + 瀏覽器多分頁）。
   - 處理 ACK、`set_read`、`check_read`、訊息編輯、`update_current_channel`、`update_user` 與私訊推播時，**嚴禁使用 `.find()`**，必須一律使用 `.filter(client => client.user?.userid === targetUserId).forEach(...)`。
3. **嚴禁全域互斥布林鎖（No Blocking Global Locks）**：
   - 禁止在廣播方法中使用 `let broadcasting = false` 等全域鎖；單一連線發送必須以獨立 `try/catch` 隔離，防止單點斷線中斷群發。
4. **語法必檢**：
   - 修改任何 `.js` 檔案後，**必須執行 `node -c <file_path>`**，確保 PM2 產線重啟不崩潰。

---

## 2. WebSocket 協定與頻道分類

- **封包類型（`type`）**：`mine`（發新訊息）、`command`（系統命令：`register`, `online`, `unread`, `latest`, `previous`, `set_read`, `check_read`, `remove_message`, `edit_message`, `update_current_channel`, `update_user`, `private_message`）、`ack`（帶負數 ACK ID 回執）、`remote`（頻道訊息廣播）。
- **三類頻道推播規則**：
  1. **全所與課室公共頻道（`stickyChannels`）**：`announcement`、`lds`、`adm`、`reg`、`sur`、`inf`、`val`、`acc`、`hr`、`supervisor` ➔ 全體在線連線廣播（`utils.broadcast`）。新增課室時必須同步維護 `stickyChannels` 與 `getOnlineWsClients`。
  2. **個人私訊頻道**：頻道名為大寫 User ID（如 `HA0001`）➔ 發送給 `ws.user?.userid === channel` 的所有連線（`filter`）。
  3. **自訂群組頻道**：記錄於 `dimension/channel.db`（`channel` 與 `participant` 表）➔ 發送給 `ws.user?.channel === channel` 的所有連線。
- **訊息分庫架構**：每個頻道獨立儲存於 `db/<channel>.db`（`message` 表），使用 `better-sqlite3` 同步 API 並具備 Busy Retry，避免長時間阻塞 Event Loop。

---

## 3. 附件機制與 HTTP API 契約（`upload-router.js`，Port 8082）

附件不入資料庫，直接以檔案系統目錄連結訊息：`uploads/<channel>/<message_id>/<filename>`（保留安全原始檔名，同名自動累加 ` (1)`；相容舊版 `<timestamp>_` 前綴並在下載 `Content-Disposition` 時自動剝除）。

1. **上傳（`POST /api/upload`）**：
   - **Multer 欄位順序鐵律**：前端 `FormData` 必須將 **`channel`、`message_id` 排在 `file` 之前**，否則 Multer 無法讀取而回傳 HTTP 400。
   - 採用「MIME + 副檔名」雙重檢核（由 `FILE_UPLOAD_ALLOWED_MIMES`、`FILE_UPLOAD_ALLOWED_EXTENSIONS`、`FILE_UPLOAD_MAX_SIZE` 控制）。
   - 上傳成功後觸發 WebSocket 即時通知：`type: 'ack'`, `id: '-12'`, `command: 'attachment_uploaded'`, `payload: { channel, message_id, file, attachments }`。
2. **查詢／下載／刪除**：
   - `GET /api/attachments/:channel/:messageId`：回傳 `[{ name, size }]`（`latest` / `previous` 的 `remote` 封包亦附帶選用 `attachments` 欄位）。
   - `GET /api/download/:channel/:messageId/:filename`（及相容舊路由 `GET /api/download/:channel/:filename`）：RFC 5987 UTF-8 檔名下載。
   - `DELETE /api/attachments/:channel/:messageId/:filename`：刪除單檔（空目錄自動清理），並觸發 WebSocket 通知：`type: 'ack'`, `id: '-13'`, `command: 'attachment_deleted'`。
   - 刪除整則訊息（`remove_message`）時，伺服器同步遞迴刪除 `uploads/<channel>/<message_id>/`。
