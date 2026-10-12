'use strict';
// 验证 MTF 新增的三个函数：htf / channel / regime
// 用 quant/data/csv 的真实币安K线。运行：node test/levels_mtf_test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CSV = '/proj/lterbsdailytest/ziixyax/myfile/quant/data/csv';
const SRC = path.join(__dirname, '..', 'js', 'levels.js');

// levels.js 是浏览器脚本（顶层 const Levels），用 vm 取出来
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(SRC, 'utf8') + '\n;globalThis.__L = Levels;', ctx);
const L = ctx.__L;

function load(sym, tf, months) {
  const out = [];
  for (const m of months) {
    const f = path.join(CSV, `${sym}-${tf}-${m}.csv`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').trim().split('\n')) {
      const c = line.split(',');
      out.push({
        time: Math.floor(+c[0] / 1000),
        open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5],
      });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log(`  ✗ ${msg}`); } };

const MONTHS = ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01'];
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT'];

console.log('MTF 新增函数验证（真实币安K线）');
console.log('='.repeat(78));

for (const sym of SYMS) {
  const h4 = load(sym, '4h', MONTHS), d1 = load(sym, '1d', MONTHS), m15 = load(sym, '15m', MONTHS.slice(-2));
  if (!h4.length || !d1.length) { console.log(`\n${sym}: 无数据，跳过`); continue; }
  const now = d1[d1.length - 1].time + 86400; // 最后一根日K已收盘
  const px = d1[d1.length - 1].close;

  console.log(`\n${sym}  4h ${h4.length} 根 / 日线 ${d1.length} 根  最新收盘 ${px}`);

  // ── htf ──────────────────────────────────────────────────────────────────
  const lv = L.htf(h4, d1, now);
  ok(lv.length > 0, `${sym} htf 返回空`);
  ok(lv.every((l) => l.price > 0 && isFinite(l.price)), `${sym} htf 有非法价格`);
  ok(lv.every((l) => l.lo <= l.price && l.price <= l.hi), `${sym} htf price 不在 [lo,hi] 内`);
  ok(lv.every((l) => l.strength >= 3), `${sym} htf strength 小于最小权重 3`);
  // 单调不减（聚类前已排序）
  ok(lv.every((l, i) => i === 0 || l.price >= lv[i - 1].price), `${sym} htf 结果未按价格排序`);
  // 聚类区不重叠
  ok(lv.every((l, i) => i === 0 || l.lo >= lv[i - 1].lo), `${sym} htf 聚类区重叠`);
  // 链式合并回归测试：簇宽度不得超过 maxWidth(=1.5*tol)，否则"价位"会糊成一个大区间
  const dBase = d1.filter((x) => x.time + 86400 <= now).slice(-180).slice(-14);
  const tol = dBase.reduce((a, x) => a + (x.high - x.low), 0) / dBase.length * 0.3;
  const chained = lv.filter((l) => l.hi - l.lo > tol * 1.5 + 1e-9);
  ok(chained.length === 0, `${sym} htf 出现链式合并巨簇 ${chained.length} 个，最宽 ` +
    `${chained.length ? (Math.max(...chained.map((l) => l.hi - l.lo)) / tol).toFixed(1) : 0}x tol`);
  // 单个"价位"不该占到价格的 5% 以上
  const fat = lv.filter((l) => (l.hi - l.lo) / l.price > 0.05);
  ok(fat.length === 0, `${sym} htf 有 ${fat.length} 个位宽度超过价格的 5%`);
  const hard = lv.filter((l) => l.hard);
  console.log(`  htf: ${lv.length} 个位（硬位 ${hard.length}）  ` +
    `最强 strength=${Math.max(...lv.map((l) => l.strength))}  ` +
    `价格区间 ${Math.min(...lv.map((l) => l.price)).toPrecision(6)}~${Math.max(...lv.map((l) => l.price)).toPrecision(6)}`);
  const near = lv.filter((l) => Math.abs(l.price / px - 1) < 0.12).sort((a, b) => a.price - b.price);
  console.log(`  当前价 ±12% 内 ${near.length} 个: ` +
    near.slice(0, 6).map((l) => `${l.price.toPrecision(6)}(${l.srcs.join('+')}×${l.strength}${l.hard ? ',硬' : ''})`).join('  '));

  // 无未来函数：把 now 往前推 30 天，结果不能包含那之后才形成的极值
  const past = now - 30 * 86400;
  const lvPast = L.htf(h4, d1, past);
  const futureMax = Math.max(...d1.filter((x) => x.time > past).map((x) => x.high));
  const futureHits = lvPast.filter((l) => l.hi > futureMax * 0.999 && l.price > Math.max(...d1.filter((x) => x.time + 86400 <= past).map((x) => x.high)));
  ok(futureHits.length === 0, `${sym} htf 在历史时点引用了未来K线极值（${futureHits.length} 处）`);

  // ── channel ──────────────────────────────────────────────────────────────
  const ch = L.channel(d1, 60);
  ok(ch !== null, `${sym} channel 返回 null`);
  if (ch) {
    ok(ch.points.length === Math.min(60, d1.length), `${sym} channel 点数不对`);
    ok(ch.points.every((p) => p.dn < p.mid && p.mid < p.up), `${sym} channel 上下沿顺序错`);
    ok(ch.r2 >= 0 && ch.r2 <= 1, `${sym} channel r2 越界: ${ch.r2}`);
    ok(isFinite(ch.pctPerDay) && Math.abs(ch.pctPerDay) < 50, `${sym} channel 日斜率异常: ${ch.pctPerDay}`);
    ok(ch.bandPct > 0 && ch.bandPct < 200, `${sym} channel 带宽异常: ${ch.bandPct}`);
    // 残差 ±2σ 的覆盖率应接近正态的 95%（log 价格下不会完全吻合，给宽松区间）
    const inside = ch.points.filter((p, i) => {
      const c = d1[d1.length - ch.points.length + i].close;
      return c >= p.dn && c <= p.up;
    }).length / ch.points.length;
    ok(inside > 0.8, `${sym} channel ±2σ 覆盖率过低: ${(inside * 100).toFixed(0)}%`);

    // lineAt 跨周期投影：这是把日线通道画到 15m 图上的关键
    ok(typeof ch.lineAt === 'function', `${sym} channel 缺 lineAt`);
    const mid0 = ch.lineAt(ch.from), midN = ch.lineAt(ch.to);
    ok(Math.abs(mid0.mid - ch.points[0].mid) < mid0.mid * 1e-9, `${sym} lineAt 与 points 首点不一致`);
    ok(Math.abs(midN.mid - ch.points[ch.points.length - 1].mid) < midN.mid * 1e-9, `${sym} lineAt 与 points 末点不一致`);
    // 在任意 15m 时刻求值都要有限且有序
    const probes = [ch.from, ch.from + 1234, (ch.from + ch.to) / 2, ch.to, ch.to + 3 * 86400];
    ok(probes.every((t) => { const v = ch.lineAt(t); return isFinite(v.mid) && v.dn < v.mid && v.mid < v.up; }),
      `${sym} lineAt 在探测点上非法`);
    // 斜率方向自洽：末点中轴应与 slopeUp 一致
    ok((midN.mid > mid0.mid) === ch.slopeUp || Math.abs(ch.pctPerDay) < 1e-9,
      `${sym} slopeUp 与中轴走向不一致`);
    // 带宽比例在中轴任意点都应恒定（log 空间等宽）
    ok(probes.every((t) => { const v = ch.lineAt(t); return Math.abs((v.up / v.mid) - (ch.bandPct / 100 + 1)) < 1e-9; }),
      `${sym} 通道上沿/中轴比例不恒定`);

    console.log(`  channel(日线60): r²=${ch.r2.toFixed(2)}  斜率 ${ch.pctPerDay >= 0 ? '+' : ''}${ch.pctPerDay.toFixed(2)}%/日  ` +
      `半宽 ±${ch.bandPct.toFixed(1)}%  ±2σ 覆盖 ${(inside * 100).toFixed(0)}%`);
  }
  // 窗口太短要返回 null，不能崩
  ok(L.channel(d1.slice(-5), 60) === null, `${sym} channel 短窗口未返回 null`);
  ok(L.channel([], 60) === null, `${sym} channel 空数组未返回 null`);

  // 人造纯指数序列 → r² 应接近 1，日斜率应可还原
  const synth = Array.from({ length: 50 }, (_, i) => ({ time: i * 86400, close: 100 * Math.exp(0.01 * i), high: 0, low: 0 }));
  const cs = L.channel(synth, 50);
  ok(cs.r2 > 0.999, `合成序列 r² 应≈1，实际 ${cs.r2}`);
  ok(Math.abs(cs.pctPerDay - (Math.exp(0.01) - 1) * 100) < 0.01, `合成序列斜率还原失败: ${cs.pctPerDay}`);
  // 4h 周期上算的通道，求值到 15m 时间点也必须连续（跨周期投影的核心用法）
  const ch4 = L.channel(h4, 180);
  if (ch4) {
    const t = h4[h4.length - 1].time;
    const a = ch4.lineAt(t), b = ch4.lineAt(t + 900);
    ok(Math.abs(b.mid / a.mid - 1) < 0.02, `${sym} 4h 通道在 15m 步长上跳变过大`);
  }

  // ── regime ───────────────────────────────────────────────────────────────
  const rg = L.regime(d1, 30);
  ok(rg !== null, `${sym} regime 返回 null`);
  if (rg) {
    ok(rg.er >= 0 && rg.er <= 1, `${sym} regime er 越界: ${rg.er}`);
    ok(rg.lo <= rg.mid && rg.mid <= rg.hi, `${sym} regime 区间顺序错`);
    ok(rg.widthPct > 0, `${sym} regime 宽度非正`);
    console.log(`  regime(日线30): ER=${rg.er.toFixed(3)} → ${rg.trending ? (rg.up ? '趋势↑' : '趋势↓') : '震荡'}  ` +
      `区间 ${rg.lo.toPrecision(6)}~${rg.hi.toPrecision(6)} (宽 ${rg.widthPct.toFixed(1)}%)`);
  }
  ok(L.regime(d1.slice(-3), 30) === null, `${sym} regime 短窗口未返回 null`);

  // 15m 上也要能跑（app 会在多个周期调用）
  if (m15.length > 100) {
    ok(L.channel(m15, 96) !== null, `${sym} channel 在 15m 上失败`);
    ok(L.regime(m15, 96) !== null, `${sym} regime 在 15m 上失败`);
  }
}

