# 部署到 Cloudflare

跑完之後你會有：

- 一個**網址**，手機隨時打開就看得到最新掃描
- **每 5 分鐘自動掃描**，手機關機也照跑
- 有標的通過全部進場條件就**發 Discord**
- 一支**獨立的心跳守衛**，Guardian 掛掉時通知你

---

## 最省事的做法：用部署工具（推薦）

`public/crypto-radar-deploy.scriptable.js`

一支 Scriptable 腳本，用 Cloudflare API 直接建 KV、上傳 Worker、
設排程、開網址。**完全不碰儀表板的程式編輯器**，也不用複製 Worker 程式碼
（兩支 Worker 都已經內嵌在裡面）。

1. Scriptable 新增一個 Script，貼上這份檔案
2. 執行 → **① 設定 Cloudflare Token**

   Token 在 Cloudflare 儀表板 → 頭像 → **My Profile** → **API Tokens**
   → **Create Token** → **Create Custom Token**，權限加這兩項：

   | 類型 | 項目 | 權限 |
   | --- | --- | --- |
   | Account | Workers Scripts | Edit |
   | Account | Workers KV Storage | Edit |

3. → **② 部署 Guardian**
4. 想要監控的話 → **③ 部署心跳守衛**

Bybit 憑證與 Discord Webhook 會自動從掃描器那支腳本共用的 Keychain 讀取，
不用重打。管理 Token 沒設過會自動產一組 32 字元隨機字串。

**一件要先知道的事**：這支腳本的 Cloudflare API 呼叫**沒有在開發環境實測過**，
因為那個環境連不到 api.cloudflare.com。請求構造是照 Cloudflare 的 API 文件寫的，
也有測試驗證構造與流程，但實際能不能通要以你執行的結果為準。
任何一步失敗都會明確告訴你卡在哪一步、Cloudflare 原話怎麼說。

如果這條路不通，下面還有三條備案。

---

## 先說清楚：手機部署不保證順利

Cloudflare 儀表板的程式編輯器用的是 Monaco，它在手機瀏覽器上本來就
不穩。實際回報過的狀況是「按 Deploy 沒反應，也沒有錯誤訊息」。

**部署只是一次性的設定。** 裝好之後，看網頁、收 Discord 通知都在手機
上，不需要再碰 Cloudflare。所以如果手機卡住，借台電腦花十分鐘裝完
是最省事的做法，不用硬撐。

## 備案：三條手動路線

| 路線 | 要不要電腦 | 可靠度 |
| --- | --- | --- |
| **A. 貼壓縮版** | 手機可試 | 看瀏覽器狀況 |
| **B. 接 GitHub** | 手機可試 | 較高，不碰編輯器 |
| **C. wrangler 指令** | 要電腦 | 最高 |

**路線 A** 用 `public/crypto-radar-guardian.worker.min.js`。
未壓縮版 2296 行，壓縮版 362 行且每行不超過 500 字元，
對編輯器友善很多。兩者行為完全相同，有測試逐欄比對過。

**路線 B** 建 Worker 時選 **Connect to Git**（或 Import a repository），
接上這個倉庫。不會用到程式編輯器，所以比路線 A 可靠。
根目錄有 `wrangler.toml`，但裡面的 KV namespace ID 是佔位字串，
**要先建好 KV 再把真正的 ID 填進去 commit**，否則部署會失敗。
守衛另外接一次，部署指令設成
`npx wrangler deploy -c wrangler.watchdog.toml`。

**路線 C** 見本文最後一節。最省事，如果手邊有電腦就直接用這條。

下面的步驟以路線 A 為主，路線 B 可以跳過「貼上程式」那步。

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
貼上 **`public/crypto-radar-guardian.worker.min.js`** 的完整內容 → **Deploy**

壓縮版只有 278 行，手機上比較好操作。想看得懂內容的話用未壓縮的
`crypto-radar-guardian.worker.js`（2296 行），兩者行為相同。

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

## 免費方案的額度

實測每一輪排程的用量（下面的數字是跑出來的，不是估的）：

| 項目 | 免費額度 | 這套實際用掉 |
| --- | --- | --- |
| 每日請求數 | 100,000 | cron 每天 288 次 |
| 每次執行的子請求 | 50 | 21 到 27 個 |
| KV 每日寫入 | 1,000 | 每輪 2 次，一天 576 次 |

都在額度內，每 5 分鐘的排程可以放心跑。

兩個刻意的設計讓它塞得進免費方案：

**子請求分兩段。** 先用 K 線與未平倉量把十道閘門跑完，只有通過的少數
標的才再花一個請求去看盤口深度。不用為了省請求而砍掉深度資訊。

**帳戶資料不落地。** 餘額與持倉不寫進 KV，帶對 Token 的人開頁面時才
即時去 Bybit 查一次。這樣省下每天約 288 次 KV 寫入，
而且帳戶資料完全不會有靜態副本。

通知狀態也只在真的變動時才寫回，沒事不會白寫一次。

## 安全性

- 只呼叫 Bybit 公開行情與**唯讀**查詢端點
- 端點白名單寫死在程式裡，任何下單、改單、撤單、提領路徑都會被
  `assertReadOnlyEndpoint` 丟出例外
- **沒有任何下單程式路徑**，`autoTradeEligible` 恆為 `false`
- 機密只從 Cloudflare Secrets 讀，不寫進程式碼、不寫進 KV、
  不出現在任何回應或錯誤訊息
- 餘額與持倉**完全不寫進 KV**，沒有靜態副本
- 要看帳戶必須帶 `ADMIN_TOKEN`，帶對了才即時查一次
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


---

## 路線 C：用 wrangler 指令部署

需要電腦與 Node。

```bash
npm install -g wrangler
wrangler login

# Guardian（用根目錄的 wrangler.toml）
wrangler kv namespace create GUARDIAN_KV   # 把回傳的 id 填進 wrangler.toml
wrangler secret put DISCORD_WEBHOOK
wrangler secret put BYBIT_API_KEY
wrangler secret put BYBIT_API_SECRET
wrangler secret put ADMIN_TOKEN
wrangler deploy

# 守衛
wrangler kv namespace create WATCHDOG_KV   # id 填進 wrangler.watchdog.toml
wrangler secret put GUARDIAN_URL    -c wrangler.watchdog.toml
wrangler secret put DISCORD_WEBHOOK -c wrangler.watchdog.toml
wrangler deploy -c wrangler.watchdog.toml
```

機密用 `wrangler secret put` 設定，不要寫進 toml 檔。

---

## 部署卡住的話

**按 Deploy 完全沒反應，也沒有錯誤訊息**

這是手機上最常遇到的。Cloudflare 的程式編輯器是 Monaco，
在手機瀏覽器上處理大檔案很吃力，貼上的內容可能沒被編輯器正確接收，
Deploy 就等於按了個空的。

依序試：

1. 改貼壓縮版（362 行），檔案小很多
2. 貼完先在編輯器裡隨便打一個空格再刪掉，逼它註冊內容變更
3. 換成桌機模式或用別的瀏覽器
4. 改走路線 B 接 GitHub，完全不碰編輯器
5. 以上都不行就借台電腦走路線 C。這是一次性的，裝完就不用再碰

**編輯器貼不進去或整個當掉** → 同上，改用壓縮版或路線 B。

**找不到 Cron Triggers** → 在 Worker 的 **Settings** 分頁，
不是在 KV 或 Variables 那一區。免費方案有這個功能。

**Worker 網址開起來是空的** → cron 還沒跑過。等 5 分鐘，
或在 Worker 頁面手動觸發一次。
