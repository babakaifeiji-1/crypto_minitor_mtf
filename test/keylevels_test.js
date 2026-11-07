// 验证 Structure.keyLevels / keyTrendlines（精简画线）：规则正确 + 真实数据上画线条数确实变少
// 运行：node test/keylevels_test.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import S from '../js/structure.js';

const CSV = process.env.QUANT_CSV || path.join(__dirname, '..', '..', 'quant', 'data', 'csv');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

function load(sym, tf, months) {
  if (!fs.existsSync(CSV)) return [];
  const files = fs.readdirSync(CSV).filter((f) => f.startsWith(`${sym}-${tf}-`) && f.endsWith('.csv')).sort().slice(-months);
  const out = [];
  for (const f of files) for (const line of fs.readFileSync(path.join(CSV, f), 'utf8').trim().split('\n')) {
    const c = line.split(',');
    if (!(+c[0] > 0) || !(+c[2] > 0)) continue;
    out.push({ time: Math.floor(+c[0] / 1000), open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] });
  }
  out.sort((a, b) => a.time - b.time);
  return out.filter((x, i) => i === 0 || x.time > out[i - 1].time);
}
function weekly(d1) {
  const out = [];
  for (const x of d1) {
    const day = Math.floor(x.time / 86400), wk = (Math.floor((day + 3) / 7) * 7 - 3) * 86400;
    const w = out[out.length - 1];
    if (w && w.time === wk) { w.high = Math.max(w.high, x.high); w.low = Math.min(w.low, x.low); w.close = x.close; }
    else out.push({ ...x, time: wk });
  }
  return out;
}

// 构造一个最小的 analyze() 结果，只填 keyLevels 用到的字段
const fake = (close, atr, zones, tf = '15m') => ({ close, atrNow: atr, tf, zones: { all: zones } });
const Z = (price, touches, flip = false, from = 0) => ({ price, touches, flip, from, lo: price, hi: price });