// 单边序列 ER 应接近 1，锯齿序列应接近 0
const mono = Array.from({ length: 30 }, (_, i) => ({ close: 100 + i, high: 100 + i, low: 100 + i }));
const saw = Array.from({ length: 30 }, (_, i) => ({ close: 100 + (i % 2), high: 101, low: 100 }));
ok(L.regime(mono, 30).er > 0.99, `单边序列 ER 应≈1，实际 ${L.regime(mono, 30).er}`);
ok(L.regime(saw, 30).er < 0.1, `锯齿序列 ER 应≈0，实际 ${L.regime(saw, 30).er}`);
ok(L.regime(mono, 30).trending === true, '单边序列应判为趋势');
ok(L.regime(saw, 30).trending === false, '锯齿序列应判为震荡');

// 原有函数未被破坏
ok(typeof L.prepare === 'function' && typeof L.at === 'function' &&
   typeof L.nearest === 'function' && typeof L.daily === 'function' &&
   typeof L.testState === 'function' && typeof L.rejection === 'function',
   '原有导出被破坏');

console.log('\n' + '='.repeat(78));
console.log(fails === 0 ? `全部通过 (${checks} 项断言)` : `${fails}/${checks} 项断言失败`);
process.exit(fails === 0 ? 0 : 1);
