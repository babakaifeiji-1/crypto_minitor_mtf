// 形态引擎：合成数据上的已知答案 + 真实数据上的因果性（截断不变）与基本合法性
// 运行：node test/setups_test.js
import { loadCsv, hasCsv, counter } from './_csv.js';
import { Setups } from '../js/setups.js';
const T = counter();

// 由转折点生成K线（同 structure_test），可在某一段插入"插针"
function synth(points, per, sec = 900, noise = 0.15, t0 = 1_700_000_000, spikes = {}) {
  const k = []; let t = t0, seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let j = 1; j < points.length; j++) {
    const a = points[j - 1], b = points[j];
    for (let m = 0; m < per; m++) {
      const o = a + (b - a) * (m / per), c = a + (b - a) * ((m + 1) / per), nz = Math.abs(rnd()) * noise;
      k.push({ time: t, open: o, close: c, high: Math.max(o, c) + nz, low: Math.min(o, c) - nz, volume: 1, takerBuy: 0.5 });
      t += sec;
    }
  }
  for (const [i, f] of Object.entries(spikes)) f(k[+i], k, +i);
  return k;
}

console.log('1. 合成数据');
{
  // 区间 100~110 来回 3 次，然后插针跌破 100（前低/等低）、同一根收回 → A 做多
  const P = [105, 110, 100, 110, 100.2, 110, 104];
  const k = synth(P, 12);
  const j = k.length - 6;
  k[j] = { ...k[j], open: 100.6, low: 99.2, close: 101.0, high: 101.2 };
  const r = Setups.detect(k, 900, null, 0, { kinds: { B: false, C: false } });
  const A = r.events.filter((e) => e.kind === 'A');
  T.ok(A.some((e) => e.j === j && e.side === 1), `插针收回应出 A 多：${JSON.stringify(A.map((e) => [e.j, e.side, e.level?.name]))}（期望 j=${j}）`);
  const e = A.find((x) => x.j === j);
  if (e) {
    T.ok(Math.abs(e.sl - (99.2 - 0.1 * r.atrNow)) < 0.3 && e.tp1 > e.entry && e.tp2 > e.tp1, `止损在针外、TP 在上方：${e.sl.toFixed(2)} ${e.tp1.toFixed(2)} ${e.tp2.toFixed(2)}`);
    T.ok(/等低|前低/.test(e.level.name), `价位类型 ${e.level.name}`);
  }
  // 同样的插针但收在低位（没收回）→ 不出 A
  const k2 = synth(P, 12); k2[j] = { ...k2[j], open: 100.6, low: 99.2, close: 99.5, high: 101.2 };
  T.ok(!Setups.detect(k2, 900, null, 0, { kinds: { B: false, C: false } }).events.some((x) => x.kind === 'A' && x.j === j && x.side === 1), '没收回不出 A');
}
{
  // 区间：B 在下沿做多、上沿做空
  const P = [105, 110, 100, 110, 100, 110, 100, 110, 100, 108];
  const k = synth(P, 12, 900, 0.05);
  // 在最后一次到下沿后做一根长下影阳线
  const r = Setups.detect(k, 900, null, 0, { kinds: { A: false, C: false } });
  T.ok(r.range && Math.abs(r.range.top - 110) < 1 && Math.abs(r.range.bot - 100) < 1, `应识别区间 100~110：${r.range && [r.range.bot.toFixed(1), r.range.top.toFixed(1)]}`);
  const B = r.events.filter((e) => e.kind === 'B');
  T.ok(B.every((e) => (e.side > 0 ? e.entry < r.range?.mid ?? 105 : e.entry > (r.range?.mid ?? 105))), 'B 多在下半、空在上半');
}
{
  // 顺势回调：大周期向上（HH/HL），小周期 推 → 回调 60% → 突破前高 → C 多
  const H = synth([100, 120, 110, 130, 120, 140, 130, 150], 6, 3600, 0.2, 1_699_000_000);
  const P = [140, 146, 142, 148, 142.5, 151, 146];
  const k = synth(P, 10, 900, 0.05, 1_699_000_000 + 41 * 3600);
  const r = Setups.detect(k, 900, H, 3600, { kinds: { A: false, B: false }, maxRiskAtr: 20 });
  T.ok(r.bias === 1, `大周期应向上，实际 ${r.bias}`);
  const C = r.events.filter((e) => e.kind === 'C');
  T.ok(C.length >= 1 && C.every((e) => e.side === 1 && e.retr >= 0.5 && e.sl < e.ext), `应出 C 多且回调 ≥0.5：${JSON.stringify(C.map((e) => [e.j, e.retr?.toFixed(2)]))}`);
}

