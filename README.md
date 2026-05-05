# claude-channel-line

把 **LINE Messaging API** 串到 **Claude Code** 做雙向訊息互動的 channel plugin。

- Claude 可主動透過 LINE 發訊息給你
- 你在 LINE 傳的訊息會被推進 Claude session，由 Claude 看到並回覆
- 內建白名單（pair / allowlist / disabled 三種 policy）
- **使用者身份**：每個白名單 user 可標 **暱稱 / 稱謂 / 角色**，Claude 會用你給的名字稱呼、依角色調整信任度
- 整合 **Cloudflare Named Tunnel**，URL 永久固定（亦支援 quick / external 模式）

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

Channel 是一個 MCP server 子進程（透過 `claude --dangerously-load-development-channels` 啟動），同時在本機跑 webhook server 接收 LINE 推送，並暴露 MCP tools 讓 Claude 對 LINE 發訊息。

## Prerequisites

裝這幾個工具：

- [Bun](https://bun.sh) 1.x — 建議 `npm install -g bun`（或 `brew install oven-sh/bun/bun`）
- [Claude Code](https://claude.com/claude-code) 2.1.123+
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/install-and-setup/installation/) — `brew install cloudflared`
- 一組 LINE Messaging API channel 的 **access token** 與 **channel secret**
- **一個指向 Cloudflare 的網域**（例如 `casper.tw`），用來建立永久固定的 webhook URL

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

## Quick Start

預設走 **named tunnel**——URL 永久固定，LINE Console webhook URL 設一次就好。

### 1. 申請 LINE Messaging API channel

1. [LINE Business ID](https://account.line.biz/login) 登入或註冊
2. [LINE Official Account Manager](https://manager.line.biz/) 建立官方帳號
3. 帳號頁右上角 **Settings → Messaging API → Enable**（會自動建一個 Provider 與 channel）
4. **Settings → Response settings**：
   - **「Chat (聊天)」→ Off**（很多人卡這——詳見 Troubleshooting）
   - **「Webhook」→ On**
   - **「Auto-response messages」→ Off**
   - **「Greeting messages」→ Off**
5. 進入 [LINE Developers Console](https://developers.line.biz/console/) → 點選剛建立的 channel：
   - **Basic settings** 分頁底部複製 **Channel secret**
   - **Messaging API** 分頁底部 Issue + 複製 **Channel access token (long-lived)**

### 2. 設 Cloudflare Named Tunnel（**做完一次永久不用再動**）

需要：Cloudflare 帳號 + 一個指向 Cloudflare DNS 的網域。

```bash
# 一、登入（瀏覽器跳出選網域、Authorize）
cloudflared tunnel login

# 二、建 tunnel（記下回傳的 tunnel ID）
cloudflared tunnel create line-bot-channel

# 三、把子網域路由到 tunnel
cloudflared tunnel route dns line-bot-channel line-bot.example.com

# 四、寫 ~/.cloudflared/config.yml：
cat > ~/.cloudflared/config.yml <<EOF
tunnel: <剛建的 tunnel id>
credentials-file: $HOME/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: line-bot.example.com
    service: http://localhost:8788
  - service: http_status:404
EOF
```

驗證 tunnel 設定 OK（不需要持續跑著，只是測試一次）：

```bash
# 啟動 tunnel
cloudflared tunnel run line-bot-channel &

# 另外一個終端起一個假 server
( printf 'HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\ntunnel ok!\n' | nc -l 8788 ) &
sleep 1
curl -s https://line-bot.example.com/

# 看到 "tunnel ok!" 即通了
pkill -f "cloudflared tunnel run"
```

### 3. 安裝 plugin

```bash
claude plugin marketplace add wcc723/2026-line-bot-channel-mcp
claude plugin install line@line-bot-channel
claude plugin list   # 應看到 line@line-bot-channel ✔ enabled
```

或一鍵：

```bash
curl -fsSL https://raw.githubusercontent.com/wcc723/2026-line-bot-channel-mcp/main/install.sh | bash
```

### 4. 寫 channel 設定檔

```bash
mkdir -p ~/.claude/channels/line
cat > ~/.claude/channels/line/.env <<EOF
LINE_CHANNEL_ACCESS_TOKEN=<貼你的>
LINE_CHANNEL_SECRET=<貼你的>
LINE_WEBHOOK_PORT=8788
LINE_TUNNEL_MODE=named
LINE_TUNNEL_NAME=line-bot-channel
LINE_PUBLIC_URL=https://line-bot.example.com
EOF
chmod 600 ~/.claude/channels/line/.env
```

設定 `LINE_TUNNEL_NAME` 後，channel 啟動時會**自動 spawn `cloudflared tunnel run line-bot-channel`**，你不用另外開終端。

### 5. 啟動 channel session

```bash
claude --dangerously-load-development-channels plugin:line@line-bot-channel
```

進去後 `/mcp` 應顯示 `plugin:line:line · ✔ connected`。`/line:tunnel status` 應看到 `state: running`、url 是你的 named domain。

### 6. 設定 LINE webhook URL（一次性）

LINE Console UI 偶爾 400，**用 API 最穩**：

```bash
TOKEN=$(grep '^LINE_CHANNEL_ACCESS_TOKEN=' ~/.claude/channels/line/.env | cut -d= -f2-)
WEBHOOK="https://line-bot.example.com/webhook"

curl -X PUT https://api.line.me/v2/bot/channel/webhook/endpoint \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"endpoint\":\"$WEBHOOK\"}"

curl -X POST https://api.line.me/v2/bot/channel/webhook/test \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{}'
# 預期：{"success":true,"statusCode":200,"reason":"OK","detail":"200"}
```

### 7. 加 bot 為好友、配對使用者

1. Console > Messaging API 分頁 > 掃 QR code 加好友
2. LINE 傳第一則訊息 → bot 自動回 6 位配對碼
3. Claude session：
   ```
   /line:access pair 123456 nickname=Casper role=owner
   ```
4. 之後再傳訊息 → 直接進 Claude session、Claude 用「Casper」稱呼你

完成。要讓 Claude 主動傳訊息：在 session 直接叫它用 `line_reply` / `line_push` tool。

## 三種 Tunnel 模式

| 模式 | URL 穩定度 | cloudflared 啟動 | 適用場景 |
|---|---|---|---|
| **named**（推薦） | ✅ 永久固定 | channel 自動 spawn（`LINE_TUNNEL_NAME` 設了的話）<br>否則使用者自管 | 生產、長期使用、LINE Bot |
| **quick** | ❌ 每次重啟換 URL | channel 自動 spawn | demo、不接 LINE 的場景 |
| **external** | 視你用什麼工具 | 完全不管 | ngrok / Tailscale Funnel / 其他 |

⚠️ **不建議用 quick 跑 LINE Bot**：每次 channel 重啟 trycloudflare URL 會變，要回 LINE Console 重貼，操作成本高。

## 使用者身份（暱稱 / 稱謂 / 角色）

每個白名單 user 可選擇性帶三個欄位：

| 欄位 | 必填 | 用途 | 範例 |
|---|---|---|---|
| `nickname` | 否 | Claude 稱呼你用的名字 | `Casper`、`A君` |
| `title` | 否 | 你跟使用者的關係描述 | `助教`、`老師`、`媽媽` |
| `role` | 是（預設 `member`） | 信任度。`owner` 完整信任、`member` 對破壞性操作會謹慎 | `owner` / `member` |

設好後 Claude 收到該 user 的訊息會：
- 看到 `nickname` → 用暱稱稱呼（「Casper，剛剛你說的…」）
- 看到 `title` → 組合稱呼（「A 助教好」「老師你問的問題」）
- 看到 `role=member` → 對破壞性操作（rm、改 secret、push commit 等）保持謹慎

**設定範例**：

```text
/line:access pair 123456 nickname=Casper role=owner
/line:access allow Uxxx... nickname="A君" title="助教" role=member
/line:access set Uxxx role=owner
/line:access set Uxxx nickname=""    # 清掉 nickname
```

⚠️ `nickname` / `title` 是 advisory（純文字提示給 Claude 看），**不是 auth**。userId 才是真正的身份識別。

## 在另一台機器上安裝（migrate / 多機）

Repo 根有 `install.sh` 自動化所有可自動化的步驟。

### 一鍵腳本

```bash
curl -fsSL https://raw.githubusercontent.com/wcc723/2026-line-bot-channel-mcp/main/install.sh | bash
```

會做：

1. 檢查 `brew`、`claude` 是否已裝
2. 裝 `bun`、`cloudflared`（如果還沒）
3. `claude plugin marketplace add wcc723/2026-line-bot-channel-mcp` + `install line@line-bot-channel`
4. 偵測你 `~/.claude/channels/line/.env` 是否已就位（有就驗欄位長度，沒有就提示要怎麼搬）
5. 偵測 `LINE_TUNNEL_MODE`，若為 `named` 額外提示要複製 `~/.cloudflared/`
6. 印出「下一步啟動命令」

腳本不會碰 secrets——`.env` 跟 cloudflared credentials 你必須手動從舊機器**安全搬過來**（scp / AirDrop / 1Password / 加密 USB），不要走 email、git、Slack 等。

### 必須手動搬的兩組檔案

| 檔案 | 何時需要 | 怎麼搬 |
|---|---|---|
| `~/.claude/channels/line/.env` | 永遠需要 | `scp old:~/.claude/channels/line/.env ~/.claude/channels/line/.env`<br>之後 `chmod 600` |
| `~/.cloudflared/config.yml` + `~/.cloudflared/<tunnel-id>.json` | 只有 `LINE_TUNNEL_MODE=named` 需要 | `scp old:~/.cloudflared/* ~/.cloudflared/`<br>記得改 `config.yml` 裡 `credentials-file` 路徑 |

LINE Console 的 webhook URL **不需要改**（DNS CNAME 不變）。

### ⚠️ 不要兩台同時跑 channel server

`access.json`（白名單）在每台機器各自一份。兩台同時跑會：
- LINE webhook 由 cloudflared 隨機分流給任一台
- 配對狀態不同步
- 訊息可能漏掉某些 session

退役舊機器：

```bash
# 在舊機器
# 退出 Claude session（/quit）
pkill -f "cloudflared tunnel run"
```

要兩台輪流用：每次只在一台啟動 Claude session，DNS / tunnel 都不用動。

## Environment Variables

| 變數 | 必填 | 預設 | 說明 |
|---|---|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ | — | LINE long-lived channel access token |
| `LINE_CHANNEL_SECRET` | ✅ | — | LINE channel secret（簽章驗證用） |
| `LINE_WEBHOOK_PORT` |  | `8788` | 本地 webhook server port |
| `LINE_TUNNEL_MODE` |  | `quick` | `quick` / `named` / `external` |
| `LINE_TUNNEL_NAME` |  | — | named mode 設了會自動 spawn `cloudflared tunnel run <name>`；不設則使用者自管 tunnel |
| `LINE_PUBLIC_URL` |  | — | named/external 模式的固定公開 URL |
| `LINE_API_BASE` |  | `https://api.line.me` | 測試時可指向 mock server |
| `LINE_STATE_DIR` |  | `~/.claude/channels/line` | 設定 / allowlist / log 檔的位置 |
| `LINE_LOG_FILE` |  | `<state>/server.log` | 設 `off` 完全關閉檔案 log |
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
| `/line:access list` | 顯示白名單（含 nickname/title/role）+ pendingPairs + policy |
| `/line:access pair <6-digit> [nickname=...] [title=...] [role=...]` | 兌換配對碼，可同時設身份 |
| `/line:access allow <userId> [nickname=...] [title=...] [role=...]` | 直接加白名單 |
| `/line:access set <userId> [nickname=...] [title=...] [role=...]` | 更新已存在 user 的身份 |
| `/line:access remove <userId>` | 移出白名單 |
| `/line:access policy <pair\|allowlist\|disabled>` | 切 DM 政策 |
| `/line:tunnel status` | tunnel 狀態 |
| `/line:tunnel url` | 印當前 webhook URL |
| `/line:tunnel restart` | 重啟 cloudflared（quick / named-auto 模式） |

完整 access policy 行為見 [ACCESS.md](./ACCESS.md)。

## 開發者：改 plugin code 後重新驗證

每次改完 code、commit + push 之後，**Claude Code 不會自動拉新版**（cache key 是 plugin 版本，沒 bump 不重抓）。要強制重抓：

```bash
claude plugin marketplace update line-bot-channel
claude plugin uninstall line@line-bot-channel
claude plugin install line@line-bot-channel
# 清掉前一個 session 留下的孤兒 bun（如果有）
lsof -nP -iTCP:8788 -sTCP:LISTEN -t | xargs -I{} kill {} 2>/dev/null
claude --dangerously-load-development-channels plugin:line@line-bot-channel
```

可以包成自己的 shell function 或 `.command` 檔讓流程自動化。

實時觀察 webhook 收到什麼：

```bash
tail -F ~/.claude/channels/line/server.log
```

## E2E 測試

`agents/e2e-tester.md` 提供自動化測試 subagent，模擬 LINE 使用者驅動 channel 走完所有情境。

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

# 終端 3：開 Claude session 載入 channel，呼叫 e2e-tester agent
claude --dangerously-load-development-channels plugin:line@line-bot-channel
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

### 訊息不會進 Claude session（最常見）

依下列順序排查：

1. **`chatMode` 不是 `bot`**（OA Manager 的 `Chat` 沒關）：
   ```bash
   TOKEN=$(grep '^LINE_CHANNEL_ACCESS_TOKEN=' ~/.claude/channels/line/.env | cut -d= -f2-)
   curl -s https://api.line.me/v2/bot/info -H "Authorization: Bearer $TOKEN"
   ```
   要看到 `"chatMode":"bot"`。如果是 `"chat"`，回 OA Manager → Response settings → Chat 切 Off。
2. **server log 沒看到 `event received`**：webhook 沒進到 channel。
   - 檢查 `/line:tunnel status` 的 url、確認跟 LINE Console webhook URL 一致
   - cloudflared 是否在跑：`pgrep -f "cloudflared tunnel run"`
3. **server log 看到 `event received` 但 session 沒反應**：通常是 plugin 沒裝（只用 `--plugin-dir`）或忘了 `--dangerously-load-development-channels`。確認 `claude plugin list` 有 `line@line-bot-channel ✔ enabled`、`/mcp` 顯示 `connected`。

### `Unable to reach the origin service ... connection refused`

cloudflared 通了，但 channel server 沒在 listen `localhost:8788`。

- 檢查 `lsof -nP -iTCP:8788 -sTCP:LISTEN`
- 沒東西在 listen → 沒啟動 Claude session、或 Claude 啟動但 MCP fail（`/mcp` 看狀態）

### `/mcp` 顯示 `line · ✘ failed` 或 `Failed to reconnect to line`

九成是 port 8788 撞了。常見原因：

- 上一個 session 的孤兒 bun 沒清掉：
  ```bash
  lsof -nP -iTCP:8788 -sTCP:LISTEN -t | xargs -I{} kill {} 2>/dev/null
  ```
- 你在 plugin 的 git clone 目錄下起 claude（**只有開發者會碰到**）：專案層 `.mcp.json` 跟 plugin MCP 搶 port，從別處啟動即可。

### Webhook Verify 顯示 `400 Bad request` 或 `{message:null,...}`

這是 LINE Developers Console UI 的 bug，不是你的問題。**用 API 改 webhook URL** 繞過：

```bash
TOKEN=$(grep '^LINE_CHANNEL_ACCESS_TOKEN=' ~/.claude/channels/line/.env | cut -d= -f2-)
curl -X PUT https://api.line.me/v2/bot/channel/webhook/endpoint \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"endpoint":"https://your-url/webhook"}'
curl -X POST https://api.line.me/v2/bot/channel/webhook/test \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

`success: true` 即驗證通過。

### Webhook Verify 通過但實際傳訊息 channel 沒收到

通常是 `chatMode = chat`（見上）或「Auto-response messages: Enabled」搶走訊息。

### 收到「感謝您的訊息！很抱歉，本帳號無法個別回覆用戶的訊息」

這是 LINE OA 的預設自動回應模板，代表 chatMode 是 `chat` 或 `Auto-response messages` 開著。回 OA Manager 全關掉。

### 自動 spawn cloudflared 沒生效

named mode 下 channel 應該自動 spawn cloudflared。檢查：

- `LINE_TUNNEL_NAME` 有沒有設？沒設就維持「使用者自管」行為
- log 看到 `cloudflared not in PATH` → 裝 cloudflared 後重啟 channel
- log 看到 `detected existing cloudflared ... skipping spawn` → 表示你（或 launchd）已有一份在跑，**這是預期的**，channel 不會搶

### Reply token expired

正常行為。`line_reply` 會自動 fallback 到 push API。要避免 fallback 就在收到訊息 30 秒內回。

### Claude session 收到訊息但 Claude 沒反應

session 處於 idle 才會處理 channel 事件；如果 Claude 正在做其他事，事件會排隊。

## Security

- `~/.claude/channels/line/.env`、`~/.claude/channels/line/access.json`、`~/.claude/channels/line/server.log` 已 chmod 600
- 千萬不要把 `.env` commit
- token rotate：到 LINE Developers Console reissue access token，再 `/line:configure set-token <新>`，重啟 session
- 使用者錯把 group/room 訊息送來 → channel 直接丟棄（v1 只支援 1-on-1 DM）

## FAQ

**Q：channel 是 24/7 service 嗎？**
A：不是。Channel 只在 Claude session 跑著的時候才接收訊息。session 結束就停了。

**Q：reply token 為什麼有 30 秒限制？**
A：這是 LINE API 的設計。超時自動走 push（會吃月配額）。

**Q：可以同時跑多個 LINE bot 嗎？**
A：v1 不支援。一個 channel session 對應一個 channel access token。

**Q：為什麼用 Bun 不用 Node？**
A：對齊官方 telegram channel 範本（[anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)）；Bun 原生支援 TS、`bun run` 啟動會自動裝依賴。

**Q：為什麼要 `--dangerously-load-development-channels` 不能直接 `--channels`？**
A：研究預覽期間 `--channels` 只認 Anthropic 維護的 allowlist。自製 channel 必須走 dev flag。

## License

Apache-2.0
