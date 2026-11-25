# lah-messenger-server 記憶索引

## Features
- [2026-11-25] **公告頂起（`bump_message`）命令**：於交易內保留原 `create_datetime` 重鑄新 ID、原子搬移附件並廣播 `remove_message` (`-6`) 與多端 ACK (`-14`) → [`request-handler.js`](../request-handler.js)

## Bug Fixes
- [2026-11-25] **`better-sqlite3` Node v26 載入衝突**：`13.0.3` 使用 `prebuilds/win32-x64.node`，若本機殘留舊版 `build/Release/better_sqlite3.node` 會觸發 `ERR_DLOPEN_FAILED` → [`AGENTS.md`](../AGENTS.md)
