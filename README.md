# lah-messenger-server
ws server for lah-messenger

To start the server, jsut input "yarn start"

# 編譯 better_sqlite3

## 離線安裝下載 (桌面C++開發)
- vs2022_Community.exe --layout vs2022c --add Microsoft.VisualStudio.Workload.NativeDesktop --includeRecommended --lang en-US

## 離線安裝目錄下的 certificates 都需安裝於電腦中才能正常於離線狀態下執行安裝程式
## 管理者權限於POWERSHELL下執行「Set-ExecutionPolicy RemoteSigned」即可使 yarn 正常運作
## 裝完 vs2022c(離線下載檔) 於開發目錄下執行「npm config set msvs_version 20」
