# 部署到 Cloudflare（可以全程在手機上做）

跑完之後你會有：

- 一個**網址**，手機隨時打開就看得到最新掃描
- **每 5 分鐘自動掃描**，手機關機也照跑
- 有標的通過全部進場條件就**發 Discord**
- 一支**獨立的心跳守衛**，Guardian 掛掉時通知你

兩支 Worker 都是單一檔案，直接貼進 Cloudflare 的網頁編輯器就行。
不需要 wrangler、不需要 npm、不需要電腦。

---

## 事前準備

1. Cloudflare 帳號（免費方案就夠）
2. Discord 頻道的 Webhook 網址
   頻道設定 → 整合 → Webhook → 新增 → 複製網址
3. （選用）Bybit **唯讀** API Key，想在網頁上看餘額與持倉才需要

---

## 第一部分：Guardian 主程式

### 1. 建立 KV 儲存空間

Cloudflare 儀表板 → **Storage & Databases** → **KV** → **Create a namespace**

名稱隨意，例如 `crypto-radar-guardian`。

### 2. 建立 Worker

**Workers & Pages** → **Create** → **Start with Hello World** → **Deploy**

名稱建議 `crypto-radar-guardian`。

### 3. 貼上程式

進 Worker → **Edit code** → 把編輯器內容全部刪掉 →
貼上 `public/crypto-radar-guardian.worker.js` 的完整內容 → **Deploy**

### 4. 綁定 KV

**Settings** → **Bindings** → **Add** → **KV namespace**

| 欄位 | 值 |
| --- | --- |
| Variable name | `GUARDIAN_KV` |
| KV namespace | 剛才建的那個 |

變數名稱必須**完全一致**，打錯的話 Worker 會回一個明確的錯誤告訴你。

### 5. 設定機密

**Settings** → **Variables and Secrets** → **Add** → 型態選 **Secret**

| 名稱 | 必填 | 說明 |
| --- | --- | --- |
| `DISCORD_WEBHOOK` | 要通知就填 | Discord Webhook 網址 |
| `BYBIT_API_KEY` | 選填 | **唯讀** API Key |
| `BYBIT_API_SECRET` | 選填 | 對應的 Secret |
| `BYBIT_ENV` | 選填 | `live` / `demo` / `testnet`，預設 `live` |
| `ADMIN_TOKEN` | 選填 | 自己想一組字串，用來在網頁上看帳戶 |

**選 Secret 不要選 Text。** Secret 存進去之後儀表板也看不到內容。

如果你的 Key 是在 Bybit 模擬交易建的，`BYBIT_ENV` 要填 `demo`，
否則會得到 `retCode 10003`。

### 6. 設定排程

**Settings** → **Trigger Events** → **Cron Triggers** → **Add**

```
*/5 * * * *
```

### 7. 確認

打開 Worker 的網址（形如 `https://crypto-radar-guardian.你的帳號.workers.dev`）。

第一次會顯示「尚未執行過排程掃描」，等 5 分鐘讓 cron 跑一次就會有內容。
不想等的話，在 Worker 頁面找 **Trigger Event** 手動觸發一次。

檢查 `/api/status`，應該看到：

```json
{
  "version": "Crypto Radar Guardian 10.0",
  "ok": true,
  "cron": "每 5 分鐘",
  "moonshotProvider": "Bybit Pre-Breakout",
  "tradeMode": "read-only",
  "autoTrading": false
}
```

要看帳戶就在網址後面加 `?token=你設的ADMIN_TOKEN`。

---

## 第二部分：心跳守衛

刻意做成另一支 Worker。Guardian 整個掛掉時，守衛還活著才叫得出來。

### 1. 另一個 KV

再建一個 namespace，例如 `crypto-radar-watchdog`。

### 2. 另一支 Worker

同樣 **Create** → **Hello World** → 命名 `crypto-radar-watchdog` →
**Edit code** → 貼上 `public/crypto-radar-watchdog.worker.js` → **Deploy**

### 3. 綁定與機密

| 類型 | 名稱 | 值 |
| --- | --- | --- |
| KV binding | `WATCHDOG_KV` | 剛建的 namespace |
| Secret | `GUARDIAN_URL` | Guardian Worker 的網址 |
| Secret | `DISCORD_WEBHOOK` | 同一個 Discord Webhook |

### 4. 排程

```
4,14,24,34,44,54 * * * *
```

**刻意與 Guardian 錯開**，避免兩者同時執行時看到半完成的狀態。

### 5. 確認

打開守衛的網址，會回報它自己的狀態，包含多久沒執行過
（dead-man switch，讓你知道守衛本身是不是也死了）。

---

## 通知行為

**Guardian**

- 有標的通過全部十道進場條件 → 通知
- 同一標的一小時內不重複
- 持倉缺 TP 或 SL → 提醒

**守衛**

- 連續兩次偵測到 Guardian 異常才告警（單次漏跑不叫）
- 重送間隔 0 → 60 → 360 分鐘，長時間斷線不洗版
- 恢復時通知一次

---

## 免費方案的限制

| 項目 | 免費額度 | 這套用掉 |
| --- | --- | --- |
| 每日請求數 | 100,000 | cron 每天 288 次 |
| 每次執行的子請求 | 50 | 約 30 個 |
| KV 每日寫入 | 1,000 | 每次 cron 寫 3~4 筆，約 1,150 |

KV 寫入會**略微超過**免費額度。若遇到寫入失敗，把 cron 改成
`*/10 * * * *`（每 10 分鐘）就會降到約 580 筆，安全範圍內。

子請求數量刻意壓在 30 左右：掃描分兩段，先用 K 線與未平倉量跑完閘門，
只有通過的少數標的才再花一個請求去看盤口深度。

---

## 安全性

- 只呼叫 Bybit 公開行情與**唯讀**查詢端點
- 端點白名單寫死在程式裡，任何下單、改單、撤單、提領路徑都會被
  `assertReadOnlyEndpoint` 丟出例外
- **沒有任何下單程式路徑**，`autoTradeEligible` 恆為 `false`
- 機密只從 Cloudflare Secrets 讀，不寫進程式碼、不寫進 KV、
  不出現在任何回應或錯誤訊息
- 餘額與持倉不會出現在公開網頁，要看必須帶 `ADMIN_TOKEN`
- Token 比對使用定時比較，不會因為提早返回而洩漏資訊

這幾點都有測試把關，見 `tests/worker-build.test.mjs`。

---

## 要改邏輯

改 `app/` 底下的原始檔，然後：

```bash
npm run build
```

**不要手改 `public/` 底下的檔案**，它們是產生出來的。
改完把新的內容重新貼進 Cloudflare 編輯器即可。
