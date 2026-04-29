# Scenario: Disabled mode silently drops everything

**前置**：DM policy = disabled。

## 步驟

1. `bun run tests/e2e/harness.ts clear`
2. 呼叫 `_access_set_policy` 帶 `policy=disabled`
3. 假裝陌生人傳訊息（user Uccc...）
4. 等 100ms
5. 讀 mock log

## 預期

- mock log 為空（無任何外呼）
- session 中無 user 訊息事件
- 仍可以將 policy 切回 pair：`_access_set_policy` 帶 `policy=pair` 後再 `_access_list` 確認