console.log('1. 规则');
{
  // 每侧只留 perSide 条；第 1 条是最近的够格位，第 2 条是分数最高的
  const own = fake(100, 1, [Z(101, 1), Z(102, 3), Z(104, 2), Z(106, 5), Z(99, 3), Z(97, 2), Z(95, 4)]);
  const r = S.keyLevels(own, [], [], { perSide: 2, minScore: 3, maxDist: 20 });
  ok(r.above.length === 2 && r.below.length === 2, `每侧 2 条，实际 ${r.above.length}/${r.below.length}`);
  ok(r.above[0].price === 102, `上方第 1 条 = 最近的够格位 102（101 只碰 1 次不够格），实际 ${r.above[0]?.price}`);
  ok(r.above[1].price === 106, `上方第 2 条 = 分数最高的 106，实际 ${r.above[1]?.price}`);
  ok(r.below.map((x) => x.price).join() === '99,95', `下方 = 99（最近）+ 95（最强），实际 ${r.below.map((x) => x.price)}`);
}
{
  // 本周期和大周期重叠 → 合成一条，来源标签两个都有，分数相加，算强位
  const own = fake(100, 1, [Z(103, 2)]);
  const h1 = { zones: { all: [Z(103.3, 1)] } };
  const r = S.keyLevels(own, [{ tf: '1h', S: h1 }], [], { perSide: 2, minScore: 3, maxDist: 20 });
  ok(r.above.length === 1, `重叠应合成 1 条，实际 ${r.above.length}`);
  ok(r.above[0].tfs.join() === '15m,1h' && r.above[0].strong, `共振位来源 15m+1h 且为强位：${JSON.stringify(r.above[0])}`);
  ok(r.above[0].score === 2 + 1 + 1, `分数 = 15m×2(2) + 1h×1(1+1) = 4，实际 ${r.above[0].score}`);
}
{
  // 远处的位不画；昨高低参与；ownW=0 时本周期区不参与（3m）
  const own = fake(100, 1, [Z(101.5, 4), Z(130, 9)]);
  const r = S.keyLevels(own, [], [{ price: 102.8, score: 3, tag: '昨高' }], { perSide: 2, minScore: 3, maxDist: 10, ownW: 0 });
  ok(r.above.length === 1 && r.above[0].tfs[0] === '昨高', `ownW=0 只剩昨高，实际 ${JSON.stringify(r.above)}`);
  const r2 = S.keyLevels(own, [], [], { perSide: 2, minScore: 3, maxDist: 10 });
  ok(r2.above.every((x) => x.price < 110), '超出 maxDist 的 130 不画');
}
{
  // 一个够格的都没有：至少保留最近那一个
  const r = S.keyLevels(fake(100, 1, [Z(101, 1), Z(103, 1)]), [], [], { perSide: 2, minScore: 3, maxDist: 10 });
  ok(r.above.length === 1 && r.above[0].price === 101, `兜底给最近的 101，实际 ${r.above.map((x) => x.price)}`);
}
{
  // 链式合并：间距 0.4 ATR 的一串点，簇跨度不能超过 1.2 ATR
  const zs = Array.from({ length: 12 }, (_, i) => Z(101 + i * 0.4, 2));
  const r = S.keyLevels(fake(100, 1, zs), [], [], { perSide: 9, minScore: 1, maxDist: 20 });
  ok(r.all.every((x) => x.hi - x.lo <= 1.2 + 1e-9), `簇跨度 ≤ 1.2 ATR：${r.all.map((x) => (x.hi - x.lo).toFixed(1))}`);
}
{
  // 趋势线：只要强线；fallback 时没有强线给 1 条候选
  const L = (side, touches, p) => ({ side, touches, strong: touches >= 3, t0: 0, p0: p, slope: 0, a: { time: 0 }, b: { time: 1 } });
  const St = { close: 100, tl: { up: L('up', 2, 98), down: L('down', 3, 110) } };
  ok(S.keyTrendlines(St, { max: 2 }).map((x) => x.side).join() === 'down', '只留强线（down 3 触）');
  const St2 = { close: 100, tl: { up: L('up', 2, 98), down: L('down', 2, 110) } };
  ok(S.keyTrendlines(St2, { max: 2 }).length === 0, '没有强线、不 fallback → 不画');
  ok(S.keyTrendlines(St2, { max: 2, fallback: true }).length === 1, 'fallback → 1 条候选');
}

