# Scenario: Reply fallback to push

**前置**：使用者已在白名單；mock LINE 已啟動。

## 步驟

1. `bun run tests/e2e/harness.ts clear`
2. 確認 access：`_access_allow` 帶 `user_id=Uaaa...`，`_access_set_policy` 帶 `policy=pair`
3. 假裝白名單使用者傳訊息（會帶 replyToken=tok-A）
4. 等 100ms
5. 在 session 立刻呼叫 `line_reply` 帶 user_id + text "立即回覆"
6. 讀 mock log → 應該是 1 筆 `/v2/bot/message/reply`
7. 等 35 秒（讓 reply token TTL 過期），或直接測試「無 token 時的行為」：
   - 跳過步驟 3-4，直接呼叫 `line_reply`
8. 讀 mock log → 應該看到 `/v2/bot/message/push`

## 預期

- 步驟 6：log 含 reply call
- 步驟 8：log 含 push call（fallback 觸發）
- `line_reply` 的回應字串應提及 fallback
