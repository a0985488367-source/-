# 專案記憶（給之後每一次對話的 Claude 看）

CLAUDE.md 是「規則」，這份是「來龍去脈」：使用者是誰、系統長什麼樣、做過哪些決定、為什麼、
踩過哪些坑。開新對話先讀這份，就不用再從頭問一次。**有新的決定或結論就更新這份。**
（這個倉庫是公開的：這裡不寫帳戶餘額、盈虧金額、任何金鑰。）

## 使用者

- 只看得懂繁體中文。喜歡先用選項式問題確認需求，再動手。
- 手機跟電腦都會用；通知看 Discord，看盤用 TradingView（`BYBIT:xxxUSDT.P`，Bybit 永續）。
- 目標：用自動交易把帳戶滾上去，不想讓賺錢速度變慢。風險偏好偏高（曾選每筆 5%），
  經歷過真錢一晚連虧，情緒會受影響；給建議時要把「回撤多深、連虧幾筆」講清楚。
- 自己也會手動下單。平倉紀錄裡沒有 `signal_id` 的就是手動單。
- 想報考**加密貨幣自營商（Prop Firm）挑戰**，規則照片之後會傳來（見文末待辦）。

## 系統架構

| 元件 | 位置 | 作用 |
|---|---|---|
| App 網站 | GitHub Pages（`index.html`、`src/`） | SMC 圖表分析、全市場掃描頁、回測分頁 |
| 排程工作 | GitHub Actions（只在 `main` 跑） | `signals.yml` 模擬盤＋推播、`weekly-report.yml`、`research.yml` 回測、`close-alt-positions.yml` 平倉工具 |
| 即時守門員 | Cloudflare Worker `smc-signals`（`worker/`） | 每 2 分鐘：掃描 SMC 計畫、價格到了推 Discord、（開啟時）自動下單、追蹤停損 |
| 下單服務 | Fly.io Bybit Executor（`executor/`） | Worker 用 HMAC 簽名呼叫，真錢模式 `LIVE_TRADING=true` |
| TV 指標 | `tradingview/smc-plan.pine` | `src/smc/` 逐行改寫，複製頁 `…/tradingview/`，`tests/tradingview-parity.test.mjs` 比對 |

- 資料源：系統、App、TV 都用 **Bybit USDT 永續**（`src/data/providers.js` 的 `BYBIT_CATEGORY = 'linear'`）。
  Cloudflare 打 Binance 常被擋，所以 Worker 用 Bybit 優先。
- SMC 分析只看**已收盤**的 K 棒：抓 500 根去掉盤中那根。高週期偏向只看一個高週期
  （`tfSuite().htf`：15m／30m→4h、1h／2h／4h→1d、6h／1d→1w），抓 260 根。
  App 圖表、Worker、TV 指標三邊都是同一套，改一邊要改三邊。
- Worker 掃描：候選池一批裝得下時（現在只盯 10 檔），每個週期「有新 K 棒收盤才重掃」
  （收盤後約 1～3 分鐘），不是固定間隔輪流。
- 金鑰只放 GitHub Secrets 跟 Fly secrets，**永遠不要貼在對話或程式裡**。

## 現在的狀態（2026-09-30）

- **所有自動下單都關閉**：`SMC_AUTO_TRADE_ENABLED=false`，6 個順勢策略都是 `*_ENABLED=false`。
- SMC 只盯市值前 10 大（`SMC_SYMBOLS`：BTC、ETH、XRP、BNB、SOL、DOGE、ADA、TRX、LINK、AVAX），
  週期 15m、30m、1h、2h、4h、6h、1d，**只推播到 Discord**，分數門檻 `MIN_SCORE=65`，
  價格離進場 0.08%（`NEAR_PCT`）內算「到了」。
- Discord 通知標題有週期，並附「去 App 對照」欄位（週期、資料源、高週期、分析時間、用到哪根收盤 K 棒、TradingView 連結）。
- 之後要跑什麼策略，**等使用者決定**。

