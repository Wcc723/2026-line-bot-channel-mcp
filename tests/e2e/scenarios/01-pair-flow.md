# Scenario: Pair flow (pair policy)

**前置**：DM policy = pair（預設）；access.json `allowFrom = []`。

## 步驟

1. 清空 mock log：`bun run tests/e2e/harness.ts clear`
2. 確認 access policy：呼叫 `_access_set_policy` 帶 `policy=pair`，並用 `_access_list` 確認 `allowFrom` 為空
3. 假裝陌生人傳訊息：
   ```bash
   LINE_CHANNEL_SECRET=$LINE_CHANNEL_SECRET bun run tests/e2e/send-webhook.ts \
     --user Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
     --text "hi from stranger" \
     --reply-token tok-pair-1 \
     --event-id ev-pair-1
   ```
4. 等 100ms（async dispatch）
5. 讀 mock log：`bun run tests/e2e/harness.ts read`
6. 從 log 中找 6 位數字 code（在 `/v2/bot/message/reply` 的 `messages[0].text` 內）
7. 用這個 code 呼叫 `_access_pair`
8. 用 `_access_list` 確認 `allowFrom` 含 `Uaaa...`，且 `pendingPairs` 為空

## 預期

- 步驟 5：mock log 含 1 筆 `POST /v2/bot/message/reply`，body.messages[0].text 含 6 位數字
- 步驟 7：tool 回 `✅ 配對成功`
- 步驟 8：allowlist 含使用者
