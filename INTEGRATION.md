# Crypto Radar Guardian Live — 修補模組

這個倉庫**不是**新網站，也不是原專案的替代品。
它是一組準備併入 `appgprj_6a903676eda8819180e2de4e99da1868` 的獨立模組與測試。

## 為什麼是這種形式

接手這次維護的工作階段拿不到原專案：

| 項目 | 狀態 |
| --- | --- |
| 工作目錄 | 只有空的 `README.md`，沒有 `app/`、`scripts/`、`tests/` |
| `.openai/hosting.json` | 不存在 |
| `git.chatgpt-team.site` | 連線被代理擋下（CONNECT tunnel failed 403） |
| `crypto-radar-guardian-live.emily73.chatgpt.site` | 同上，403 |
| ChatGPT Sites 工具（`get_site`、`package-site.sh`） | 此環境沒有 |
| Cloudflare OAuth | 此環境沒有授權管道 |

依照交接規格第一節「若無法取得此 Site 或 Git 倉庫……不要另建一個相似網站」，
因此沒有重建網站，只寫可以直接搬進原專案的純邏輯模組。

## 檔案對應

| 本倉庫檔案 | 併入原專案的位置 | 取代／補強的既有邏輯 |
| --- | --- | --- |
| `app/gate-kit.ts` | 新增 | 共用閘門原語 |
| `app/signal-score-display.ts` | 新增，供 `app/radar-dashboard.tsx` 使用 | 主幣訊號的分數顯示與 `entryReady` |
| `app/moonshot-entry-gates.ts` | 併入 `app/moonshot-decision.ts` 與 `scripts/build-guardian-worker-v10.mjs` | 快噴掃描的篩選與 Entry 判定 |
| `app/trade-journal.ts` | 新增，供 `app/cloud-auto-panel.tsx` 與 Guardian Worker 使用 | 目前沒有對應實作 |
| `app/meme-classifier.ts` | 併入 `app/position-sizing.ts` | 迷因幣清單與倉位計算 |
| `app/orderbook-depth.ts` | 新增，供 `app/bybit-client.ts` 呼叫 | 目前沒有對應實作 |
| `app/version-drift.ts` | 併入 `app/api/cloud/route.ts` 與 `app/guardian-discord-watchdog-source.ts` | 版本檢查與心跳告警 |

**重要**：`app/moonshot-entry-gates.ts` 的門檻若要改，必須同步改
`scripts/build-guardian-worker-v10.mjs`，再重新執行
`node scripts/build-guardian-worker-v10.mjs`。
不要只手改產生後的 `public/guardian-worker-v10.js`。

## 這些模組做了什麼

### 1. 把「94 分」拆成兩軌（`signal-score-display.ts`）

交接規格第五節那筆 PEPE 資料丟進去，得到：

```
方向分 94  →  顯示分 67（WATCH 級上限）
就緒度 3/8
阻擋原因：
  訊號等級 WATCH 級（需 正式 A 級）
  白名單 否（需 在自動交易白名單內）
  Entry 有效 否（需 Entry 價位有效）
  量能 0.773 倍（需 ≥ 1.05 倍）
  進場區 否（需 已進入支撐／壓力進場區）
```

原本的等級分數上限校正完整保留。新增的是就緒度與中文阻擋原因，
讓使用者在手機上一眼看到「為什麼不能進場」，而不是只看到一個數字。

`entryReady` 與 `autoTradeEligible` 只能由閘門結果推導，
`buildSignalView` 不接受外部傳入這兩個欄位，杜絕「高分直接放行」的路徑。

### 2. 快噴掃描的十道閘門（`moonshot-entry-gates.ts`）

- `autoTradeEligible` 以字面型別 `false` 鎖死，型別層就改不成 `true`。
- 已經噴出的八種情形逐一列為排除原因，並把 `stage` 標成 `EXCLUDED`。
- 未就緒時 `entryZone`、`stopLoss`、`takeProfit1/2` 一律是 `null`，不會外流半套 Entry。
- `provider` 固定 `Bybit Pre-Breakout`，`bybitUrl` 只產生 `https://www.bybit.com/trade/usdt/…`。
- 新增一道 **warning 等級**的資料新鮮度提示（15 分鐘），
  不改動既有 45 分鐘的硬門檻，只在卡片上提示資料偏舊。

### 3. 成交日誌（`trade-journal.ts`）

針對交接規格第五節「無法確定那筆 PEPE 虧損的成交價格與滑價」。
每筆自動交易保存下單當下的完整閘門快照，平倉後以
`/v5/position/closed-pnl` 與 `/v5/execution/list` 對帳，算出實際均價、
帶正負號的滑價、手續費、資金費、R 倍數與出場原因。