## 研究結論（回測都在 GitHub Actions `research.yml` 跑）

- **唯一有穩定優勢的**：6 個 4h／6h 順勢策略組合——突破（breakout）、EMA 交叉、MACD 零軸、
  量能突破（vol）、超級趨勢（supertrend，4h）、黃金交叉（golden cross）。前後半段、兩組幣都成立。
  Worker 裡已經寫好（`src/strategies/`，`STRATEGY_CFG`），開關在 `wrangler.toml`。
- **SMC 沒有穩定優勢**：`smc-mix` 把 POI 種類、FVG＋斐波那契、成交量、匯流項目等單項和兩兩組合都測過，
  沒有一組前後半段都成立。
- **回測要用 5 分鐘精準版**（`sub=5m`）：原週期算法會把限價單成交那根 K 棒成交前的高低點算成獲利，
  每筆高估約 0.08～0.09R。2026-09-27 以前的結論都要重驗。
- **模擬盤（`data/signals.json`）帳面 +20.5R 的真相**（2026-09-29 拆解）：
  - 146 筆、只有 12 天，幾乎全靠 SOL、ETH 做多，剛好碰上漲勢（做多 +21R、做空 −0.6R）。
  - 6 大主流幣 +21R；全市場掃描挑的小幣 −0.7R。
  - 沒扣手續費，扣掉約少 8R。
  - 最大回撤約 19.6R，最長連虧 19 筆。
  - 真單虧損是因為做的是小幣、市價追單、付手續費，不是沒照程式下單。

## 決策時間線（2026-09-28～29）

1. 真錢 SMC 自動下單（先 3%、後來 5%）→ 一晚連虧。
2. 回測所有策略 → 只有 6 個順勢策略有優勢 → 一度上線（每筆 3%、最多 5 張）。
3. 使用者要求「一切重來」只跑 SMC（5%）→ 又虧 → 關掉所有自動下單、平掉系統開的單。
4. 改成只盯市值前 10 大、15m～1d、只推 Discord。
5. 修 Discord 通知跟 App 對不上（原因：盤中 K 棒、高週期算法、K 棒根數、資料源、掃描太久才更新）。
6. 做 TradingView 指標，並改版成電腦上比較好看（部位工具畫法、字放大、預設少畫）。

## 踩過的坑

- 真錢帳戶是逐倉，Bybit `totalAvailableBalance` 會是 0，算部位要退回 `totalWalletBalance`。
- 7 個週期輪流、每 10 分鐘掃一個 → 每個週期約 70 分鐘才更新（曾經誤說成 15 分鐘）。已改成收盤觸發。
- 這個環境連不到交易所，回測只能在 Actions 跑；Actions 的 log 下載常被代理擋，
  結果改從輸出的 `SUMMARY_JSON` 解析。
- Bash `sleep` 可能被擋 → 等東西用 `send_later` 排定時檢查。
- OKX K 線一次最多 300 根，要分頁；OKX 的 6H／12H 要加 `utc` 才會從 UTC 0 點切。
- Pine 不能在這裡編譯：邏輯靠 `tradingview/pine2js.py` 轉 JS 跟原版比對，語法錯誤只能請使用者貼到 TV 截圖回報。

## 待辦

- **Prop Firm（加密貨幣自營商）挑戰工具**：使用者要四樣——規則守門員（每日虧損／最大回撤快碰到就推 Discord 警告）、
  下單前倉位計算機、交易訊號、模擬考試回測。**等使用者傳規則照片**，確認下面這些再做：
  帳戶大小、獲利目標、每日虧損上限（依餘額還是淨值、幾點重置）、最大回撤（固定還是追蹤）、
  最少交易天數、每筆最大風險、是否強制停損、持倉過夜／週末／新聞限制、槓桿上限、一致性規則、
  在哪個交易所考（能不能拿到帳戶資料的 API）。
