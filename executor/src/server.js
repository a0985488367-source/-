import { createServer } from 'node:http';
import { config } from './config.js';
import { logger } from './logger.js';
import { alertDiscord } from './discord.js';
import { runHealthCheck, startHealthCheckLoop } from './healthcheck.js';
import { createRequestHandler } from './app.js';

async function main() {
  logger.info('啟動前先做一次健康檢查……');
  const health = await runHealthCheck();
  if (!health.healthy) {
    logger.error('啟動時健康檢查沒過，服務仍會啟動（緊急停止已生效），等連線恢復正常會自動解除', { reason: health.reason });
  } else {
    logger.info('健康檢查通過，Bybit 連線正常', { ip: health.ip });
  }
  startHealthCheckLoop();

  const server = createServer(createRequestHandler());

  server.listen(config.port, () => {
    logger.info(`Bybit Executor 啟動完成，監聽 :${config.port}`, { liveTrading: config.liveTrading });
  });

  process.on('unhandledRejection', (e) => {
    logger.error('unhandledRejection', { error: e?.message || String(e) });
  });
  process.on('SIGTERM', () => { logger.info('收到 SIGTERM，關閉中'); server.close(() => process.exit(0)); });
  process.on('SIGINT', () => { logger.info('收到 SIGINT，關閉中'); server.close(() => process.exit(0)); });
}

main().catch((e) => {
  logger.error('啟動失敗', { error: e.message, stack: e.stack });
  alertDiscord(`🚨 **Executor 啟動失敗**：${e.message}`).finally(() => process.exit(1));
});
