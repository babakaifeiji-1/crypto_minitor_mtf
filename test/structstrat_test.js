'use strict';
// 验证 js/structstrat.js：合成数据上的手算结果 + 真实数据截断不变（无未来函数）+ 成本口径
// 运行：node test/structstrat_test.js
const fs = require('fs');
const path = require('path');
const SS = require('../js/structstrat.js');

const CSV = process.env.QUANT_CSV || path.join(__dirname, '..', '..', 'quant', 'data', 'csv');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };

function synth(points, per, sec, wick = 1.2, t0 = 1_700_000_000) {
  const k = []; let t = t0;
  for (let j = 1; j < points.length; j++) for (let m = 0; m < per; m++) {
    const a = points[j - 1], b = points[j], o = a + (b - a) * (m / per), c = a + (b - a) * ((m + 1) / per);
    k.push({ time: t, open: o, close: c, high: Math.max(o, c) + wick, low: Math.min(o, c) - wick, volume: 1 }); t += sec;
  }
  return k;
}
function load(sym, tf) {
  if (!fs.existsSync(CSV)) return [];
  const out = [];
  for (const f of fs.readdirSync(CSV).filter((x) => x.startsWith(`${sym}-${tf}-`) && x.endsWith('.csv')).sort())
    for (const l of fs.readFileSync(path.join(CSV, f), 'utf8').split('\n')) {
      const c = l.split(','); if (!(+c[0] > 0) || !(+c[2] > 0)) continue;
      let t = +c[0]; if (t > 1e14) t = Math.floor(t / 1000);
      out.push({ time: Math.floor(t / 1000), open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] });
    }
  out.sort((a, b) => a.time - b.time);
  return out.filter((x, i) => i === 0 || x.time > out[i - 1].time);
}

console.log('1. 合成数据');
{
  // 大周期一路上涨（HH+HL），小周期回调后向上突破 → 应该只出多单。影线给宽一点，止损距离才在 0.6~5 ATR 内
  const pts = [100, 112, 106, 120, 113, 128, 120, 136, 128, 145, 136, 155];
  const k = synth(pts, 20, 3600), hk = synth(pts, 5, 14400);
  const tr = SS.run(k, hk, 3600, 14400);
  ok(tr.length > 0, '上升趋势里应有交易');
  ok(tr.every((t) => t.side === 1), '大周期向上时只做多');
  ok(tr.every((t) => t.sl < t.entry && t.risk > 0), '多单止损在入场价下方');
  ok(tr.every((t) => t.fillI >= t.sigI && t.exitI >= t.fillI), '时间顺序：信号 ≤ 成交 ≤ 出场');
  // 下降
  const dn = pts.map((x) => 300 - x);
  const tr2 = SS.run(synth(dn, 20, 3600), synth(dn, 5, 14400), 3600, 14400);
  ok(tr2.length > 0 && tr2.every((t) => t.side === -1), '大周期向下时只做空');
  // 固定止盈：每笔 r 只能是 tpR、-1 附近（跳空除外）或时间止损
  const tr3 = SS.run(k, hk, 3600, 14400, { exit: 'fixed', tpR: 2 });
  ok(tr3.filter((t) => t.exitType === 'tp').every((t) => Math.abs(t.r - 2) < 1e-9), '止盈笔 r = tpR');
  ok(tr3.filter((t) => t.exitType === 'stop').every((t) => t.r <= -1 + 1e-9), '止损笔 r ≤ -1');
  // 成本：同一笔，全挂单比全吃单便宜；R 越小成本越高
  const t = { entry: 100, risk: 1, side: 1, barsHeld: 0, maker: false, legs: [[1, false]] };
  const c = { feeTaker: 0.04, feeMaker: 0.02, slipBps: 2, fundingAnnual: 0 };
  ok(Math.abs(SS.cost(t, c, 3600).costR - 0.12) < 1e-9, `吃单两腿成本 = 2×(0.04%+0.02%)×100/1 = 0.12R，实际 ${SS.cost(t, c, 3600).costR}`);
  ok(Math.abs(SS.cost({ ...t, maker: true, legs: [[1, true]] }, c, 3600).costR - 0.04) < 1e-9, '挂单两腿 = 0.04R');
}

console.log('2. 真实数据：截断不变');
let real = 0;
for (const [sym, l, h, s, hs] of [['BTCUSDT', '1h', '4h', 3600, 14400], ['SOLUSDT', '15m', '1h', 900, 3600], ['ETHUSDT', '4h', '1d', 14400, 86400]]) {
  const k = load(sym, l), hk = load(sym, h);
  if (k.length < 2000) continue;
  real++;
  for (const g of [{}, { trigger: 'choch', entry: 'retest', exit: 'fixed', tpR: 2 }]) {
    const full = SS.run(k, hk, s, hs, g);
    for (const frac of [0.3, 0.55, 0.8, 0.95]) {
      const cut = Math.floor(k.length * frac), tcut = k[cut - 1].time;
      const part = SS.run(k.slice(0, cut), hk.filter((x) => x.time + hs <= tcut + s), s, hs, g);
      const key = (a) => a.filter((t) => t.exitI < cut - 1 && !t.open && t.exitType !== 'time').map((t) => `${t.time}:${t.r.toFixed(6)}`).join();
      ok(key(full) === key(part), `${sym} ${l} ${JSON.stringify(g)} 截断 ${frac}：已平仓交易应完全一致`);
    }
    const last = SS.run(k, hk, s, hs, g);
    ok(last.filter((t) => t.open).length <= 1, `${sym} ${l} 同时最多 1 笔持仓`);
  }
}
if (!real) console.log('  （没找到 quant/data/csv，跳过）');

console.log('\n' + '='.repeat(60));
console.log(fail ? `失败 ${fail} 项 / 通过 ${pass} 项` : `全部通过 (${pass} 项断言)`);
process.exit(fail ? 1 : 0);
