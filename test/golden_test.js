// 重构对拍：重构前（main 分支）代码生成的 fixtures/golden.json，和现在的代码逐值比较。
// 任何性能优化（增量计算、缓存）都不允许改变信号、回测结果、价位和通道参数。
// 运行：node test/golden_test.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCsv, hasCsv, counter } from './_csv.js';
import { Strategy } from '../js/strategy.js';
import { Levels } from '../js/levels.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const G = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'golden.json'), 'utf8'));
const T = counter();
if (!hasCsv()) { console.log('没有真实K线目录，跳过'); T.done(); }
const r6 = (x) => (x == null || !isFinite(x) ? x : +x.toPrecision(12));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const realNow = Date.now;
const data = {};
const get = (sym) => (data[sym] ??= { l: loadCsv(sym, '15m', 3), h: loadCsv(sym, '1h', 3), h4: loadCsv(sym, '4h', 12), d1: loadCsv(sym, '1d', 30) });

console.log('1. Strategy.run 信号与回测');
let tRun = 0, nRun = 0;
for (const g of G.strategy) {
  const { l, h, h4, d1 } = get(g.sym);
  const end = l.length - g.back, lk = l.slice(end - 1500, end), tEnd = lk[lk.length - 1].time;
  Date.now = () => (tEnd + 900 - 300) * 1000;
  const hk = h.filter((x) => x.time <= tEnd).slice(-500);
  const t0 = performance.now();
  const res = Strategy.run(lk, hk, 900, { h4k: h4.filter((x) => x.time <= tEnd), d1k: d1.filter((x) => x.time <= tEnd) });
  tRun += performance.now() - t0; nRun++;
  const sig = res.signals.map((s) => [s.time, s.side, s.trigger, s.score, r6(s.entry), r6(s.sl), r6(s.tp1), s.result, r6(s.r), r6(s.trailSl)]);
  T.ok(eq(sig, g.signals), `${g.sym}/${g.back} 信号不一致：\n    新 ${JSON.stringify(sig).slice(0, 300)}\n    旧 ${JSON.stringify(g.signals).slice(0, 300)}`);
  const bt = Object.fromEntries(Object.entries(res.bt).map(([k, v]) => [k, r6(v)]));
  T.ok(eq(bt, g.bt), `${g.sym}/${g.back} 回测统计不一致 ${JSON.stringify(bt)} vs ${JSON.stringify(g.bt)}`);
  const la = G.levelsAt.find((x) => x.sym === g.sym && x.back === g.back);
  for (const [i, want] of la.ats) {
    const got = res.levelsAt(i).map((L) => [r6(L.price), L.strength, L.touches, r6(L.lo), r6(L.hi), L.tags.join('/')]);
    T.ok(eq(got, want), `${g.sym}/${g.back} levelsAt(${i}) 不一致`);
  }
}
Date.now = realNow;
console.log(`  Strategy.run 平均 ${(tRun / nRun).toFixed(1)} ms / 次（1500 根 15m）`);

console.log('2. channelFits / regimeFits');
const k4 = { 14400: 'h4', 86400: 'd1', 3600: 'h' };
let tFit = 0;
for (const g of G.channelFits) {
  const k = get(g.sym)[k4[g.sec]];
  const t0 = performance.now();
  const fits = Levels.channelFits(k, g.n, g.sec);
  tFit += performance.now() - t0;
  T.ok(fits.length === g.len, `${g.sym} channelFits(${g.n}) 长度 ${fits.length} vs ${g.len}`);
  const s = fits.filter((_, i) => i % 23 === 0 || i === fits.length - 1).map((f) => [f.i, f.validFrom, r6(f.a), r6(f.b), r6(f.sigma), r6(f.r2), f.t0]);
  // 增量（滚动累加）和逐窗重算有浮点误差：参数允许 1e-9 相对误差
  let bad = s.length !== g.sample.length ? 'len' : null;
  for (let j = 0; !bad && j < s.length; j++) for (let c = 0; c < 7; c++) {
    const a = s[j][c], b = g.sample[j][c];
    if (Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(b))) { bad = `#${j} 第${c}列 ${a} vs ${b}`; break; }
  }
  T.ok(!bad, `${g.sym} channelFits(${g.n},${g.sec}) ${bad}`);
}
for (const g of G.regimeFits) {
  const k = get(g.sym)[k4[g.sec]];
  const t0 = performance.now();
  const rf = Levels.regimeFits(k, 90, g.sec, 0.35);
  tFit += performance.now() - t0;
  T.ok(rf.length === g.len, `${g.sym} regimeFits 长度`);
  const s = rf.filter((_, i) => i % 19 === 0 || i === rf.length - 1).map((r) => [r.i, r.validFrom, r6(r.er), r.trending, r6(r.hi), r6(r.lo), r.up]);
  let bad = null;
  for (let j = 0; !bad && j < s.length; j++) for (let c = 0; c < 7; c++) {
    const a = s[j][c], b = g.sample[j][c];
    if (typeof a === 'number' ? Math.abs(a - b) > 1e-9 * Math.max(1, Math.abs(b)) : a !== b) { bad = `#${j} 第${c}列 ${a} vs ${b}`; break; }
  }
  T.ok(!bad, `${g.sym} regimeFits(${g.sec}) ${bad}`);
}
console.log(`  channelFits+regimeFits 合计 ${tFit.toFixed(0)} ms（${G.channelFits.length + G.regimeFits.length} 组）`);
T.done();
