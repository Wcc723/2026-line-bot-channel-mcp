# claude-channel-line

把 **LINE Messaging API** 串到 **Claude Code** 做雙向訊息互動的 channel plugin。

- Claude 可主動透過 LINE 發訊息給你
- 你在 LINE 傳的訊息會被推進 Claude session，由 Claude 回覆
- 內建白名單（pair / allowlist / disabled 三種 policy）
- 整合 Cloudflare Tunnel 三種模式（quick / named / external）

## 架構

```
LINE 用戶 ──► LINE Platform
                  │ HTTPS webhook
                  ▼
        Cloudflare Tunnel (HTTPS)
                  │
                  ▼
   localhost:8788 (Bun + Hono)
                  │ 簽章驗證 → access policy
                  ▼
           MCP notification ──► Claude Code session
                                       │
                                       ▼
                              line_reply / line_push tool
                                       │
                  LINE Platform ◄──────┘
```

Channel 是一個 MCP server 子進程（透過 `claude --channels` 啟動），同時在本機跑 webhook server 接收 LINE 推送，並暴露 MCP tools 讓 Claude 對 LINE 發訊息。

## Prerequisites

- [Bun](https://bun.sh) 1.x（package manager + runtime）
- [Claude Code](https://claude.com/claude-code)
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/install-and-setup/installation/)（quick / named 模式必需）
- 一組 LINE Messaging API channel 的 **access token** 與 **channel secret**

```bash
brew install oven-sh/bun/bun
brew install cloudflared
```

## Concepts

LINE 帳號層級對照：

| 層級 | 說明 |
|---|---|
| **Business ID** | 你的 LINE 商業帳號 |
| **Provider** | 在 Business ID 之下的「服務提供者」（一旦選定不能改） |
| **Messaging API channel** | 對應一個官方帳號（Official Account），這就是 bot 本身。token / secret 在這裡取得 |

兩種容易混淆的設定：

- **Channel access token**（長期）→ 用來呼叫 LINE API 發訊息
- **Channel secret** → 用來驗證 LINE webhook 的簽章

## Quick Start (30 分鐘)

> 7 步快速上手。詳細說明見下節。

1. 安裝依賴：`brew install oven-sh/bun/bun cloudflared`
2. 在 [LINE Official Account Manager](https://manager.line.biz/) 建帳號 → 啟用 Messaging API → 進入 [LINE Developers Console](https://developers.line.biz/console/) 取 **Channel access token** 與 **Channel secret**
3. **關閉**「自動回覆訊息」與「歡迎訊息」（在 Official Account Manager 的「回應設定」）
4. 安裝 plugin：在 Claude Code 跑 `/plugin install line@wcc723/2026-line-bot-channel-mcp`
5. 啟動 channel：`claude --channels plugin:line@wcc723/2026-line-bot-channel-mcp`
6. 在 session 設定 token：`/line:configure set-token <TOKEN>` 然後 `/line:configure set-secret <SECRET>`，**重啟 channel**
7. 重啟後跑 `/line:tunnel url` 取 webhook URL，貼到 LINE Developers Console > Messaging API settings > **Webhook URL** 並按 **Verify** 拿綠勾。加 bot 為好友、傳第一則訊息 → 在 session 跑 `/line:access pair <code>` 完成配對

完成。再傳訊息給 bot，Claude session 就會看到。

## Step-by-step Setup

### 1. 申請 LINE Messaging API channel

1. 進入 [LINE Business ID](https://account.line.biz/login) 登入或註冊
2. 在 [LINE Official Account Manager](https://manager.line.biz/) 建立官方帳號
3. 帳號頁右上角「**Settings → Messaging API**」→ 啟用 Messaging API（會自動建一個 Provider 與 channel）
4. 進入 [LINE Developers Console](https://developers.line.biz/console/) → 點選剛建立的 channel
5. **Basic settings** 分頁：
   - 頁面下方「**Channel secret**」→ 複製
6. **Messaging API** 分頁：
   - 「**Channel access token (long-lived)**」→ 點 Issue 後複製

### 2. ⚠️ 關閉自動回覆與歡迎訊息

LINE 預設的 Auto-reply 會搶走訊息，導致你的 webhook 收不到。**這個一定要關**。

在 LINE Official Account Manager 點選你的帳號 → **Settings → Response settings**：

- **「Auto-response messages」→ Disabled**
- **「Greeting messages」→ Disabled**
- **「Webhook」→ Enabled**

### 3. 安裝並設定 channel plugin

```bash
# 在 Claude Code 中
/plugin install line@wcc723/2026-line-bot-channel-mcp
```

啟動：

```bash
claude --channels plugin:line@wcc723/2026-line-bot-channel-mcp
```

第一次啟動會有 warning「config_missing」。在這個 session 中跑：

```text
/line:configure set-token <你的 channel access token>
/line:configure set-secret <你的 channel secret>
```

token / secret 寫到 `~/.claude/channels/line/.env`（chmod 600）。**寫完要 exit 並重啟 session** 才會載入。

### 4. 設定 Cloudflare Tunnel

#### Quick mode（預設，免設定）

啟動後 channel 自動 spawn `cloudflared tunnel --url http://localhost:8788`，從 stderr 抓到 trycloudflare.com URL 並通知你。

```text
/line:tunnel url
# → https://random-name.trycloudflare.com/webhook
```

把這 URL 貼到 LINE Developers Console > Messaging API > **Webhook URL** 欄位，按 **Verify**，拿到綠勾即成功。

⚠️ Quick tunnel **每次重啟 channel URL 會變動**，要重新貼一次。

#### Named mode（建議生產環境）

URL 固定，不用重貼：

```bash
cloudflared tunnel login
cloudflared tunnel create line-channel
cloudflared tunnel route dns line-channel line-bot.example.com
# 編輯 ~/.cloudflared/config.yml 設 ingress 指向 localhost:8788
cloudflared tunnel run line-channel
```

然後切到 named 模式：

```text
/line:configure tunnel-mode named
/line:configure public-url https://line-bot.example.com
```

#### External mode

你已經用 ngrok / Tailscale Funnel / 其他方式暴露 8788，channel 就只 listen port：

```text
/line:configure tunnel-mode external
/line:configure public-url https://your.tunnel.example.com
```

### 5. 配對使用者（白名單）

1. 加 bot 為好友（掃 LINE Developers Console > Messaging API 分頁的 QR code）
2. 在 LINE 傳第一則訊息 → bot 自動回覆 6 位數字配對碼
3. 在 Claude session 跑：
   ```text
   /line:access pair 123456
   ```
4. 完成後再傳訊息 → Claude session 收到事件

如果你想跳過配對直接加白名單：

```text
/line:access allow Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Environment Variables

| 變數 | 必填 | 預設 | 說明 |
|---|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | — | LINE long-lived channel access token |
| `LINE_CHANNEL_SECRET` | ✅ | — | LINE channel secret（簽章驗證用） |
| `LINE_WEBHOOK_PORT` |  | `8788` | 本地 webhook server port |
| `LINE_TUNNEL_MODE` |  | `quick` | `quick` / `named` / `external` |
| `LINE_PUBLIC_URL` |  | — | named/external 模式的固定公開 URL |
| `LINE_API_BASE` |  | `https://api.line.me` | 測試時可指向 mock server |
| `LINE_STATE_DIR` |  | `~/.claude/channels/line` | 設定 / allowlist 檔的位置 |
| `LINE_LOG_LEVEL` |  | `info` | `debug` / `info` / `warn` / `error` |

可寫在 `~/.claude/channels/line/.env`，也可走 shell env 覆寫。

## Slash Commands

| 指令 | 說明 |
|---|---|
| `/line:configure` | 看當前設定 |
| `/line:configure set-token <TOKEN>` | 設定 channel access token |
| `/line:configure set-secret <SECRET>` | 設定 channel secret |
| `/line:configure tunnel-mode <quick\|named\|external>` | 切 tunnel 模式 |
| `/line:configure public-url <URL>` | 設 named/external 模式的公開 URL |
| `/line:access list` | 顯示白名單 + pendingPairs + policy |
| `/line:access pair <6-digit>` | 兌換配對碼 |
| `/line:access allow <userId>` | 直接加白名單 |
| `/line:access remove <userId>` | 移出白名單 |
| `/line:access policy <pair\|allowlist\|disabled>` | 切 DM 政策 |
| `/line:tunnel status` | tunnel 狀態 |
| `/line:tunnel url` | 印當前 webhook URL |
| `/line:tunnel restart` | 重啟 cloudflared（quick 模式） |

完整 access policy 行為見 [ACCESS.md](./ACCESS.md)。

## E2E 測試

`agents/e2e-tester.md` 提供一個自動化測試 subagent，模擬 LINE 使用者驅動 channel 走完所有情境。

```bash
# 終端 1：起 mock LINE API
bun run tests/e2e/harness.ts up 9999

# 終端 2：起 channel（測試模式：API base 指向 mock，tunnel 走 external）
LINE_CHANNEL_ACCESS_TOKEN=test-token \
LINE_CHANNEL_SECRET=test-secret \
LINE_API_BASE=http://localhost:9999 \
LINE_TUNNEL_MODE=external \
LINE_PUBLIC_URL=http://localhost:8788 \
LINE_STATE_DIR=/tmp/line-e2e-state \
bun start

# 終端 3：開 Claude Code session 載入 channel，呼叫 e2e-tester agent
claude --channels plugin:line@wcc723/2026-line-bot-channel-mcp --plugin-dir .
> 請呼叫 e2e-tester subagent 跑完所有情境
```

## 單元 / 整合測試

```bash
bun install
bun test                # 全部
bun test tests/unit     # 單元
bun test tests/integration   # 整合
```

## Troubleshooting

### Webhook Verify 按下去顯示「The webhook returned an HTTP status code other than 200.」

- 簽章驗證失敗：確認 channel secret 正確、`/line:configure set-secret` 後有重啟 session
- Tunnel 沒指到 8788：`/line:tunnel status` 確認 url 與 port

### 收不到訊息

- 「自動回覆訊息」未關：再去 Official Account Manager 確認 Response settings
- bot 沒被加好友：用 LINE Developers Console > Messaging API 的 QR code 加好友
- DM policy 是 `disabled`：跑 `/line:access policy pair`

### `cloudflared` 找不到 URL

- 升級 `cloudflared`：`brew upgrade cloudflared`
- 切到 external 模式自管 tunnel：`/line:configure tunnel-mode external`

### Reply token expired

正常行為。`line_reply` 會自動 fallback 到 push API。要避免 fallback 就在收到訊息 30 秒內回。

### Claude session 收到訊息但 Claude 沒反應

session 處於 idle 才會處理 channel 事件；如果 Claude 正在做其他事，事件會排隊。

## Security

- `~/.claude/channels/line/.env` 已 chmod 600
- 千萬不要把 `.env` commit
- token rotate：到 LINE Developers Console reissue access token，再 `/line:configure set-token <新>`，重啟 session
- 使用者錯把 group/room 訊息送來 → channel 直接丟棄（v1 只支援 1-on-1 DM）

## FAQ

**Q：channel 是 24/7 service 嗎？**
A：不是。Channel 只在 `claude --channels ...` 跑著的時候才接收訊息。Claude session 結束就停了。

**Q：reply token 為什麼有 30 秒限制？**
A：這是 LINE API 的設計。超時自動走 push（會吃月配額）。

**Q：可以同時跑多個 LINE bot 嗎？**
A：v1 不支援。一個 channel session 對應一個 channel access token。

**Q：為什麼用 Bun 不用 Node？**
A：對齊官方 telegram channel 範本（[anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)）；Bun 原生支援 TS、`bun run` 啟動會自動裝依賴。

## License

Apache-2.0
