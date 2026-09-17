# XAUUSD ONE SHOT V2 — MT5 EA

把 `research/` 裡凍結的 V2 規則實作成可在 MetaTrader 5 執行的 EA。

> ⚠️ **這套策略尚未通過真實 Bid/Ask 的 external holdout 驗證。**
> 依 `research/修正版_未解決點處理報告.md` 的要求，在 forward demo 累積足夠新資料之前，
> 不得宣稱驗證完成，也不要接真實資金。先跑 Strategy Tester 與 Demo。

---

## 檔案

| 路徑 | 用途 |
|---|---|
| `mt5/OneShotV2_EA.mq5` | 主程式。凍結的 Entry + BE1.5/TP5 + 真 48 曆時小時逾時 |
| `mt5/RiskSizing.mqh` | 風險倉位計算。以 `OrderCalcProfit` 依券商真實規格算手數 |
| `mt5/MT5_SymbolProbe.mq5` | 商品規格探針。**開發第一步**，先跑它 |
| `research/` | 原始研究程式、回測結果、驗收報告。EA 的唯一口徑來源 |

先讀 `research/修正版_未解決點處理報告.md`——它覆蓋並取代
`research/小資金翻身模式_研究報告.md` 中任何衝突的結論。

---

## 凍結規則

### 進場（M15 收盤判定，下一根 M5 開盤進場）

| 條件 | 做多 | 做空 |
|---|---|---|
| H4 `(EMA50-EMA200)/ATR14` | `> 1.00` | `< -1.00` |
| H1 `(EMA20-EMA50)/ATR14` | `> 0.25` | `< -0.25` |
| M15 前 32 根區間位置 | `> 0.70` | `< 0.30` |
| M15 `(close-open)/ATR14` | `> 0.30` | `< -0.30` |
| M15 ATR / 前 50 根 ATR 均值 | `0.80 ~ 1.80` | 同左 |
| 時段（UTC） | `12:00 ~ 21:59` | 同左 |

一次只持有一個部位，不重疊；出場的那一根 M5 不重新進場。

### 出場

- 初始停損 `2 × M15 ATR`（= 1R），目標 `5R`
- M5 **收盤確認**浮盈 ≥ `+1.5R` 後，**下一根**才把停損移到進場價
- **真 48 個曆時小時**逾時（不是 576 根 M5），到期後第一個可取得的報價出場

### 倉位

- 一律用 `OrderCalcProfit` 依券商真實商品規格計算
- 取整後的實際風險若超過預算 → 不下單
- 最小手數超過風險預算 → 記錄 `SKIP_MIN_VOLUME_RISK`，**不下單**
- 風險預算永遠以「當下權益」計算，虧損後倉位自動縮小

### 不允許（來自 `research/WORK_HANDOFF.md`）

- ❌ Martingale ❌ 虧損加倉 ❌ 為了讓 60U 可交易而強制抬到 0.01 lot
- ❌ 把 576 根 M5 當 48 小時 ❌ 把 Monte Carlo 命中率說成未來成功率
- ❌ 沿用舊報告「6% 歷史單一路徑達 10000U」——該結論已撤回

---

## 使用順序

### 1. 先跑商品探針

把 `mt5/MT5_SymbolProbe.mq5` 放進 `MQL5/Scripts/`，編譯後在目標 XAUUSD 圖表上執行。

它會印出該券商的 `volumeMin` / `volumeStep` / `contractSize` / `tickValue` / `stopsLevel`，
並直接判定 60U 帳戶在 6% 風險下能不能下出合法手數：

```
RESULT=PASS_SIZE_GRANULARITY        → 可以繼續
RESULT=FAIL_RISK_GRANULARITY        → 最小手數就超過風險預算
RESULT=FAIL_MIN_LOT_RISK            → 同上
```

若是 FAIL，**不要改 EA 讓它硬下單**。修正報告已量化過：標準 100oz/lot、最低 0.01 lot 的
黃金商品，60U 帳戶在 6% 風險下可執行的歷史訊號比例是 **0.0%**。這時的選擇是換更細粒度的
商品（約 0.001 lot 等級）或提高本金，不是放寬風險。

### 2. Strategy Tester

把 `OneShotV2_EA.mq5` 與 `RiskSizing.mqh` 一起放進 `MQL5/Experts/OneShotV2/`，編譯。