console.log('2. 真实数据：截断不变 + 合法性');
if (!hasCsv()) console.log('  跳过');
else {
  const counts = {};
  for (const [sym, tf, htf, sec, hsec, mo, hmo] of [['BTCUSDT', '15m', '1h', 900, 3600, 3, 3], ['ETHUSDT', '15m', '1h', 900, 3600, 3, 3], ['SOLUSDT', '1h', '4h', 3600, 14400, 8, 12], ['BNBUSDT', '4h', '1d', 14400, 86400, 24, 40]]) {
    const k = loadCsv(sym, tf, mo).slice(-3000), hk = loadCsv(sym, htf, hmo);
    const hcut = (t) => hk.filter((x) => x.time + hsec <= t);
    const full = Setups.detect(k, sec, hcut(k[k.length - 1].time + sec), hsec);
    const key = (e) => [e.kind, e.side, e.j, e.entry, e.sl, e.tp1, e.tp2].join('|');
    for (const cut of [1200, 2000, 2700]) {
      const part = Setups.detect(k.slice(0, cut), sec, hcut(k[cut - 1].time + sec), hsec);
      const a = full.events.filter((e) => e.j < cut).map(key).join(), b = part.events.map(key).join();
      T.ok(a === b, `${sym} ${tf} 截断 ${cut}：形态应不变`);
      // 截断前已经结束的交易，结果也应一致
      const ra = full.events.filter((e) => e.exitI < cut).map((e) => e.r.toFixed(9)).join(), rb = part.events.filter((e) => !e.open && e.exitI < cut - 1).map((e) => e.r.toFixed(9)).join();
      T.ok(ra.startsWith(rb) || rb.startsWith(ra), `${sym} ${tf} 截断 ${cut}：已平仓结果一致`);
    }
    for (const e of full.events) {
      const ok = e.side > 0 ? e.sl < e.entry && e.tp1 > e.entry && e.tp2 > e.tp1 - 1e-9 : e.sl > e.entry && e.tp1 < e.entry && e.tp2 < e.tp1 + 1e-9;
      if (!ok) { T.ok(false, `${sym} ${e.kind} 价位方向错 ${JSON.stringify([e.side, e.entry, e.sl, e.tp1, e.tp2])}`); break; }
    }
    T.ok(full.events.every((e, i) => i === 0 || e.j >= full.events[i - 1].j), `${sym} 事件时间有序`);
    // 每种形态同一时间只有一笔
    for (const kd of ['A', 'B', 'C']) { const ev = full.events.filter((e) => e.kind === kd); T.ok(ev.every((e, i) => i === 0 || e.j > ev[i - 1].exitI), `${sym} ${kd} 不重叠`); }
    const c = (counts[`${sym} ${tf}`] = { A: 0, B: 0, C: 0 });
    for (const e of full.events) c[e.kind]++;
  }
  console.log('  3000 根里的形态数量：' + Object.entries(counts).map(([k, v]) => `${k} A${v.A}/B${v.B}/C${v.C}`).join('  '));
  const t0 = performance.now(); const k = loadCsv('BTCUSDT', '15m', 3).slice(-1500), hk = loadCsv('BTCUSDT', '1h', 3);
  for (let i = 0; i < 10; i++) Setups.detect(k, 900, hk, 3600);
  console.log(`  性能：1500 根 15m 一次 detect ${((performance.now() - t0) / 10).toFixed(1)} ms`);
}
T.done();
