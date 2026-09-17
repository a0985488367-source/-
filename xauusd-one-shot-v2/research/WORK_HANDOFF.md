# Work 開發交接 — ONE SHOT V2 修正版

請先讀 `修正版_未解決點處理報告.md`，它覆蓋並取代舊的「小資金翻身模式_研究報告.md」中任何衝突結論。

## 開發順序

1. 先執行/移植 `MT5_SymbolProbe.mq5`，取得目標券商 XAUUSD 的真實商品規格。
2. 只有在 `RiskSizing.mqh` 能算出不超過6%風險的合法 volume 時才允許下單；否則 signal 記錄為 `SKIP_MIN_VOLUME_RISK`。
3. EA 實作 frozen V2 Entry + BE1.5/TP5 + true calendar 48h timeout。
4. 所有訊號只使用已收盤高週期 K 棒；M15 訊號完成後下一根 M5 才進場。
5. 先跑 Demo / Strategy Tester，不連真實資金。
6. 用 `external_validation_runner.py` 對未見真實 Bid/Ask 歷史資料驗證；不得根據結果調 Entry 參數後再稱其為 holdout。
7. 建立完整日誌：signal time、entry、stop distance、risk money、raw volume、rounded volume、min volume、margin、skip reason、BE trigger、exit reason、net pnl、R。

## 不允許

- 不允許 Martingale。
- 不允許虧損加倉。
- 不允許為了讓60U可交易而把 volume 強制抬到0.01。
- 不允許把576根M5當48小時。
- 不允許把 Monte Carlo 命中率說成未來成功率。
- 不允許沿用舊報告「6%歷史單一路徑達10000U」；該結論已撤回。
