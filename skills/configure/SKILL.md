---
description: 設定 LINE Messaging API channel access token、channel secret、webhook port 與自管 tunnel 的公開 URL。透過 _configure_set / _configure_show MCP tools 寫入 ~/.claude/channels/line/.env。
---

# Configure LINE Channel

解析使用者輸入 `$ARGUMENTS` 並協助寫入設定檔。

## 子指令

- 沒有參數或 `show` → 呼叫 MCP tool `_configure_show`，把回傳的 JSON 用條列顯示，token / secret 已遮罩。
- `set-token <token>` → 呼叫 `_configure_set` 帶 `channel_access_token`。
- `set-secret <secret>` → 呼叫 `_configure_set` 帶 `channel_secret`。
- `port <number>` → 呼叫 `_configure_set` 帶 `webhook_port`。
- `public-url <url>` → 呼叫 `_configure_set` 帶 `public_url`（你自管常駐 tunnel 的固定公開 URL，不含 `/webhook`）。
- `wizard` 或無法解析的輸入 → 進入互動模式：依序問 token、secret、public-url，每輸入一筆即呼叫 `_configure_set` 一次。

## 規則

1. 寫入後永遠提醒使用者：「重啟 channel session（exit + `claude --channels plugin:line@wcc723/2026-line-bot-channel-mcp`）以套用新設定」。
2. 提醒設定 LINE Developers Console webhook URL：呼叫 `_tunnel_url` 取當前 URL，貼到 console 的 webhook URL 欄位。
3. 提醒「自動回覆訊息」與「歡迎訊息」要關閉，否則 bot 不會把訊息送到 webhook。
4. token 與 secret 僅在使用者明確要求時才顯示原文，否則只顯示遮罩版。
5. 取得到值後不要把原始 token 印到 session 中以免外洩。