- 商品：XAUUSD；週期：任意（EA 自行取 M5/M15/H1，與圖表週期無關）
- 建模：**Every tick based on real ticks**（BE 與逾時都靠 M5 收盤驅動，M1 OHLC 會失真）
- 先用預設輸入跑，再比對日誌與 `research/rank6_*_trades.csv` 的量級

### 3. Demo forward

確認 Strategy Tester 的行為正確後，掛 Demo 累積**新**資料。
不要根據 forward 結果回頭調 Entry 參數——那會讓 holdout 失效。

---

## 主要輸入參數

| 參數 | 預設 | 說明 |
|---|---|---|
| `InpRiskPct` | `6.0` | 單筆名義風險（% 權益） |
| `InpUseRatchet` | `false` | 里程碑鎖底模式。研究報告已列明其回撤中位數 60%+，預設關閉 |
| `InpServerUTCOffsetHrs` | `-99` | 伺服器與 UTC 時差。`-99` = 自動偵測（會跟隨夏令時） |
| `InpMaxMarginFraction` | `0.50` | 單筆保證金不得超過可用保證金的比例 |
| `InpLogRejects` | `false` | 連未成立的訊號也寫入日誌（除錯用，檔案會很大） |
| `InpH1BarsForH4` | `8000` | 聚合 H4 用的 H1 根數。EMA200 需要足夠暖機，不要調小 |

`InpH4MacroMin` 之類的進場參數雖然開放，但**除非重新做完整跨期驗證，否則不要動**。

### 里程碑鎖底（預設關閉）

啟用後 `1R = min(權益 × InpRiskPct%, (權益 − 底線) / 1.15)`，底線隨權益里程碑往上鎖：

`初始 20U` → 達 100U 鎖 60U → 達 300U 鎖 150U → 達 1000U 鎖 500U → 達 3000U 鎖 1500U → 達 10000U 停止模式

底線**不是保證**。跳空可以直接穿過停損。

---

## 日誌

寫在 `MQL5/Files/OneShotV2_log.csv`（Tester 則在 tester 的 Files 沙箱）。
事件類型：`ENTRY` / `BE` / `EXIT` / `SKIP`。

涵蓋交接文件第 7 點要求的全部欄位：signal time、entry、stop distance、risk money、
raw volume、rounded volume、min volume、margin、skip reason、BE trigger、exit reason、
net pnl、R，另外附上當根的 `h4_macro` / `h1_trend` / `pos32` / `body` / `atrrel` / `utc_hour`
方便逐筆核對訊號。

所有時間欄位都是 **UTC**，與研究程式一致。

---

## 移植時處理掉的口徑差異

這幾點是 MT5 與研究程式天然不一致、會實際改變訊號的地方：

1. **ATR 演算法。** 研究用 `pandas ewm(alpha=1/14, adjust=False)`，也就是 Wilder 平滑；
   MT5 內建 `iATR` 是 True Range 的**簡單平均**，兩者數值不同。EA 自行以 Wilder 遞迴計算。
2. **H4 的邊界錨點。** 研究對 UTC 序列做 `resample('4h')`，邊界固定在 UTC 00/04/08/12/16/20；
   MT5 的 H4 K 棒卻以**券商伺服器時間**午夜為錨點。券商是 UTC+2/+3 時整組邊界就位移，
   `h4_macro` 會變成另一條序列。EA 改為由 H1 自行重組出 UTC 錨點的 H4。
3. **高週期只取已收盤 K 棒。** 對應研究的 `h.index += rule` 後再 `ffill` 到 M15 收盤時點，
   EA 只使用「收盤時間 ≤ 決策時點」的 H1/H4，沒有前視。
4. **保本延遲一根。** 研究是「這一根收盤觸發 → 下一根才生效」，EA 在新的 M5 開盤時
   依據剛收盤那根的收盤價判斷並立即改單，時序等價。
5. **空單的浮盈基準。** 研究用 Ask 衡量空單的不利報價，EA 對空單加上當下點差再算 R。
6. **逾時用曆時小時。** `進場 M5 K 的時間 + 48 小時`，跨週末不會被 K 棒數矇混。

### 等價性驗證

`research/port_check.py` 用純標準函式庫把兩條路徑各重寫一次——研究程式的整段序列算法、
以及 EA 的視窗式算法——餵同一份 `research/data/XAUUSD_M5.csv.gz` 逐根比對：

