# Bybit Executor

獨立的下單執行服務，解決 Cloudflare Worker 直接呼叫 Bybit API 被地理封鎖的問題（詳細背景見專案根目錄 `README.md`「為什麼需要 Executor」那一段）。

## 架構

```
Cloudflare Worker（掃描訊號、判斷策略、算好倉位大小、Discord 通知）
      │  HTTPS + HMAC-SHA256 簽章
      ▼
Bybit Executor（這個資料夾）—— 部署在固定 IP、非美國地區的 VPS
      │  簽章過的 Bybit API 請求
      ▼
Bybit Demo Trading API
```

**分工原則**：策略判斷（進場時機、風險計算、槓桿、分批出場階梯怎麼分）全部留在 Cloudflare Worker，跟原本一樣沿用 `src/smc/manage.js` 那套驗證過的規則；Executor 只負責「照著執行」——收到 Worker 已經算好的完整下單指令，簽章／逾時／重放攻擊防護／冪等性都在這一層處理，Bybit API Key 也只存在這裡。**Executor 不做任何策略判斷**，這樣兩邊的邏輯不會分裂成兩份要各自維護、容易不同步的版本。

## API

除了 `GET /health`，所有端點都需要 HMAC 驗證（見下方「驗證方式」）。

| 方法 | 路徑 | 用途 |
|---|---|---|
| GET | `/health` | 存活檢查（不需要驗證）：連線狀態、是否觸發緊急停止 |
| GET | `/balance` | 查可用餘額 |
| GET | `/instrument?symbol=X` | 查合約規格（qtyStep／最小下單量／tickSize／槓桿上限） |
| GET | `/position?symbol=X`（可省略） | 查目前實際持倉 |
| POST | `/trade` | 開新倉位：市價進場 + 停損 + 分批出場階梯，一次送出 |
| POST | `/add-exit-leg` | 補掛單一段分批出場限價單（給 ladder 修補用） |
| POST | `/set-stop` | 搬動已開倉部位的停損（保本鏢／追蹤停損用） |
| POST | `/cancel-all` | 取消某個 symbol 還沒成交的所有委託 |
| POST | `/close` | 用市價把某個 symbol 現在的持倉全部平掉（人工介入／緊急情況用） |
| POST | `/emergency-stop` | 手動觸發／解除緊急停止：`{ "tripped": true, "reason": "..." }` |

`POST /trade` 的請求格式：

```json
{
  "signal_id": "BTCUSDT-long-1h-1758598980000",
  "symbol": "BTCUSDT",
  "side": "Buy",
  "qty": "50",
  "leverage": "10",
  "stop_loss": "80376.1",
  "ladder": [
    { "name": "TP0", "price": "82000", "qty": "17" },
    { "name": "TP1", "price": "85000", "qty": "33" }
  ]
}
```

`signal_id` 必須每筆訊號唯一——同一個 `signal_id` 重複送出，Executor 會直接回傳當初的結果，不會重複下單（見「冪等性」）。

## 驗證方式（HMAC + 防重放）

每個需要驗證的請求要帶兩個標頭：

```
X-Executor-Timestamp: 1758598980000        （毫秒級時間戳）
X-Executor-Signature: <hex>                （見下方簽章算法）
```

簽章 = `HMAC_SHA256(EXECUTOR_HMAC_SECRET, timestamp字串 + 原始 request body 字串)`。
GET 請求沒有 body，簽章時 body 部分用空字串。

Executor 收到請求會檢查：
1. 簽章對不對（用 `crypto.timingSafeEqual` 比對，避免時間差側錄攻擊）
2. `timestamp` 跟現在時間差有沒有超過 `REQUEST_MAX_AGE_SEC`（預設 30 秒）——防止請求被錄下來重播

兩邊主機時間要對齊（NTP 正常運作的話不用擔心）。

## 冪等性

- Bybit 訂單層級：市價進場單會帶 `orderLinkId = signal_id`，Bybit 自己就會拒絕重複的 `orderLinkId`，這是第一層防呆。
- Executor 層級：處理完一個 `signal_id`（不管成功或失敗）都會記進 `data/processed-signals.json`，同一個 `signal_id` 再送過來直接回傳原本的結果，完全不會再打 Bybit——這是第二層、更直接的防呆，即使 Worker 那邊因為某種原因重送了同一個請求也不會造成重複下單。
- 市價進場單如果請求本身逾時、不確定 Bybit 有沒有收到，不會直接判定失敗：會用 `orderLinkId` 查一次訂單狀態，確認清楚才下結論，避免「其實已經成交，只是回應沒送達」被誤判成失敗。