console.log('2. 真实数据：每张图的画线条数（旧 = 默认图层 v10，新 = 精简）');
// 和 app.js 的 CLEAN / HTF_OF 保持一致
const HTF_OF = { '15m': ['1h', '4h'], '1h': ['4h', '1d'], '4h': ['1d', '1w'], '1d': ['1w'] };
const CLEAN = {
  '15m': { perSide: 2, minScore: 3, prevDay: true, range: 0.5, tl: 1, bars: 160 },
  '1h': { perSide: 2, minScore: 3, prevDay: true, range: 0.6, tl: 1, bars: 240 },
  '4h': { perSide: 2, minScore: 3, prevWeek: true, range: 0.6, tl: 2, fb: true, bars: 240 },
  '1d': { perSide: 3, minScore: 3, range: 0.7, tl: 2, fb: true, bars: 150 },
};
const SEC = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 7 * 86400 };
const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT', 'AVAXUSDT'];
const rows = {};
let any = false;
for (const sym of syms) {
  const raw = { '15m': load(sym, '15m', 2), '1h': load(sym, '1h', 4), '4h': load(sym, '4h', 12), '1d': load(sym, '1d', 45) };
  if (!raw['15m'].length || !raw['1d'].length) continue;
  any = true;
  raw['1w'] = weekly(raw['1d']);
  // 在最后 10 天里取 6 个时刻采样
  const end = raw['15m'][raw['15m'].length - 1].time;
  for (let s = 0; s < 6; s++) {
    const now = end - s * 40 * 3600;
    const cut = (tf) => { const a = raw[tf].filter((x) => x.time + SEC[tf] <= now); return a.slice(-1500); };
    const St = {};
    for (const tf of Object.keys(SEC)) { const k = cut(tf); St[tf] = k.length >= 30 ? S.analyze(k, SEC[tf]) : null; if (St[tf]) St[tf].tf = tf; }
    for (const tf of Object.keys(CLEAN)) {
      const A = St[tf];
      if (!A) continue;
      // 旧：本周期 above+below+inside，每级大周期每侧 1 个（不重叠才画），趋势线 up/down/broken，中枢最近 2 个
      const zn = A.zones;
      let old = zn.above.length + zn.below.length + (zn.inside ? 1 : 0);
      for (const h of HTF_OF[tf]) if (St[h]) old += (St[h].zones.above.length ? 1 : 0) + (St[h].zones.below.length ? 1 : 0);
      old += [A.tl.up, A.tl.down, A.tl.upBroken, A.tl.downBroken].filter(Boolean).length;
      old += Math.min(2, A.zs.length);
      // 新
      const P = CLEAN[tf], k = cut(tf).slice(-P.bars);
      const rng = Math.max(...k.map((x) => x.high)) - Math.min(...k.map((x) => x.low));
      const extra = [];
      if (P.prevDay) { const b = cut('1d').slice(-1)[0]; if (b) extra.push({ price: b.high, score: 3, tag: '昨高' }, { price: b.low, score: 3, tag: '昨低' }); }
      if (P.prevWeek) { const b = cut('1w').slice(-1)[0]; if (b) extra.push({ price: b.high, score: 3, tag: '上周高' }, { price: b.low, score: 3, tag: '上周低' }); }
      const KL = S.keyLevels(A, HTF_OF[tf].map((h) => ({ tf: h, S: St[h] })), extra, { perSide: P.perSide, minScore: P.minScore, maxDist: Math.max(3 * A.atrNow, P.range * rng) });
      const tls = S.keyTrendlines(A, { max: P.tl, fallback: P.fb, nowTime: k[k.length - 1].time });
      const nw = KL.above.length + KL.below.length + tls.length + (A.activeZs ? 1 : 0);
      ok(KL.above.length <= P.perSide && KL.below.length <= P.perSide, `${sym} ${tf} 每侧 ≤ ${P.perSide}`);
      ok(KL.above.every((x) => x.price > A.close) && KL.below.every((x) => x.price <= A.close), `${sym} ${tf} 压力在上、支撑在下`);
      const sorted = [...KL.above, ...KL.below].map((x) => x.price).sort((a, b) => a - b);
      ok(sorted.every((p, i) => i === 0 || p - sorted[i - 1] > 0.5 * A.atrNow - 1e-9), `${sym} ${tf} 选出的线之间 > 0.5 ATR（不会两条贴在一起）`);
      (rows[tf] ??= { old: 0, nw: 0, n: 0, strong: 0, multi: 0, lv: 0 });
      const R = rows[tf]; R.old += old; R.nw += nw; R.n++;
      for (const x of [...KL.above, ...KL.below]) { R.lv++; if (x.strong) R.strong++; if (x.tfs.length >= 2) R.multi++; }
    }
  }
}
if (any) {
  console.log('  周期   旧·平均条数  新·平均条数   新·价位里强位占比  多周期共振占比');
  for (const [tf, R] of Object.entries(rows)) {
    console.log(`  ${tf.padEnd(5)}  ${(R.old / R.n).toFixed(1).padStart(8)}  ${(R.nw / R.n).toFixed(1).padStart(10)}  ${(100 * R.strong / R.lv).toFixed(0).padStart(14)}%  ${(100 * R.multi / R.lv).toFixed(0).padStart(12)}%`);
    ok(R.nw < R.old, `${tf} 精简后条数应少于旧版`);
  }
} else console.log('  （没找到真实K线目录，跳过）');

console.log('\n' + '='.repeat(70));
console.log(fail ? `失败 ${fail} 项 / 通过 ${pass} 项` : `全部通过 (${pass} 项断言)`);
process.exit(fail ? 1 : 0);
