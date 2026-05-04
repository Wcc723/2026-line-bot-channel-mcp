---
description: 管理 LINE channel 的白名單、使用者身份（暱稱 / 稱謂 / 角色）與 DM policy。子指令：list / pair / allow / set / remove / policy。透過 _access_* MCP tools 操作 ~/.claude/channels/line/access.json。
---

# Access Control for LINE Channel

解析使用者輸入 `$ARGUMENTS`，協助管理白名單與每個使用者的身份。

## 子指令對應 MCP tool

| 使用者輸入 | 動作 |
|---|---|
| 無參數 / `list` | `_access_list` → 顯示 users（含 nickname/title/role）、pendingPairs、dmPolicy |
| `pair <6-digit>` `[nickname=...]` `[title=...]` `[role=...]` | `_access_pair` 兌換配對碼，可同時設定身份 |
| `allow <userId>` `[nickname=...]` `[title=...]` `[role=...]` | `_access_allow` 直接加白名單 |
| `set <userId>` `[nickname=...]` `[title=...]` `[role=...]` | `_access_set` 更新已存在 user 的 meta（傳空字串清空 nickname/title） |
| `get <userId>` | `_access_get_user` 查單一 user 完整資料 |
| `remove <userId>` | `_access_remove` |
| `policy <pair\|allowlist\|disabled>` | `_access_set_policy` |

## 三個身份欄位

| 欄位 | 必填 | 用途 |
|---|---|---|
| **nickname** | 否 | 暱稱，Claude 用這個稱呼使用者。例：`Casper`、`A君` |
| **title** | 否 | 稱謂，描述與使用者的關係。例：`助教`、`老師`、`媽媽` |
| **role** | 是（預設 `member`） | `owner` 或 `member`，決定 Claude 的信任度與行為 |

## 規則

1. **每次操作前先 `_access_list`** 取當前狀態，操作後再 `_access_list` 確認。
2. userId 必須是 `U` + 32 位 hex（共 33 字元）。格式不符時直接拒絕，不要呼叫 tool。
3. pair code 只能是 6 位數字。
4. role 只能是 `owner` 或 `member`。
5. 自然語言解析：使用者可能會說「把 Uxxx 設成 A 助教」、「我是 Casper、owner」等等。請從中抽出 nickname / title / role，再呼叫對應 tool。
6. 切換 policy 時提醒影響：
   - `pair`（預設）：陌生人傳訊息會收到配對碼，使用者跑 `/line:access pair <code>` 完成配對才能互動。
   - `allowlist`：陌生人會收到「未授權」訊息一次後不再回應；只允許白名單已存在的 userId。
   - `disabled`：所有陌生人訊息靜默丟棄，不回應。
7. 顯示 pendingPairs 時要把 expiresAt（unix ms）轉成相對時間（例：「3 分鐘後到期」）。
8. 顯示 user 列表時：若有 nickname 顯示暱稱當主要識別、後接 (role)；userId 用縮寫格式（前 6 + 後 4 字元）讓畫面整潔。

## Claude 接到 LINE 訊息的行為指引

當你收到 channel 訊息（`<channel source="line" ...>`），meta 會帶 `nickname` / `title` / `role`。請用以下規則回應：

- **稱呼**：若有 `nickname` 就用暱稱（例：「Casper，剛剛你說的那個檔案…」）。若同時有 `title`，可組合（例：「A 助教好」「老師你問的問題」）。沒有 nickname 才用 user_id 或不稱呼。
- **role=owner**：主要使用者，照常回應，可執行讀檔、寫檔、跑 shell 等操作。
- **role=member**：邀請來的使用者，禮貌但對破壞性或敏感操作（rm、修改 secret、推 commit 等）謹慎，必要時先請使用者在主要 session 確認，或直接告知這需要 owner 出面。
- **沒有 entry 或無 role**：謹慎回應，視為 member。
