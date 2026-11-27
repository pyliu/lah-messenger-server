# lah-messenger-server — 即時通 WebSocket 與附件伺服器

本專案為桃園地政「智慧控管與監控系統」與「桃園即時通桌面端（`lah-messenger`）」之即時通訊後端服務（PM2 服務名稱：`LAH-WSS`）。

> 開發與協定規範（WebSocket 封包、`stickyChannels`、多端 `.filter()` 同步鐵律、附件上傳契約）請參閱 [`AGENTS.md`](./AGENTS.md)。

---

## 1. 技術棧與通訊埠

- **執行環境**：Node.js (CommonJS)，相容綠色可攜版 Node.js v26 LTS
- **WebSocket 服務（預設 `:8081`）**：原生 `ws` (`^7.4.6`)
- **附件 HTTP 服務（預設 `:8082`）**：Express (`^4`) + Multer (`1.4.4-lts.1`)
- **資料儲存**：`better-sqlite3` (`13.0.3`)，採頻道分庫 `db/<channel>.db` 與維度庫 `dimension/`

---

## 2. 環境設定與啟動

### 2.1 建立環境變數檔（`.env`）

```bash
cp .env.example .env
```

依環境調整 `WEBSOCKET_HOST`、`WEBSOCKET_PORT`（預設 `8081`）、`HTTP_PORT`（預設 `8082`）、`FILE_UPLOAD_MAX_SIZE`（預設 10 MB）等參數；正式環境請保持 `WS_ALLOW_ANONYMOUS=false`。

### 2.2 啟動與測試指令

```bash
# 本機前景啟動
yarn start

# 開發模式（nodemon 自動重啟）
npm run dev

# 執行單元測試（node --test tests）
npm test
```

Windows 環境亦可使用根目錄快捷批次檔：
- `start_pm2.bat`：透過 PM2 與 [`ecosystem.config.js`](./ecosystem.config.js) 啟動守護（`LAH-WSS`）
- `start_standalone.bat`：獨立視窗前景啟動

---

## 3. 目錄結構

```text
lah-messenger-server/
├── server.js            # 伺服器進入點（啟動 WS :8081 與 HTTP :8082）
├── request-handler.js   # WebSocket 命令分派與廣播處理
├── upload-router.js     # 附件上傳、查詢、下載與刪除路由
├── message-db.js        # 頻道訊息 SQLite 讀寫封裝
├── channel-db.js        # 自訂頻道與成員資料庫封裝
├── message-watcher.js   # SQLite 檔案變動監聽兜底機制
├── ecosystem.config.js  # PM2 守護設定檔（LAH-WSS）
├── db/                  # 頻道訊息分庫（db/<channel>.db）
├── dimension/           # 頻道、成員與活動維度資料庫
├── uploads/             # 訊息附件儲存目錄（uploads/<channel>/<message_id>/）
└── tests/               # Node.js 內建測試套件
```
