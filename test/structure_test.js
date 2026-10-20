'use strict';
// 验证 js/structure.js：合成数据上的已知答案 + 真实K线上的因果性和数量控制
// 运行：node test/structure_test.js
const fs = require('fs');
const path = require('path');
const S = require('../js/structure.js');

// 真实K线目录：默认是仓库旁边的 ../quant/data/csv，可用环境变量 QUANT_CSV 覆盖
const CSV = process.env.QUANT_CSV || path.join(__dirname, '..', '..', 'quant', 'data', 'csv');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };

function load(sym, tf) {
  if (!fs.existsSync(CSV)) return [];
  const files = fs.readdirSync(CSV).filter((f) => f.startsWith(`${sym}-${tf}-`)).sort().slice(tf === '1d' ? -40 : -6);
  const out = [];
  for (const f of files) for (const line of fs.readFileSync(path.join(CSV, f), 'utf8').trim().split('\n')) {
    const c = line.split(',');
    if (!(+c[0] > 0) || !(+c[2] > 0)) continue; // 跳过表头和空行
    out.push({ time: Math.floor(+c[0] / 1000), open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] });
  }
  out.sort((a, b) => a.time - b.time);
  // 部分 1d 文件之间有重叠月份，按时间去重
  return out.filter((x, i) => i === 0 || x.time > out[i - 1].time);
}

// 由转折点生成K线：在每两个转折点之间线性插值，加一点固定噪声（可复现）
function synth(points, barsPerLeg, barSec = 900, noise = 0.15) {
  const k = [];
  let t = 1_700_000_000, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let j = 1; j < points.length; j++) {
    const a = points[j - 1], b = points[j];
    for (let m = 0; m < barsPerLeg; m++) {
      const o = a + (b - a) * (m / barsPerLeg), c = a + (b - a) * ((m + 1) / barsPerLeg);
      const nz = Math.abs(rnd()) * noise;
      k.push({ time: t, open: o, close: c, high: Math.max(o, c) + nz, low: Math.min(o, c) - nz, volume: 1 });
      t += barSec;
    }
  }
  return k;
}

// ─── 1. 合成：ZigZag 找回已知转折点 ───────────────────────────────────────────
console.log('1. 合成数据');
{
  // 低点 104 / 112 / 120 等间距共线 → 上升趋势线 3 次触碰；0-1-2-3-4-5 = 100,110,104,120,112,128
  const P = [100, 110, 104, 120, 112, 128, 120, 130];
  const k = synth(P, 12);
  const r = S.analyze(k, 900);
  const got = r.swings.map((s) => Math.round(s.price));
  // 第一个点（起点 100）是否被认作 L 取决于起步规则，这里只要求中间的转折点都找到
  for (const p of [110, 104, 120, 112, 128, 120]) ok(got.some((g) => Math.abs(g - p) <= 1), `ZigZag 应找到 ${p}，实际 ${got}`);
  ok(r.swings.every((s, i) => i === 0 || s.type !== r.swings[i - 1].type), '摆动点高低交替');
  ok(r.swings.every((s) => s.ci >= s.i), '确认K线不早于极值K线');
  ok(r.bias === 1, `HH+HL 应判为上升结构，实际 ${r.biasTxt}`);
  ok(r.tl.up && r.tl.up.touches >= 3, `上升趋势线应 ≥3 次触碰，实际 ${r.tl.up?.touches}`);
  ok(r.events.some((e) => e.kind === 'BOS' && e.dir === 1), '应有向上 BOS');
  // 波浪：0-1-2-3-4-5 = 100,110,104,118,111,125
  const w = S.analyze(synth(P.slice(0, 6), 12), 900).wave;
  ok(w && w.kind === 'impulse' && w.dir === 1, `应识别出上升推动浪，实际 ${w?.kind}/${w?.nW}`);
}
{
  // 下降后转升：CHoCH
  const P = [130, 120, 125, 112, 118, 105, 115, 108, 124];
  const r = S.analyze(synth(P, 12), 900);
  ok(r.events.some((e) => e.kind === 'CHoCH' && e.dir === 1), '下降结构里向上突破前高应为 CHoCH');
  ok(r.tl.downBroken || !r.tl.down, '下降趋势线在最后一段拉升后应已破');
}
{
  // 震荡：中枢
  const P = [100, 110, 101, 109, 102, 110, 101, 109, 102, 110, 105];
  const r = S.analyze(synth(P, 10), 900);
  ok(r.zs.length >= 1, '来回震荡应识别出中枢');
  const z = r.zs[r.zs.length - 1];
  ok(z && z.zg <= 110.5 && z.zd >= 100.5 && z.n >= 5, `中枢 ZG/ZD 应在震荡区内：${z && [z.zd.toFixed(1), z.zg.toFixed(1), z.n]}`);
  ok(r.activeZs && r.bias === 0, `应判为中枢震荡，实际 ${r.biasTxt}`);
}
{
  // 波浪铁律
  ok(S.impulseScore([100, 110, 99, 120, 112, 130], 5, 1) === null, '2 浪破 1 浪起点 → 拒绝');
  ok(S.impulseScore([100, 110, 104, 112, 108, 130], 5, 1) === null, '3 浪最短 → 拒绝');
  ok(S.impulseScore([100, 110, 104, 120, 109, 130], 5, 1) === null, '4 浪进入 1 浪区 → 拒绝');
  ok(S.impulseScore([100, 110, 104, 120, 114, 126], 5, 1) > 0.4, '标准推动浪 → 高分');
  ok(S.impulseScore([200, 190, 196, 180, 186, 174], 5, -1) > 0.4, '下跌推动浪同样识别');
}
{
  // 平行通道：上升通道 宽 10
  const P = [100, 110, 104, 114, 108, 118, 112, 122, 116, 126, 120];
  const r = S.analyze(synth(P, 10, 900, 0.1), 900);
  ok(r.channel && r.channel.kind === '上升通道', `应识别出上升通道，实际 ${r.channel?.kind}`);
  if (r.channel?.offset) ok(Math.abs(r.channel.offset - 10) < 2.5, `通道宽度 ≈10，实际 ${r.channel.offset.toFixed(2)}`);
}

