/**
 * 實際打一次三家交易所的衍生品 API，確認端點還活著、欄位沒被改掉。
 * 沙盒環境連不到交易所，所以這支要在 GitHub Actions 上跑。
 *
 *   node scripts/probe-derivatives.mjs --symbols=BTCUSDT,ETHUSDT
 */
import { DERIV_PROVIDERS, fetchDerivatives } from '../src/data/derivatives.js';
import { classifyFunding, oiChangePct, priceOiRegime, annualizeFunding } from '../src/smc/derivatives.js';

const arg = (n, d) => (process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).slice(n.length + 3);
const SYMBOLS = arg('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');

let chainFailed = 0;
const blocked = [];
for (const id of Object.keys(DERIV_PROVIDERS)) {
  process.stdout.write(`\n=== ${DERIV_PROVIDERS[id].label} ===\n`);
  for (const s of SYMBOLS) {
    try {
      const r = await DERIV_PROVIDERS[id].fetch(s);
      const f = classifyFunding(r.fundingRate);
      const oi = oiChangePct(r.oiSeries);
      const okRate = Number.isFinite(r.fundingRate);
      const okSeries = Array.isArray(r.oiSeries) && r.oiSeries.length >= 2;
      if (!okRate) blocked.push(`${id}/${s}`);
      console.log(
        `  ${s.padEnd(10)} 費率 ${okRate ? (r.fundingRate * 100).toFixed(4) + '%' : '❌ 取不到'}` +
        ` (年化 ${okRate ? annualizeFunding(r.fundingRate).toFixed(1) + '%' : '—'})` +
        ` · ${f.level}` +
        ` · OI ${r.openInterest ?? '—'}` +
        ` · 序列 ${okSeries ? r.oiSeries.length + ' 筆，變化 ' + oi.toFixed(2) + '%' : '⚠ 不足'}`,
      );
    } catch (e) {
      // 451/403 是交易所按 IP 所在地封鎖，不是我們的程式壞掉。
      // GitHub 的機器在美國，Binance 永續與 Bybit 都擋美國 IP。
      const geo = /HTTP (451|403)/.test(e.message);
      blocked.push(`${id}/${s}`);
      console.log(`  ${s.padEnd(10)} ${geo ? '🌏 該地區封鎖' : '❌'} ${e.message}`);
    }
  }
}

console.log('\n=== 備援串接（應該永遠拿得到）===');
for (const s of SYMBOLS) {
  try {
    const r = await fetchDerivatives(s);
    const reg = priceOiRegime({ priceChangePct: 1, oiChangePct: oiChangePct(r.oiSeries) ?? 0 });
    console.log(`  ${s.padEnd(10)} 來源 ${r.provider} · ${classifyFunding(r.fundingRate).zh} · ${reg.zh}`);
  } catch (e) {
    chainFailed++;
    console.log(`  ${s.padEnd(10)} ❌ 全部來源都失敗：${e.message}`);
  }
}

// 單一交易所被地區封鎖是預期內的（這正是要做備援的原因），
// 只有「備援串完還是拿不到資料」才算真的失敗。
if (blocked.length) console.log(`\nℹ️ 這台機器上有 ${blocked.length} 個來源不可用（多半是地區封鎖）：${blocked.join(', ')}`);
if (chainFailed) { console.log(`\n❌ 有 ${chainFailed} 個幣種連備援都拿不到資料`); process.exitCode = 1; }
else console.log('\n✅ 備援串接全部拿得到資料');