```
M5=199879  M15=66634  H1=16670  H4=4508
H1→H4 聚合 == M5→H4 聚合 : 一致 (4508 根)
研究路徑訊號數 = 1690  (多 1494 / 空 196)
實際比對 = 4690 根（全部 1690 根訊號 + 3000 根隨機非訊號）
訊號不一致 = 0
特徵最大絕對誤差： h4_macro=6.150e-09  h1_trend=0  pos32=0  body=0  atrrel=0
```

`h4_macro` 的 6e-09 是 EMA200 在有限視窗內暖機造成的浮點殘差，其餘特徵完全相同。
執行：`python3 research/port_check.py`（只需標準函式庫，約數分鐘）。

這驗證的是**演算法移植正確**，不是策略會賺錢。1690 是原始訊號根數；回測因為「單倉、
不重疊」而只成交其中 322 筆。

### 交易管理驗證

`research/ea_sim.py` 再往上一層：用 EA 的**事件迴圈**結構（每根新 M5 →
`ManagePosition()` → `TryEntry()`）重跑整套策略，跟研究回測**逐筆對帳**：

```
區段        研究   EA   逐筆相同    研究sumR    EA sumR
2024         87   87        87    41.8553    41.8553
2025        139  139       139    53.2427    53.2427
2026H1       67   67        67     3.4563     3.4563
FINAL90      29   29        29     6.8521     6.8521
合計        322  322       322
```

進場 K、出場 K、方向、淨 R 全部相同（誤差 < 1e-9）。這涵蓋保本時序、
真 48 曆時小時逾時、單倉不重疊、出場當根不重進。

執行：`python3 research/ea_sim.py`，加 `--strict-entry-bar` 可比較嚴格進場模式
（本資料集兩者結果相同）。

### 研究數字重現

`research/` 下的腳本原本路徑寫死在 `/mnt/data/...`，已全部改為相對路徑，
在 `research/` 目錄下可直接執行（需 `pip install numpy pandas numba`）。

`calendar_hold_fix.py` 重跑後與 `修正版_未解決點處理報告.md` 的
「修正後 BE1.5/TP5（真 48 曆時小時）」表格完全吻合：

| 區段 | 筆數 | 平均 R | PF |
|---|---:|---:|---:|
| 2024 | 87 | +0.4811 | 1.842 |
| 2025 | 139 | +0.3830 | 1.713 |
| 2026H1 | 67 | +0.0516 | 1.074 |
| FINAL90 | 29 | +0.2363 | 1.431 |
| FINAL90 成本×2 | 29 | +0.2155 | 1.384 |

---

### 驗證過程中抓到並修掉的問題

| 問題 | 影響 |
|---|---|
| `BuildH4FromH1` 容量估成 `n1/4+2` | 週末與收盤造成的不完整區塊讓實際區塊數超過 `n1/4`（實測 8000 根 H1 → **2163** 個區塊 vs 上限 2002），溢位後會截掉**最新**的 161 個區塊，`h4_macro` 取到約一個月前的值。已改為 `n1`。 |
| 缺口後追過期訊號 | 資料缺口／週末／終端重啟後的第一根 M5 可能已離訊號很遠，研究回測不會接這種單。已加 `SKIP_STALE_SIGNAL` 守衛。 |
| 進場那一根的停損 | 送單時 SL 已掛上，券商在**進場當根**就可能觸發。這點研究回測是對的，`ea_sim.py` 一開始建模錯誤，已修正後才對上。 |

## 已知限制

- **未來資料無法用更多回測取代。** 只有 forward demo 能提供新證據。
- **external true Bid/Ask holdout 尚未跑完**（`research/external_validation_runner.py` 需要外網下載
  Dukascopy bid/ask M1）。在它通過前，策略狀態是「候選」，不是「已驗證」。
- **券商規格決定可行性。** 同一套規則在不同券商的 XAUUSD 上，可執行訊號比例可能差很多。
- **跳空。** 除非券商提供 guaranteed stop，否則任何一般 MT5 停損都可能被跳空穿越。
- EA 依賴 tick 觸發。新的 M5 K 若長時間沒有報價，逾時出場會順延到下一個報價——
  這與研究「到期後第一個可取得的報價出場」的口徑一致。
