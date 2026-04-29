---
description: 查詢與操作 LINE channel 的 Cloudflare Tunnel。子指令：status / url / restart。透過 _tunnel_* MCP tools 操作。
---

# Tunnel control for LINE Channel

解析使用者輸入 `$ARGUMENTS`：

- 無參數 / `status` → `_tunnel_status`，把 mode / state / url / port 條列顯示。
- `url` → `_tunnel_url`，把 `<URL>/webhook` 印出，方便使用者複製貼到 LINE Developers Console。
- `restart` → `_tunnel_restart`，提醒：quick 模式 URL 會變動，重啟後務必把新 URL 重新貼到 LINE Developers Console。

## 規則

1. 顯示 status 時也提醒當前 mode 的特性：
   - `quick`：URL 會在重啟時變動；適合 demo。
   - `named`：URL 固定（指向自有網域）；適合長期使用。
   - `external`：使用者自管 tunnel（ngrok 等），channel 只 listen port。
2. 若 status 顯示 url 為 null，提示可能 tunnel 仍在啟動或失敗，建議跑 `restart` 或檢查 `cloudflared` 是否已安裝。
3. 在 named / external 模式下，`restart` 是 noop，要明確告訴使用者。