取不到的欄位一律填 `null` 並記入 `dataGaps`，**不會填入推測值**。
`assertNoSecrets` 在寫入前掃描敏感欄位名稱，金鑰與 Token 進不了日誌。

`protectionQty()` 讓 TP／SL 數量跟隨 Bybit 回查到的實際持倉，
回查不到時回傳 `null`，呼叫端應視為保護失敗並走安全平倉流程。

### 4. 迷因幣判定與倉位（`meme-classifier.ts`）

既有的七個代號保留為高信心清單，另加一層啟發式接住新上市的迷因幣：
面額前綴、上線未滿 180 天、成交額對未平倉值比值過高。
**判斷不出來一律當迷因幣處理**（fail-safe 偏保守）。

測試窮舉四種等級 × 0–100 分 × 迷因與非迷因，確認沒有任何組合能讓倉位超過 0.30%，
且迷因幣在任何分數下都不超過 0.15%。

另外提供相關性分組上限，讓日後調高 `maxPositions` 不會變成同一筆多倍槓桿的賭注。

### 5. 盤口深度（`orderbook-depth.ts`）

第一階段的 10 萬美元未平倉值門檻很低，而 0.6% 價差過濾擋不住深度問題。
本模組算出中價 ±0.3% 內的可成交金額，取較薄一側估出可承受倉位。
深度不明時一律回傳 `too-thin`，不放行。

### 6. 版本漂移與心跳守衛（`version-drift.ts`）

把交接規格第七節的落差變成可見狀態。用交接時的實際數值測試：

```
輸入：Crypto Radar Guardian 9.0、healthy、Demo、Bybit Pre-Breakout、cron 5 分鐘
輸出：versionState = drift
      showMoonshot = false        （沿用既有保護，不顯示 v9 舊結果）
      deploymentComplete = false  （網站發布完成不等於 Worker 已升級）
      橫幅：[critical] Guardian Worker 仍在 9.0，網站需要 10.0
            按鈕：更新快噴掃描與迷因幣風控
      告警：Worker 版本漂移：運行中 9.0，期望 10.0
```

Discord 守衛的改動：
- **遲滯**：連續兩次偵測不到才告警，單次 cron 漏跑不會誤報。
- **節流**：重送間隔 0 → 60 → 360 分鐘，長時間斷線不洗版。
- **版本漂移也告警**，不再只看心跳年齡（現況正是心跳正常但版本是舊的）。
- **dead-man switch**：`checkWatchdogAlive()` 讓守衛自己停擺時會被偵測到。

守衛的決策物件不含任何交易或風險欄位，有測試把關。

橫幅一律使用 `#081321` 主面板色加描邊與微光，沒有新增白色卡片。

## 驗證結果

在本環境實際跑過：

```
node --experimental-strip-types --test tests/*.test.mjs   →  82 passed, 0 failed
npx tsc --noEmit                                          →  0 errors（strict + noUncheckedIndexedAccess）
```

測試涵蓋：PEPE 迴歸、等級上限窮舉、閘門不變量（800 組隨機輸入）、
已噴完標的的 golden test、倉位上限窮舉、滑價正負號、
敏感欄位攔截、watchdog 遲滯與節流、版本漂移。

開發過程中測試抓到一個真實的浮點邊界 bug：`100 * 1.003` 在二進位下是
`100.29999…`，導致價格剛好落在深度帶緣的檔位被漏算。已在
`orderbook-depth.ts` 加上相對容差修正，並補上迴歸測試。

## 併入原專案後必須重跑

```
node --check public/guardian-worker-v10.js
npm run lint
node --test tests/*.test.mjs        # 原有 31 項 + 本批 82 項，不得刪任何一項
git diff --check
SITES_BUILD_TIMEOUT=6m npm run build
```

## 這批修改**沒有**做到的事

以下需要在有 Sites 與 Cloudflare 權限的環境完成，本工作階段做不到，
也**不應該**被當成已完成：

- [ ] 併入原專案並跑過原有的 31 項測試
- [ ] `SITES_BUILD_TIMEOUT=6m npm run build` 正式建置
- [ ] 推送到 `appgprj_…` 的 `main` 分支
- [ ] Sites 版本儲存與部署，確認 deployment status 為 succeeded
- [ ] Cloudflare OAuth 授權（按「更新快噴掃描與迷因幣風控」）
- [ ] Worker 實際升級到 10.0 並以 `/api/status` 驗證
- [ ] 確認 Guardian Cron 五分鐘、Discord watchdog 十分鐘、心跳年齡正常
- [ ] 確認交易模式仍是使用者選擇的模式，未自行切換成 Live

在上述每一項都實際驗證通過之前，不得回報「已全部完成」。
