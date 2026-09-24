# 給 Claude 的工作規則

- **改完直接合併**：程式改好、測試（`npm test`）通過、推上功能分支後，自己開 PR 並合併進 `main`，不用再問使用者。
  GitHub 的排程工作流程（訊號掃描、每週報告）只在 `main` 上跑，沒合併就不會生效。
- 合併後如果改到 `worker/`，再手動觸發 `deploy-worker.yml`（ref 用 `main`）讓 Worker 生效。
- 策略／評分規則的改動要先用 `scripts/research/` 的回測（GitHub Actions `research.yml`）驗證，
  前後半段資料都成立才上線；這個環境連不到交易所，回測只能在 Actions 上跑。
