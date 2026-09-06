# Crypto Radar Guardian

在 Bybit USDT 線性永續合約中，找出「已壓縮、量能溫和放大、未平倉量增加、
且尚未突破前高」的早期候選。已經噴過的一律排除。

同一套掃描引擎，兩種跑法。

## iPhone 版（不需要電腦）

`public/crypto-radar-guardian.scriptable.js`

1. App Store 安裝免費的 **Scriptable**
2. 開 Scriptable，右上角 **+** 新增 Script，貼上整份 `.js`
3. 按播放鍵。在 App 裡執行會出現選單，可以進設定。

用 iOS 原生網路請求，沒有瀏覽器的跨來源限制，所以**不需要伺服器、不需要電腦**。

### 放到主畫面

1. 開「捷徑」App，新增捷徑
2. 加入動作 → 搜尋 Scriptable → 選 **Run Script** → 選這個 Script
3. 捷徑選單 →「加入主畫面」，可自訂名稱與圖示

從主畫面圖示啟動會直接開始掃描，不出現選單。

### 連接 Bybit（唯讀）

在 Scriptable 裡執行 → 選「連接 Bybit（唯讀）」，**先選環境**：

| 環境 | 私有端點 | 行情 |
| --- | --- | --- |
| 正式站 | `api.bybit.com` | `api.bybit.com` |
| 模擬交易 Demo | `api-demo.bybit.com` | `api.bybit.com` |
| 測試網 Testnet | `api-testnet.bybit.com` | `api-testnet.bybit.com` |

**API Key 綁環境。** 模擬交易與測試網各自發自己的 Key，拿去打正式站會得到
`retCode 10003 API key is invalid`。連接失敗時第一個要檢查的就是環境。
程式會把這個錯誤碼翻成中文並指出該檢查什麼。

請在 Bybit 建立**只讀權限**的 API Key。程式端另有三道限制：

- 端點白名單：只有 `wallet-balance`、`position/list`、`closed-pnl`、
  `execution/list`、`order/realtime` 這幾個查詢端點可以呼叫
- 禁止樣式：任何 create／amend／cancel／transfer／withdraw／set- 路徑
  會被 `assertReadOnlyEndpoint` 直接丟出例外
- 憑證只存在這支手機的 iOS Keychain，不進 Git、不進產生後的檔案、
  不出現在畫面或錯誤訊息（有測試驗證）

連上之後會顯示帳戶權益、持倉、今日已實現損益，
並標示每個持倉的 TP／SL 是否齊全。

### 連接 Discord

在 Discord 頻道設定建立 Webhook，執行程式 → 選「連接 Discord」貼上網址。

- 有標的通過全部十道進場條件時通知，同一標的一小時內不重複
- 持倉缺 TP 或 SL 時提醒
- 通知只是通知，不會觸發任何交易動作

## 瀏覽器版

`public/crypto-radar-guardian.html` — 單一檔案，只做公開行情掃描。

**刻意不支援帳戶連接與 Discord**：把 API 金鑰放進瀏覽器儲存空間並不安全，
而且瀏覽器打私有端點還有跨來源問題。這條界線有測試把關。

因為同源政策，這個版本要從 https 或本機伺服器開啟才抓得到資料：

```bash
npx serve public
```

## 兩個版本都遵守的規則

- **資料真的來自 Bybit**：公開行情走 `/v5/market/`
- **永遠不下單**：沒有下單路徑，`autoTradeEligible` 恆為 false
- **主幣與迷因幣分區**：主幣是固定觀察清單，其餘（含判斷不出來的）歸高風險區
- **分數不是勝率**：十道進場閘門全過才顯示 Entry，未過就列出中文阻擋原因
- **迷因幣不加碼**：固定 0.15% 防守倉，不因分數提高
- 手機優先，iPhone 安全區，深色賽博配色（主面板 `#081321`）

## 改邏輯的規矩

| 改什麼 | 改哪裡 |
| --- | --- |
| 掃描與閘門邏輯 | `app/scan-engine.js` |
| 卡片與清單畫面 | `app/render.js` |
| 樣式 | `app/theme.css` |
| 免責聲明 | `app/disclaimer.html` |
| 數值格式化 | `app/format.js` |
| Bybit 唯讀端點與簽章 | `app/bybit-private.js` |
| Discord 通知 | `app/discord.js` |

改完必須重跑產生器：

```bash
npm run build   # 同時產生瀏覽器版與 iPhone 版
```

**不要手改 `public/` 底下的檔案** —— 它們是產生出來的，下次重跑就被覆蓋。
這條規矩跟原專案的 `scripts/build-guardian-worker-v10.mjs` 一致，
而且有測試確認產生器輸出是決定性的。

## 原專案的修補模組

`app/*.ts` 是準備併入 ChatGPT Sites 專案
`appgprj_6a903676eda8819180e2de4e99da1868` 的純邏輯模組，
與上面的獨立版是兩回事。整合方式見 [INTEGRATION.md](./INTEGRATION.md)。

## 驗證

```bash
npm test          # 196 項測試
npx tsc --noEmit  # TypeScript 嚴格模式
npm run build
```

iPhone 版有一組測試在 Node 裡模擬 Scriptable 環境（`Request`、`WebView`、
`Alert`、`Script`），實際跑完整份腳本並檢查產出的畫面。

## 這不是什麼

- 不是原 Sites 專案的替代品，也沒有連到它
- 不連接任何交易帳戶，不持有任何金鑰
- 不對任何交易結果作出保證
