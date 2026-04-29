---
description: 管理 LINE channel 的白名單與 DM policy。子指令：list / pair / allow / remove / policy。透過 _access_* MCP tools 操作 ~/.claude/channels/line/access.json。
---

# Access Control for LINE Channel

解析使用者輸入 `$ARGUMENTS`，協助管理白名單。

## 子指令對應 MCP tool

| 使用者輸入 | 動作 |
|---|---|
| 無參數 / `list` | `_access_list` → 把 allowFrom、pendingPairs、dmPolicy 用條列顯示 |
| `pair <6-digit-code>` | `_access_pair` 帶 code → 報告兌換結果 |
| `allow <userId>` | `_access_allow` → 把 userId 加入白名單 |
| `remove <userId>` | `_access_remove` → 從白名單移除 |
| `policy <pair\|allowlist\|disabled>` | `_access_set_policy` |

## 規則

1. **每次操作前先 `_access_list`** 取當前狀態，操作後再 `_access_list` 確認。
2. userId 必須是 `U` + 32 位 hex（共 33 字元）。格式不符時直接拒絕，不要呼叫 tool。
3. pair code 只能是 6 位數字。
4. 切換 policy 時提醒影響：
   - `pair`（預設）：陌生人傳訊息會收到配對碼，使用者跑 `/line:access pair <code>` 完成配對才能互動。
   - `allowlist`：陌生人會收到「未授權」訊息一次後不再回應；只允許白名單已存在的 userId。
   - `disabled`：所有陌生人訊息靜默丟棄，不回應。
5. 顯示 pendingPairs 時要把 expiresAt（unix ms）轉成相對時間（例：「3 分鐘後到期」）。
