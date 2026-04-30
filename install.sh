#!/usr/bin/env bash
# install.sh — 在一台 Mac 上安裝 LINE Channel for Claude Code
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/wcc723/2026-line-bot-channel-mcp/main/install.sh | bash
#   或下載後直接執行：bash install.sh
#
# 這個腳本會：
#   1. 檢查 / 安裝 bun、cloudflared
#   2. 透過 marketplace 裝 plugin
#   3. 檢查 LINE secrets 與（如果用 named tunnel）Cloudflare credentials 是否就位
#   4. 印出下一步要怎麼啟動

set -euo pipefail

ENV_FILE="$HOME/.claude/channels/line/.env"
CF_DIR="$HOME/.cloudflared"

step() { printf "\n▶ %s\n" "$1"; }
ok()   { printf "  ✓ %s\n" "$1"; }
warn() { printf "  ⚠ %s\n" "$1" >&2; }
err()  { printf "  ✘ %s\n" "$1" >&2; }

# 1. 必要工具檢查 ────────────────────────────────────────────────
step "檢查 prerequisites"

if ! command -v brew >/dev/null 2>&1; then
  err "Homebrew 未安裝。先到 https://brew.sh 裝起來。"
  exit 1
fi
ok "Homebrew"

if ! command -v claude >/dev/null 2>&1; then
  err "Claude Code 未安裝。先到 https://claude.com/claude-code 裝。"
  exit 1
fi
ok "Claude Code $(claude --version 2>&1 | head -1)"

# 2. 裝 bun + cloudflared ───────────────────────────────────────
step "裝 bun + cloudflared（已存在則略過）"

if ! command -v bun >/dev/null 2>&1; then
  if command -v npm >/dev/null 2>&1; then
    npm install -g bun
  else
    brew install oven-sh/bun/bun
  fi
fi
ok "bun $(bun --version 2>&1)"

if ! command -v cloudflared >/dev/null 2>&1; then
  brew install cloudflared
fi
ok "cloudflared $(cloudflared --version 2>&1 | head -1)"

# 3. 裝 plugin ──────────────────────────────────────────────────
step "透過 marketplace 裝 plugin"

claude plugin marketplace add wcc723/2026-line-bot-channel-mcp 2>&1 \
  | grep -v "already" || true

claude plugin uninstall line@line-bot-channel >/dev/null 2>&1 || true
claude plugin install line@line-bot-channel --scope user >/dev/null
ok "line@line-bot-channel 已安裝"

# 4. 檢查 LINE secrets ──────────────────────────────────────────
step "檢查 LINE secrets"

mkdir -p "$(dirname "$ENV_FILE")"

if [ -f "$ENV_FILE" ]; then
  TOKEN_LEN=$(awk -F= '/^LINE_CHANNEL_ACCESS_TOKEN=/ { v=substr($0, length($1)+2); print length(v) }' "$ENV_FILE" || echo 0)
  SECRET_LEN=$(awk -F= '/^LINE_CHANNEL_SECRET=/ { v=substr($0, length($1)+2); print length(v) }' "$ENV_FILE" || echo 0)
  if [ "${TOKEN_LEN:-0}" -gt 50 ] && [ "${SECRET_LEN:-0}" -ge 32 ]; then
    ok "$ENV_FILE 存在且 token / secret 看起來正常"
  else
    warn "$ENV_FILE 存在但欄位看起來空/短，請檢查"
  fi
else
  warn "$ENV_FILE 不存在"
  cat <<'EOF'

  你需要把舊機器的 ~/.claude/channels/line/.env 複製過來，內容大概像：

      LINE_CHANNEL_ACCESS_TOKEN=<你的 token>
      LINE_CHANNEL_SECRET=<你的 secret>
      LINE_WEBHOOK_PORT=8788
      LINE_TUNNEL_MODE=named
      LINE_PUBLIC_URL=https://line-bot.example.com

  搬法選一個：scp、AirDrop、1Password、加密 USB。**不要走 email 或 git。**
  寫完後 chmod 600 ~/.claude/channels/line/.env
EOF
fi

# 5. Tunnel 模式檢查 ────────────────────────────────────────────
step "檢查 Cloudflare Tunnel 設定"

MODE="quick"
if [ -f "$ENV_FILE" ]; then
  MODE=$(awk -F= '/^LINE_TUNNEL_MODE=/ { v=substr($0, length($1)+2); gsub(/["'"'"']/, "", v); print v }' "$ENV_FILE")
  MODE=${MODE:-quick}
fi

case "$MODE" in
  named)
    if [ -f "$CF_DIR/config.yml" ] && ls "$CF_DIR"/*.json >/dev/null 2>&1; then
      ok "named tunnel：config.yml + credentials json 都在"
      echo ""
      echo "  ⚠ 記得確認 ~/.cloudflared/config.yml 裡的 credentials-file 路徑"
      echo "    指向新機器的 home（如果 username 變了的話）。"
    else
      warn "named tunnel 但 ~/.cloudflared/ 不完整"
      cat <<EOF

  從舊機器複製：
      ~/.cloudflared/config.yml
      ~/.cloudflared/<tunnel-id>.json

  並把 config.yml 內 credentials-file 改成新機器路徑。
EOF
    fi
    ;;
  external)
    ok "external tunnel — 你自己用 ngrok / 其他工具管 tunnel"
    ;;
  quick)
    ok "quick tunnel — channel 啟動時會自動 spawn cloudflared"
    ;;
  *)
    warn "未知的 LINE_TUNNEL_MODE = $MODE"
    ;;
esac

# 6. 完成 ────────────────────────────────────────────────────
step "完成"

cat <<'EOF'

✅ Plugin 安裝完成。下一步啟動：

EOF

case "$MODE" in
  named)
    cat <<'EOF'
  1. 起 cloudflared tunnel（背景或新終端）：
       cloudflared tunnel run <your-tunnel-name>

  2. 起 Claude session（注意：不要在 plugin 源碼目錄裡跑）：
       cd ~
       claude --dangerously-load-development-channels plugin:line@line-bot-channel

  3. 進去後 /mcp 應顯示 plugin:line:line · ✔ connected

  4. 從手機 LINE 傳訊息給 bot 驗證

⚠ 不要兩台同時跑 channel server，access.json 會分裂、訊息會搶。
EOF
    ;;
  *)
    cat <<'EOF'
  1. 起 Claude session（注意：不要在 plugin 源碼目錄裡跑）：
       cd ~
       claude --dangerously-load-development-channels plugin:line@line-bot-channel

  2. 進去後 /mcp 應顯示 plugin:line:line · ✔ connected

  3. /line:tunnel url 取得 webhook URL，貼到 LINE Developers Console
     （或用 README 提供的 PUT /v2/bot/channel/webhook/endpoint API）

  4. 從手機 LINE 傳訊息驗證
EOF
    ;;
esac