## 安全機制

- **LIVE_TRADING 開關只能透過環境變數控制**，任何 HTTP 請求的內容都不可能覆蓋這個值——程式碼裡完全沒有讀取 request body 裡類似 `live` 這種欄位的邏輯，不存在「因為某個請求參數就自動切成真錢交易」的攻擊面。預設 `false`（Demo Trading）。
- **緊急停止**：啟動時、以及之後每 `HEALTH_CHECK_INTERVAL_MIN` 分鐘都會自動檢查一次跟 Bybit 的連線；查不到（尤其是 403，代表 connectivity / region 出問題）就自動觸發緊急停止、通知 Discord，之後所有下單／改單請求都會被直接拒絕，直到下一次健康檢查恢復正常才自動解除。也可以用 `POST /emergency-stop` 手動觸發或解除。
- **不是通用 open proxy**：只接受上面列出的這幾個固定端點，沒有任何「把任意路徑轉發給 Bybit」的邏輯。
- 5xx／429／403（Bybit 對某些地區觸發限流保護時不是每次都回 429）自動重試一次；403 如果重試後還是失敗，健康檢查會判定成 connectivity / region failure。
- 全程結構化 log（一行一個 JSON），方便用 `journalctl -u smc-executor` 查。

## 部署

兩種方式擇一：

### 方案一：Fly.io（推薦，不用自己管伺服器）

不用學 Linux、不用自己裝軟體、內建 HTTPS（不用另外裝 Caddy）。在**自己的電腦**上（不是 VPS）安裝 `flyctl` 之後：

```bash
# 1. 安裝 flyctl（Mac/Linux）
curl -L https://fly.io/install.sh | sh

# 2. 登入（會開瀏覽器，用你剛註冊的帳號登入）
fly auth login

# 3. 進到 executor 資料夾，啟動精靈——會問你要不要取一個 App 名稱、
#    選哪個地區（務必選非美國的，例如 Tokyo (nrt)、Singapore (sin)、
#    Hong Kong (hkg)），其他問題（要不要接資料庫等）都選否／預設值就好
cd executor
fly launch --no-deploy

# 4. 建一個小的持久化磁碟（1GB 就綽綽有餘），儲存「已經處理過的訊號」
#    這份紀錄，region 要跟上一步選的地區一樣
fly volumes create executor_data --size 1 --region <你選的地區代碼>

# 5. 打開 fly.toml，確認／加上這兩段（fly launch 產生的檔案可能沒有）：
#      [mounts]
#        source = "executor_data"
#        destination = "/app/data"
#    以及 [http_service] 底下的 internal_port 要是 8787

# 6. 設定金鑰（EXECUTOR_HMAC_SECRET 用 openssl rand -hex 32 產生一組）
fly secrets set \
  BYBIT_API_KEY=你的Bybit_Demo_API_Key \
  BYBIT_API_SECRET=你的Bybit_Demo_API_Secret \
  EXECUTOR_HMAC_SECRET=你產生的隨機字串 \
  DISCORD_WEBHOOK_URL=你的Discord_webhook網址

# 7. 部署
fly deploy

# 8. 查看網址（大概是 https://<你的App名稱>.fly.dev）
fly status
```

部署完打開 `https://<你的App名稱>.fly.dev/health` 應該會看到 `{"ok":true,...}`。這個網址就是要填進 Cloudflare Worker 的 `EXECUTOR_URL`。

### 方案二：一般 VPS

見 `deploy/setup-vps.sh`（在 VPS 上跑這支腳本）跟 `deploy/executor.service`（systemd 服務定義）。這支服務本身只有 HTTP，**正式使用前一定要在前面加一層 HTTPS**（例如用 [Caddy](https://caddyserver.com/) 當反向代理，設定幾行就能自動申請憑證）——HMAC 簽章能防止偽造請求，但沒有 TLS 的話，請求跟回應內容（包含帳戶餘額、持倉這些）還是用明文在網路上傳輸，容易被中間人竊聽。

## 本機測試

```bash
cd executor
cp .env.example .env   # 填好金鑰跟 HMAC secret，用 Bybit Demo Trading 的金鑰
npm start
```

啟動時會先做一次健康檢查，log 會印出「健康檢查通過」或觸發緊急停止的原因。

## 測試套件

```bash
npm test
```
