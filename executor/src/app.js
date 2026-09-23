import { logger } from './logger.js';
import { verifyRequest } from './hmac.js';
import {
  handleTrade, handleAddExitLeg, handleSetStop, handleCancelAll, handleClose,
  handlePosition, handleBalance, handleInstrument, handleHealth, handleEmergencyStop,
} from './routes.js';

const MAX_BODY_BYTES = 64 * 1024; // 交易指令的 payload 很小，64KB 綽綽有餘，順便擋掉異常大的請求

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('request body 太大'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 需要 HMAC 驗證的路由（所有會查帳戶資訊或下單／改單的端點）；/health 刻意
// 不需要驗證，給存活監控用，本身不會洩漏任何敏感資訊。
const AUTHENTICATED_ROUTES = new Map([
  ['POST /trade', (req, res, body) => handleTrade(req, res, body)],
  ['POST /add-exit-leg', (req, res, body) => handleAddExitLeg(req, res, body)],
  ['POST /set-stop', (req, res, body) => handleSetStop(req, res, body)],
  ['POST /cancel-all', (req, res, body) => handleCancelAll(req, res, body)],
  ['POST /close', (req, res, body) => handleClose(req, res, body)],
  ['POST /emergency-stop', (req, res, body) => handleEmergencyStop(req, res, body)],
]);

/** GET 系列的驗證端點沒有 body，簽章用空字串當 payload；驗證失敗一律回 401，不透露細節（避免幫攻擊者除錯簽章） */
async function checkAuth(req, res, rawBody) {
  const result = verifyRequest(req.headers['x-executor-timestamp'], req.headers['x-executor-signature'], rawBody);
  if (!result.ok) {
    logger.warn('請求驗證失敗', { path: req.url, reason: result.reason, ip: req.socket?.remoteAddress });
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: '未授權' }));
    return false;
  }
  return true;
}

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  if (key === 'GET /health') return handleHealth(req, res);
  if (key === 'GET /position') return handlePosition(req, res, Object.fromEntries(url.searchParams));
  if (key === 'GET /balance') {
    if (!(await checkAuth(req, res, ''))) return;
    return handleBalance(req, res);
  }
  if (key === 'GET /instrument') {
    if (!(await checkAuth(req, res, ''))) return;
    return handleInstrument(req, res, Object.fromEntries(url.searchParams));
  }

  const handler = AUTHENTICATED_ROUTES.get(key);
  if (handler) {
    const rawBody = await readBody(req).catch((e) => { res.writeHead(e.status || 400).end(e.message); return null; });
    if (rawBody === null) return;
    if (!(await checkAuth(req, res, rawBody))) return;
    let body;
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'body 不是合法的 JSON' }));
      return;
    }
    return handler(req, res, body);
  }

  res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
}

/** 給 node:http 的 createServer() 用，也給測試直接呼叫（不需要真的綁 port） */
export function createRequestHandler() {
  return (req, res) => {
    router(req, res).catch((e) => {
      logger.error('未預期的例外', { path: req.url, error: e.message, stack: e.stack });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message }));
    });
  };
}
