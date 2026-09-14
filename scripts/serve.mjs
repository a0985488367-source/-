/**
 * 零依賴靜態伺服器：node scripts/serve.mjs [port]
 * 本專案沒有建置步驟（純 ES Modules），直接開伺服器即可使用。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const port = Number(process.argv[2] || process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let path = join(root, normalize(url).replace(/^(\.\.[/\\])+/, ''));
    if (!path.startsWith(root)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
    const s = await stat(path).catch(() => null);
    if (!s || s.isDirectory()) path = join(root, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(e.code === 'EACCES' ? 403 : 404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}).listen(port, () => {
  console.log(`\n  SMC Crypto Terminal\n  → http://localhost:${port}\n`);
});
