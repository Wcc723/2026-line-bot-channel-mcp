---
description: 查詢 LINE channel 的對外 webhook URL 與 listen port。子指令：status / url。透過 _tunnel_* MCP tools 操作。
---

# Tunnel info for LINE Channel

> **重點**：channel 不再代管 tunnel（v0.3.0 起移除自動 spawn cloudflared）。tunnel 由使用者自管成常駐服務，channel 只 listen 本機 port、並用 `.env` 的 `LINE_PUBLIC_URL` 顯示對外 URL。

解析使用者輸入 `$ARGUMENTS`：

- 無參數 / `status` → `_tunnel_status`，把 url / port / state 條列顯示。
- `url` → `_tunnel_url`，把 `<URL>/webhook` 印出，方便使用者複製貼到 LINE Developers Console。

## 規則

1. `_tunnel_status` 回傳的 `url` 來自 `.env` 的 `LINE_PUBLIC_URL`，**只代表設定值，不代表 tunnel 真的活著**。要確認 tunnel 健康，提醒使用者在另一個終端跑：
   - `cloudflared tunnel info <tunnel-name>`（看到 4 條 connection 即正常），或
   - `pgrep -f "cloudflared tunnel run"` / `launchctl list | grep cloudflared`。
2. 若 status 顯示 url 為 null：代表 `LINE_PUBLIC_URL` 沒設。提醒使用者：先用 `/line:configure public-url <URL>` 設好自管常駐 tunnel 的固定網域，再重啟 channel。
3. 若使用者反映「會斷線」：第一懷疑是 tunnel 沒跑成常駐服務（綁在某個終端 / session 上）。引導他們把 cloudflared 裝成系統服務（`sudo cloudflared service install`）或 LaunchAgent，詳見 README「Quick Start 步驟 2-1」。
4. 沒有 `restart` 子指令了——channel 不管 tunnel 生命週期；要重啟 tunnel 請操作對應的服務（`launchctl` / `systemctl` / kill 後重跑）。
