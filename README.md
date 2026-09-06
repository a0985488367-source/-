# Crypto Radar Guardian

兩個東西住在這個倉庫裡。

## 1. 獨立版掃描網頁（可直接用）

`public/crypto-radar-guardian.html` — 單一檔案，開了就能跑。

- **真的抓 Bybit**：`/v5/market/` 公開行情端點，不需要也不接受 API Key
- **永遠不下單**：沒有任何私有端點、簽章邏輯或下單路徑，有測試把關
- **手機優先**：iPhone 安全區、切回前景自動重抓、無橫向捲動
- **深色賽博配色**：主面板 `#081321`

打開方式（擇一）：

```bash
# 本機伺服器（建議，避免瀏覽器擋跨來源請求）
npx serve public
# 或
python3 -m http.server 8000 -d public
```

然後在 iPhone Safari 開 `http://<你電腦的IP>:8000/crypto-radar-guardian.html`。
也可以把這個檔案丟到任何靜態主機。

### 改邏輯的規矩

掃描邏輯在 `app/scan-engine.js`。改完必須重跑產生器：

```bash
node scripts/build-standalone-app.mjs
```

**不要手改 `public/crypto-radar-guardian.html`** — 它是產生出來的，
下次重跑產生器就會被覆蓋。這條規矩跟原專案的
`scripts/build-guardian-worker-v10.mjs` 一致。

## 2. 原專案的修補模組

`app/*.ts` — 準備併入 ChatGPT Sites 專案
`appgprj_6a903676eda8819180e2de4e99da1868` 的純邏輯模組。
整合方式與尚未完成的事項見 [INTEGRATION.md](./INTEGRATION.md)。

## 驗證

```bash
npm test          # 123 項測試
npx tsc --noEmit  # TypeScript 嚴格模式
node scripts/build-standalone-app.mjs
```

## 這不是什麼

- 不是原 Sites 專案的替代品，也沒有連到它
- 不連接任何交易帳戶，不持有任何金鑰
- 不對任何交易結果作出保證
