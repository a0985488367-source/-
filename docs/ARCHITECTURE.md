# 架構說明

## 資料流

```
交易所 REST/WS ─┐
                ├─ data/feed.js ──► candles[] ──► smc/engine.js ──► analysis
離線 Demo 產生器 ┘   （備援/快取/串流）              （純函式管線）        │
                                                                        ├─► chart/chart.js + chart/layers.js（Canvas 疊圖）
                                                                        ├─► ui/panels.js（側欄分析卡片）
                                                                        ├─► ui/alerts.js（警報比對）
                                                                        └─► smc/backtest.js（逐步重算驗證）
```

## 分層職責

| 層 | 位置 | 規則 |
|---|---|---|
| 核心工具 | `src/core` | 純函式，無 DOM、無網路 |
| 資料 | `src/data` | 唯一碰網路的地方；統一輸出 `{time,open,high,low,close,volume}` |
| 分析 | `src/smc` | **純函式**，可在 Node 測試；不得引用 `window` / `document` |
| 繪圖 | `src/chart` | 只讀 analysis，不做分析 |
| 介面 | `src/ui` | 產生 HTML 字串或操作 DOM；不做分析 |
| 編排 | `src/app.js` | 狀態、事件、載入、渲染的唯一入口 |

這個分層讓「回放模式」變得很單純：把 `candles` 切片後重新丟進 `analyze()` 即可，
不需要任何額外的狀態回溯機制，也天然保證不會有未來函數。

## 引擎輸出（analysis）主要欄位

```js
{
  candles, price, atrValue,
  swings, microSwings,
  structure: { internal, swing },       // 各含 events / trend / protectedHigh / protectedLow
  sweeps, gaps, orderBlocks, pools,
  liq: { above, below }, liqBias, inducement,
  range, pd, ote, fib,
  indicators: { ema20, ema50, ema200, rsi, atr, rvol, vwap, upper1, lower1, volumeProfile },
  bias: { score, label, factors[] },
  pois, stacks,
  keyLevels, sessions, currentSession,
  setup,                                 // 交易計畫，或 { none: true, reason } 說明為何沒有計畫
  settings
}
```

在瀏覽器主控台可用 `window.__SMC__.analysis` 直接檢查上述結構。

## 效能考量

- 圖表以 `requestAnimationFrame` 合批重繪，並在畫布上做視窗裁切
- 疊圖層限制同時繪製的區塊數量（FVG 26 個、OB 20 個），避免圖面雜訊與掉幀
- 即時串流以 800ms 節流重算，拖曳／縮放只重繪不重算
- 回測與掃描分批執行並讓出主執行緒（`setTimeout(0)`），UI 不會卡住
- 歷史 K 線有 20 秒記憶體快取，切換週期／幣種不會重複打 API

## 新增一個分析模組的步驟

1. 在 `src/smc/` 新增純函式模組，輸入 `candles` 與設定，輸出可序列化的物件
2. 在 `engine.js` 的 `analyze()` 中呼叫並掛到回傳物件上
3. 需要畫在圖上 → 在 `chart/layers.js` 新增 `drawXxx(env)`，並在 `chart.js` 的 `render()` 依圖層開關呼叫
4. 需要顯示在側欄 → 在 `ui/panels.js` 新增 `renderXxx()`
5. 在 `src/core/store.js` 的 `DEFAULT_STATE.layers` 加上開關，並在 `app.js` 的 `LAYER_DEFS` 註冊
6. 在 `tests/smc.test.mjs` 補上單元測試
