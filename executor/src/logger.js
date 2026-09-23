/**
 * 簡單的結構化 log：每行一個 JSON，方便之後用 journalctl | grep 或接
 * log 蒐集工具查。不用外部套件，避免 VPS 上還要多裝一層依賴。
 */
function line(level, msg, extra) {
  const entry = { ts: new Date().toISOString(), level, msg, ...(extra || {}) };
  const out = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

export const logger = {
  info: (msg, extra) => line('info', msg, extra),
  warn: (msg, extra) => line('warn', msg, extra),
  error: (msg, extra) => line('error', msg, extra),
};
