// Worker 计算协议：增量（tail）喂给 ComputeCore 的结果，必须和直接对完整窗口 computeAll 一致；
// 缺口 / 重启时要求整段重发。运行：node test/compute_test.js
import { loadCsv, hasCsv, counter } from './_csv.js';
import { ComputeCore, computeAll } from '../js/compute.js';
import { Strategy } from '../js/strategy.js';
const T = counter();
if (!hasCsv()) { console.log('没有真实K线，跳过'); T.done(); }
const WIN = { ltf: 1500, htf: 500, h4: 1000, d1: 500 };
const SEC = { ltf: 900, htf: 3600, h4: 14400, d1: 86400 };
const src = { ltf: loadCsv('ETHUSDT', '15m', 2), htf: loadCsv('ETHUSDT', '1h', 2), h4: loadCsv('ETHUSDT', '4h', 8), d1: loadCsv('ETHUSDT', '1d', 24) };
const params = { ...Strategy.DEFAULTS, market: 'crypto' };
const realNow = Date.now;
// 主线程模拟：完整数组 + 每次只发 tail
const main = {}; const sent = {};
const end0 = src.ltf.length - 400; // 从倒数 400 根开始逐根推进
const upto = (key, t) => src[key].filter((x) => x.time <= t);
const core = new ComputeCore();
const sig = (o) => JSON.stringify(o.res.signals.map((s) => [s.time, s.side, s.score, s.entry, s.result, s.r, s.d1, s.h4, s.hot]));
let checks = 0, firstMsg = true;
for (let step = 0; step < 400; step += 7) {
  const t = src.ltf[end0 + step].time;
  Date.now = () => (t + 600) * 1000;
  const bars = {};
  for (const key of Object.keys(WIN)) {
    main[key] = upto(key, t).map((x) => ({ ...x }));
    // 最后一根模拟"正在形成"：收盘价被改过，下一步才是最终值
    const a = main[key]; if (a.length) a[a.length - 1] = { ...a[a.length - 1], close: a[a.length - 1].close * 1.0003 };
    if (firstMsg) bars[key] = { full: a.slice(-WIN[key]) };
    else { const j = a.findIndex((x) => x.time === sent[key]); bars[key] = j >= 0 ? { tail: a.slice(j) } : { full: a.slice(-WIN[key]) }; }
    sent[key] = a[a.length - 1].time;
  }
  firstMsg = false;
  const r = core.handle({ id: step, sym: 'ETH', ltfSec: 900, params, win: WIN, bars });
  T.ok(!r.need && r.out, `step ${step} 不应要求整段重发 ${r.need}`);
  const direct = computeAll({ ltf: main.ltf.slice(-1500), htf: main.htf.slice(-500), h4: main.h4.slice(-1000), d1: main.d1.slice(-500), ltfSec: 900, params });
  T.ok(sig(r.out) === sig(direct), `step ${step} 增量结果与整段计算不一致`);
  T.ok(r.out.len === 1500 && r.out.firstTime === main.ltf[main.ltf.length - 1500].time, `step ${step} 窗口对齐`);
  T.ok(JSON.stringify(r.out.res.levelsNow) === JSON.stringify(direct.res.levelsNow) && r.out.rejections.length === direct.rejections.length, `step ${step} 价位/拒绝一致`);
  checks++;
}
Date.now = realNow;
// 结果可以结构化克隆（Worker postMessage 的要求）
{
  const o = computeAll({ ltf: main.ltf.slice(-1500), htf: main.htf.slice(-500), h4: main.h4, d1: main.d1, ltfSec: 900, params });
  let ok = true; try { structuredClone(o); } catch (e) { ok = false; console.log(e.message); }
  T.ok(ok, '结果可结构化克隆（不含函数）');
}
// 缺口：tail 第一根对不上 → need
{
  const a = main.ltf;
  const r = core.handle({ id: 1, sym: 'ETH', ltfSec: 900, params, win: WIN, bars: { ltf: { tail: [{ ...a[a.length - 1], time: a[a.length - 1].time + 9000 }] } } });
  T.ok(r.need?.join() === 'ltf', `缺口应要求整段：${JSON.stringify(r.need)}`);
  const r2 = new ComputeCore().handle({ id: 2, sym: 'X', ltfSec: 900, params, win: WIN, bars: { ltf: { tail: a.slice(-2) } } });
  T.ok(r2.need?.includes('ltf'), 'Worker 没有这个品种 → 要求整段');
  T.ok(new ComputeCore().handle({ sym: 'X', drop: true }).dropped, 'drop');
}
console.log(`  增量对拍 ${checks} 步`);
T.done();
