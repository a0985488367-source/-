# Crypto Radar Guardian

在 Bybit USDT 線性永續合約中，找出「已壓縮、量能溫和放大、未平倉量增加、
且尚未突破前高」的早期候選。已經噴過的一律排除。

同一套掃描引擎，兩種跑法。

## iPhone 版（不需要電腦）

`public/crypto-radar-guardian.scriptable.js`

1. App Store 安裝免費的 **Scriptable**
2. 開 Scriptable，右上角 **+** 新增 Script
3. 把整份 `.js` 貼進去
4. 按右下角播放鍵

用 iOS 原生的網路請求，沒有瀏覽器的跨來源限制，所以**不需要伺服器、不需要電腦**。

## 瀏覽器版

`public/crypto-radar-guardian.html` — 單一檔案。

因為瀏覽器的同源政策，這個版本要從 https 或本機伺服器開啟才抓得到資料
（直接雙擊開檔案通常會被擋）：

```bash
npx serve public
# 或 python3 -m http.server 8000 -d public
```

也可以丟到任何靜態主機。

## 兩個版本都遵守的規則

- **資料真的來自 Bybit**：只打 `/v5/market/` 公開行情端點
- **不需要也不接受 API Key**：沒有任何私有端點或簽章邏輯
- **永遠不下單**：沒有下單路徑，`autoTradeEligible` 恆為 false
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
npm test          # 134 項測試
npx tsc --noEmit  # TypeScript 嚴格模式
npm run build
```

iPhone 版有一組測試在 Node 裡模擬 Scriptable 環境（`Request`、`WebView`、
`Alert`、`Script`），實際跑完整份腳本並檢查產出的畫面。

## 這不是什麼

- 不是原 Sites 專案的替代品，也沒有連到它
- 不連接任何交易帳戶，不持有任何金鑰
- 不對任何交易結果作出保證
