# Access Control

LINE channel 的白名單機制。所有狀態存於 `~/.claude/channels/line/access.json`。

## State 檔結構

```json
{
  "dmPolicy": "pair",
  "users": [
    {
      "userId": "Ucb2f92114934e9357e967c8e3420fabe",
      "nickname": "Casper",
      "role": "owner",
      "addedAt": 1714000000000
    },
    {
      "userId": "Uxxx...",
      "nickname": "A君",
      "title": "助教",
      "role": "member",
      "addedAt": 1714500000000
    }
  ],
  "pendingPairs": {
    "123456": {
      "userId": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "createdAt": 1714378400000,
      "expiresAt": 1714379000000
    }
  }
}
```

每筆 `users` entry 必須有 `userId` 與 `role`；`nickname` / `title` 都是 optional。

| 欄位 | 必填 | 範例 | 用途 |
|---|---|---|---|
| `userId` | ✓ | `U` + 32 hex | LINE 平台 ID，認證唯一識別 |
| `role` | ✓ | `"owner"` / `"member"` | 信任度與行為標籤 |
| `nickname` | | `"Casper"`、`"A君"` | Claude 稱呼用 |
| `title` | | `"助教"`、`"老師"` | 與使用者的關係描述 |
| `addedAt` | ✓ | unix ms | 加入時間，未來 audit / 排序用 |

每次有訊息進來 channel 重新讀此檔案，所以你可以手改這個檔再立即生效（需要原子寫入避免半寫狀態，建議透過 `/line:access` 指令）。

## 三種 DM Policy

### `pair`（預設、推薦）

陌生人傳第一則訊息時：

1. channel 生 6 位數字配對碼，寫入 `pendingPairs`
2. 透過 LINE Reply API 把配對碼傳回給對方
3. **不**把這則訊息推給 Claude session
4. 對方把碼貼給該人類使用者
5. 使用者在 Claude session 跑 `/line:access pair 123456`
6. channel 把該 userId 加入 `allowFrom`，刪掉 pendingPair

之後該 user 的訊息會直接進入 session。

**TTL**：配對碼 10 分鐘失效，過期則刪。

### `allowlist`

只有 `allowFrom` 內的 userId 可以互動。陌生人會收到一次「未授權」回覆後不再回應。適合：

- 已知所有授權用戶 ID（從 LINE 後台或先前配對）
- 不希望任何陌生人收到 bot 的回應

### `disabled`

所有訊息靜默丟棄，無任何回應。適合：

- 想暫停 channel 但保留設定
- bot 還在開發、不想對外回應

## Pairing 時序圖

```
LINE 使用者              LINE Platform           Channel               Claude session
     │                       │                      │                      │
     │ 傳 "hi"               │                      │                      │
     ├──────────────────────►│                      │                      │
     │                       │ POST /webhook        │                      │
     │                       ├─────────────────────►│                      │
     │                       │                      │ 生 pair code 654321  │
     │                       │ Reply API            │ 寫 pendingPairs      │
     │                       │◄─────────────────────┤                      │
     │ 「請貼到 Claude...    │                      │                      │
     │  654321」             │                      │                      │
     │◄──────────────────────┤                      │                      │
     │                       │                      │                      │
     │  （切到電腦）         │                      │                      │
     │                       │                      │  /line:access pair 654321
     │                       │                      │◄─────────────────────┤
     │                       │                      │ allowFrom += userId  │
     │                       │                      ├─────────────────────►│
     │                       │                      │  ✅ 配對成功         │
     │                       │                      │                      │
     │ 傳 "test"             │                      │                      │
     ├──────────────────────►├─────────────────────►│                      │
     │                       │                      │ allow → notify       │
     │                       │                      ├─────────────────────►│
     │                       │                      │  Claude 回覆…        │
```

## 指令

| 指令 | 動作 |
|---|---|
| `/line:access list` | 顯示 users（含身份）、pendingPairs、dmPolicy |
| `/line:access pair <code> [nickname=..] [title=..] [role=..]` | 兌換 6 位配對碼，可同時設身份 |
| `/line:access allow <userId> [nickname=..] [title=..] [role=..]` | 直接加入白名單 |
| `/line:access set <userId> [nickname=..] [title=..] [role=..]` | 更新已存在 user 的身份（傳空字串清空 nickname/title） |
| `/line:access remove <userId>` | 移除 |
| `/line:access policy pair\|allowlist\|disabled` | 切 policy |

## Threat Model

| 風險 | 緩解 |
|---|---|
| 陌生人騷擾 | pair 模式預設不轉發訊息給 Claude；allowlist/disabled 完全擋 |
| 配對碼被猜中 | 6 位數字 = 1M 種；TTL 10 分鐘；同一時刻 pendingPairs 通常 ≤ 1 |
| Webhook 簽章被偽造 | HMAC-SHA256（channel secret），用 `timingSafeEqual` 比對 |
| Token 外洩 | `.env` chmod 600；rotate 流程見 README Security 段 |
| webhook retry 重複處理 | dispatcher 用 webhookEventId LRU 去重（最近 1024 筆） |
| **`nickname` / `title` 被當作 auth** | **不要**：這兩欄是純 advisory 字串，給 Claude 顯示用。**真正的身份識別永遠是 `userId`**（由 LINE 平台簽過名）。任何人不能透過操控 nickname 假冒別人——他們的 userId 不會變 |
| **role=member 被當作 hard sandbox** | role 是 advisory，Claude 自行依角色調整；channel 層不阻擋 MCP tool 呼叫。要硬擋需要在 Claude session 的 system prompt / CLAUDE.md 加規則 |

## Migration

從 `pair` 切到 `allowlist`：

```text
/line:access list           # 確認 allowFrom 已含所有合法 user
/line:access policy allowlist
```

從 `allowlist` 切回 `pair`（重新開放配對）：

```text
/line:access policy pair
```

從任何模式切到 `disabled`（暫停所有外部互動）：

```text
/line:access policy disabled
```
