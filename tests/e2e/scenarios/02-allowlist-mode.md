# Scenario: Allowlist mode rejects strangers

**前置**：DM policy = allowlist；`allowFrom` 不含此 user。

## 步驟

1. `bun run tests/e2e/harness.ts clear`
2. 呼叫 `_access_set_policy` 帶 `policy=allowlist`
3. 確認 `_access_list` 中 `allowFrom` 不含 Ubbb...
4. 假裝陌生人傳訊息：
   ```bash
   LINE_CHANNEL_SECRET=$LINE_CHANNEL_SECRET bun run tests/e2e/send-webhook.ts \
     --user Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
     --text "hi" --reply-token tok-allow-1 --event-id ev-allow-1
   ```
5. 等 100ms
6. 讀 mock log

## 預期

- 步驟 6：mock log 中只有 1 筆 `/v2/bot/message/reply`（拒絕訊息），訊息文字含 「未在 Claude Code Channel 白名單中」之類字樣
- access.json 的 `pendingPairs` 為空（因為非 pair 模式）
- session 中 e2e-tester agent 沒有觀察到 user 訊息事件