// ─── 2. 真实数据：因果性 + 数量控制 ───────────────────────────────────────────
console.log('2. 真实数据');
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'NVDAUSDT', 'TSLAUSDT'];
const TFS = [['15m', 900], ['1h', 3600], ['4h', 14400], ['1d', 86400]];
const stats = {};
let real = 0;
for (const sym of SYMS) for (const [tf, sec] of TFS) {
  const all = load(sym, tf);
  if (all.length < 300) continue;
  real++;
  const k = all.slice(-1500);
  const r = S.analyze(k, sec);
  // 因果性 1：截断到任意位置，截断点之前已确认的摆动点完全一致（不重绘）
  for (const cut of [Math.floor(k.length * 0.5), Math.floor(k.length * 0.8), k.length - 7]) {
    const r2 = S.analyze(k.slice(0, cut), sec);
    const a = r.swings.filter((s) => s.ci < cut).map((s) => `${s.i}${s.type}${s.price}`).join();
    const b = r2.swings.map((s) => `${s.i}${s.type}${s.price}`).join();
    ok(a === b, `${sym} ${tf} 截断 ${cut}：摆动点应不变`);
    const ea = r.events.filter((e) => e.j < cut).map((e) => `${e.j}${e.kind}${e.dir}`).join();
    const eb = r2.events.map((e) => `${e.j}${e.kind}${e.dir}`).join();
    ok(ea === eb, `${sym} ${tf} 截断 ${cut}：BOS/CHoCH 应不变`);
  }
  // 因果性 2：所有结构对象只引用 ≤ 最后一根的K线
  const lastT = k[k.length - 1].time;
  ok(r.swings.every((s) => s.ct <= lastT + sec), `${sym} ${tf} 摆动点确认时间合法`);
  // 数量控制
  ok(r.zones.above.length <= 2 && r.zones.below.length <= 2, `${sym} ${tf} 支撑压力每侧 ≤2`);
  ok(r.zones.above.every((z) => z.lo > r.close) && r.zones.below.every((z) => z.hi < r.close), `${sym} ${tf} 压力在上 支撑在下`);
  ok(r.zones.all.every((z) => z.hi - z.lo <= 1.21 * r.atrNow + 1e-9), `${sym} ${tf} 价位区宽度 ≤1.2ATR（无链式合并）`);
  for (const L of [r.tl.up, r.tl.down]) if (L) ok(L.breakJ < 0 && L.b.i > L.a.i && L.touches >= 2, `${sym} ${tf} 有效趋势线未破且两锚点有序`);
  if (r.tl.up) ok(S.lineAt(r.tl.up, lastT) <= r.close + 0.25 * r.atrNow + 1e-9, `${sym} ${tf} 上升趋势线在价格下方`);
  if (r.tl.down) ok(S.lineAt(r.tl.down, lastT) >= r.close - 0.25 * r.atrNow - 1e-9, `${sym} ${tf} 下降趋势线在价格上方`);
  ok(r.zs.every((z) => z.zg > z.zd && z.gg >= z.zg && z.dd <= z.zd && z.n >= 3), `${sym} ${tf} 中枢 GG≥ZG>ZD≥DD`);
  if (r.wave) ok(r.wave.pts.every((p, i) => i === 0 || p.time > r.wave.pts[i - 1].time), `${sym} ${tf} 波浪点时间递增`);
  // 统计：在这段数据里取 12 个历史时刻，各自只用截至当时的 600 根（≈ 图上能看到的量）
  const s = (stats[tf] ??= { n: 0, leg: 0, sw160: 0, tlUp: 0, tlDn: 0, strong: 0, ch: 0, zs: 0, wave: 0, z: 0, inZs: 0 });
  for (let q = 0; q < 12; q++) {
    const end = all.length - 1 - Math.floor(q * (all.length - 700) / 12);
    const kk = all.slice(end - 600, end), rr = S.analyze(kk, sec);
    s.n++; s.leg += rr.avgLegBars;
    s.sw160 += rr.swings.filter((x) => x.i >= kk.length - 160).length;
    s.tlUp += !!rr.tl.up; s.tlDn += !!rr.tl.down; s.strong += (rr.tl.up?.strong ? 1 : 0) + (rr.tl.down?.strong ? 1 : 0);
    s.ch += !!rr.channel; s.zs += !!rr.activeZs; s.wave += !!rr.wave; s.z += rr.zones.above.length + rr.zones.below.length;
    s.inZs += rr.bias === 0 && !!rr.activeZs;
  }
  if (tf === '4h' || tf === '15m') {
    const f = (x) => (x >= 100 ? x.toFixed(1) : x.toPrecision(5));
    console.log(`  ${sym.padEnd(9)} ${tf.padEnd(3)} ${r.biasTxt.padEnd(14)} 摆动点${r.swings.length} 压力[${r.zones.above.map((z) => f(z.price) + '×' + z.touches).join(' ')}] 支撑[${r.zones.below.map((z) => f(z.price) + '×' + z.touches).join(' ')}]` +
      ` 趋势线↑${r.tl.up ? r.tl.up.touches : '-'}↓${r.tl.down ? r.tl.down.touches : '-'} ${r.channel?.kind ?? ''} ${r.activeZs ? `中枢${f(r.activeZs.zd)}~${f(r.activeZs.zg)}` : ''} ${r.wave ? (r.wave.kind === 'abc' ? 'ABC' : r.wave.nW + '浪') + (r.wave.dir > 0 ? '↑' : '↓') + r.wave.score.toFixed(2) : ''}`);
  }
}
console.log('\n  周期   平均每笔K线  近160根摆动点  上升线 下降线 ≥3触碰 通道 当前中枢 判震荡 波浪 支撑压力条数');
for (const [tf, s] of Object.entries(stats)) {
  const p = (x) => `${((x / s.n) * 100).toFixed(0)}%`.padStart(5);
  console.log(`  ${tf.padEnd(5)} ${(s.leg / s.n).toFixed(1).padStart(10)} ${(s.sw160 / s.n).toFixed(1).padStart(13)}  ${p(s.tlUp)} ${p(s.tlDn)} ${(s.strong / s.n).toFixed(1).padStart(5)} ${p(s.ch)} ${p(s.zs)} ${p(s.inZs).padStart(6)} ${p(s.wave)} ${(s.z / s.n).toFixed(1).padStart(8)}`);
  // 图上可视 160 根内的转折点数：太多就又乱了，太少就没结构
  ok(s.sw160 / s.n >= 6 && s.sw160 / s.n <= 26, `${tf} 近160根平均摆动点数应在 6~26，实际 ${(s.sw160 / s.n).toFixed(1)}`);
}
if (!real) console.log('  （没找到 quant/data/csv，跳过真实数据部分）');

// ─── 3. 性能：1500 根 × 每秒重算也要够快 ─────────────────────────────────────
{
  const k = load('BTCUSDT', '15m').slice(-1500);
  if (k.length) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) S.analyze(k, 900);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
    console.log(`\n3. 性能：1500 根 15m 一次 analyze ${ms.toFixed(1)} ms`);
    ok(ms < 60, `analyze 应 < 60ms，实际 ${ms.toFixed(1)}`);
  }
}

console.log('\n' + '='.repeat(70));
console.log(fail ? `失败 ${fail} 项 / 通过 ${pass} 项` : `全部通过 (${pass} 项断言)`);
process.exit(fail ? 1 : 0);
