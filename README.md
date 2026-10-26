# discord-vote-bot

Serverless Discord 投票機器人（流派 / 請假出席調查），跑在 **Cloudflare Workers + D1 + Durable Objects**，不需要常駐主機。

## 功能

| 需求 | 指令 / 操作 |
|---|---|
| 發布投票（自訂標題、內容、圖片） | `/vote create [image] [channel] [template] [check_role]` → 表單填標題、內容、選項、截止時間 |
| 按鈕投票、按鈕前可放伺服器表情 | 選項一行一個：`⚔️ 碎夢`、`<:suimeng:123…> 素問`、`:suimeng: 素問` |
| 請假選項 | 加 `[請假]`，或標籤含「請假」；點選時可填請假原因（可留空） |
| 重新投票 | 截止前再點其他按鈕即改票；`↩️ 撤回投票` |
| 自訂截止時間 | `2026-11-01 21:00`、`11/1 21:00`、`明天 21:00`、`21:00`、`3d`、`1d12h`；`/vote edit` 可改（延後會重新開放） |
| 截止投票 | 到時間自動截止（DO alarm，cron 每 10 分鐘補檢查）／`/vote close` |
| 顯示分布 | 投票訊息即時統計；`📊` 按鈕看自己的選擇；`/vote status` 看名單 |
| 匯出 | `/vote export format:csv\|sheets`：投票人、選項、類型（流派/請假/未投票）、請假原因、時間 |
| 投票 ID | 6 碼短 ID（如 `K7Q2MX`），所有 `id:` 參數支援標題搜尋 autocomplete |
| 刪除 | `/vote delete`（二次確認，連同頻道訊息） |
| 9-1 設定檢查身分組 | `/vote-config check-role`（每個投票可用 `check_role` 覆寫） |
| 9-2 已投 / 未投進度 | `/vote progress id [role] [public]` |
| 9-3 自動標記未投票者 | `/vote-config tag-role role auto:true` → 截止時自動加身分組 |
| 9-4 手動標記 | `/vote tag id`；`/vote untag id` 移除；補投的人會自動移除標記 |
| 其他 | `/vote list`、`/vote-template save/list/delete`（存常用流派清單）、`/vote-config show/admin-role/timezone/sheet` |

## 架構

```
Discord ──HTTP(Ed25519 簽章)──▶ Worker ──▶ D1：投票、選項、選票、設定、範本
                                   │
                                   └──▶ Durable Object（每個投票一個）
                                         ・截止時間 alarm 自動關閉
                                         ・合併 2 秒內的投票再更新訊息（避開編輯速率限制）
                                         ・分批加 / 移除身分組（每批 25 人）
```

- 用 Interactions Endpoint（HTTP）而不是 Gateway，因此 bot 在成員列表會顯示**離線**，屬正常現象。
- 圖片以附件重新上傳到投票訊息，避免 Discord CDN 連結過期。

## 部署

1. **Discord Developer Portal** 建立 Application
   - Bot 頁：取得 Token，開啟 **Server Members Intent**（9-2/9-3/9-4 列成員需要）
   - General Information：記下 Application ID、Public Key
2. **Cloudflare**
   ```bash
   npm install
   npx wrangler login
   npx wrangler d1 create discord-vote-bot     # 把 database_id 填進 wrangler.toml
   npm run db:migrate
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put DISCORD_TOKEN
   npm run deploy                               # 記下 https://discord-vote-bot.<你的子網域>.workers.dev
   ```
3. Developer Portal → General Information → **Interactions Endpoint URL** 填上 Worker 網址（Discord 會打 PING 驗證）
4. 註冊指令
   ```bash
   DISCORD_TOKEN=... DISCORD_APP_ID=... GUILD_ID=伺服器ID npm run register   # 伺服器指令立即生效
   ```
5. 邀請 bot：OAuth2 URL Generator 勾 `bot` + `applications.commands`，權限勾「檢視頻道、發送訊息、嵌入連結、附加檔案、讀取訊息歷史、管理身分組」
6. 伺服器設定 → 身分組：把 bot 的身分組**拖到標記身分組之上**

### Google 試算表匯出（選用）

1. Google Cloud 建立 service account、啟用 Google Sheets API、下載 JSON 金鑰
2. `npx wrangler secret put GOOGLE_SA_EMAIL`（JSON 的 `client_email`）
3. `npx wrangler secret put GOOGLE_SA_KEY`（JSON 的 `private_key`，整段貼上）
4. 試算表以「編輯者」分享給該 email，在 Discord 執行 `/vote-config sheet <網址>`

每個投票寫入一個以投票 ID 開頭的分頁，重複匯出會覆寫。

## 開發

```bash
npm test            # 單元測試（時間解析、選項解析、CSV）
npm run typecheck
npm run db:migrate:local && npm run dev   # 本機需要 .dev.vars 放 DISCORD_PUBLIC_KEY / DISCORD_TOKEN
```

## 預設決策（待確認）

開發時以下問題先採用預設做法，要改都不難：

1. **單選**：一人一票，改票會覆蓋。
2. 選項每次可自由輸入，也可以套用**範本**。
3. 點**請假**會跳表單填原因（可留空），匯出時多一欄。
4. **截止後不能改票**，按鈕會變灰；延後截止時間會重新開放。
5. 投票訊息**公開顯示各選項人數**，名單只有管理員透過 `/vote status` 看得到（預設只有自己看得到）。
6. 建立後**立即發布**，沒有草稿或排程發布功能。
7. 時區預設 **Asia/Taipei**；沒填時間預設 23:59。
8. 截止時在原訊息下**回覆結果摘要**，不會 @ 未投票的人。
9. 「管理伺服器」權限或 `admin-role` 可以管理投票，一般成員只能按按鈕。
10. `/vote progress` 預設只有下指令的人看得到，加 `public:true` 才公開。
11. 「Google 表單」改用 **Google 試算表**（Forms API 無法寫入回應）；CSV 永遠可用。
12. 匯出包含未投票者（需設定檢查身分組）和伺服器暱稱，**不含改票歷程**。
13. 刪除投票 = **刪訊息 + 刪資料**，直接刪除，不保留。
14. 自動標記在**截止時**觸發。
15. 被標記的人補投（期間內）時自動移除標記；`/vote untag` 手動清除。開新投票時**不會**自動清空身分組。
16. 每次檢查**一個**身分組。
17. 伺服器設定一個預設值，每個投票可以用 `check_role` 覆寫。
18. 假設伺服器 **5,000 人以下**（最多可抓 50,000 人，但單次指令會變慢）。
19. 支援多個伺服器共用同一個 bot，資料依伺服器分開。
20. 語言用 **TypeScript**。
