// 计算核心：一个品种一次完整重算（策略信号 + 回测 + 大周期背景 + 强价位拒绝 + 实时状态）。
// 纯函数，主线程（降级时）和 Web Worker（js/worker.js）共用同一份代码，结果只含可结构化克隆的数据。
import { Strategy } from "./strategy.js";
import { Levels } from "./levels.js";

// 加密货币：信号K线主动成交偏向 ≥ 0.2 视为"过热追单"（6 个月 6 个币回测：这类信号每笔 -0.15R）
export const HOT_FLOW = 0.2;

// in: { ltf, htf, h4, d1, ltfSec, params(含 market) }
export function computeAll({ ltf, htf, h4, d1, ltfSec, params }) {
  if (!ltf || ltf.length < 100) return null;
  // 额外把 4h / 日线喂进去：htfStop（高周期硬位止损）和 regimeGate 需要。两者默认关闭
  const res = Strategy.run(ltf, htf, ltfSec, { ...params, h4k: h4, d1k: d1 });
  // 大周期背景（只显示和统计，不影响信号）
  const ctx = { h4: Strategy.trendSeries(h4, 14400), d1: Strategy.trendSeries(d1, 86400) };
  for (const sg of res.signals) {
    const t = sg.time + ltfSec;
    const a = Strategy.trendAt(ctx.d1, t), b = Strategy.trendAt(ctx.h4, t);
    sg.d1 = a ? (a.st === sg.side ? "同向" : "逆向") : null;
    sg.h4 = b ? (b.st === sg.side ? "同向" : "逆向") : null;
    const hist = res.ind.macd.hist;
    sg.mt = (hist[sg.i] - hist[sg.i - 1]) * sg.side > 0 ? "是" : "否"; // MACD 柱是否朝信号方向拐头
    const bar = ltf[sg.i];
    sg.flow = bar?.volume ? ((2 * bar.takerBuy) / bar.volume - 1) * sg.side : null; // >0 表示主动成交和信号同方向
    sg.hot = params.market === "crypto" && sg.flow >= HOT_FLOW;
  }
  // 最近 300 根已收盘K线里的强价位拒绝
  let last = ltf.length - 1;
  if (ltf[last].time + ltfSec > Date.now() / 1000) last--;
  const rejections = [];
  for (let i = Math.max(61, last - 300); i <= last; i++) {
    const ev = Levels.rejection(res.levelsAt(i - 1), ltf, i, res.ind.atr[i - 1]);
    if (ev) rejections.push(ev);
  }
  const live = Strategy.liveState(res, ltf);
  const exit = Strategy.exitWarning(res, ltf);
  const lastSig = res.signals[res.signals.length - 1];
  const lastStatus = lastSig ? Strategy.signalStatus(lastSig, res, ltf, ltfSec) : null;
  // levelsAt 是闭包，传不出 Worker：只带出面板要用的"最后一根已收盘K线时的价位"
  const levelsNow = last >= 0 ? { i: last, time: ltf[last].time, levels: res.levelsAt(last) } : null;
  delete res.levelsAt;
  return { res: { ...res, levelsNow }, ctx, rejections, live, exit, lastStatus, firstTime: ltf[0].time, len: ltf.length };
}

// Worker 内的状态机：每个品种每个周期保存一份计算窗口；主线程只发增量（最后几根），
// 窗口整体换掉（重新加载 / 补缺口 / 往前翻页后）时才发整段。
//   msg = { id, sym, ltfSec, params, win, bars: { key: { full: [...]} | { tail: [...] } } }
// tail = 上次发过的最后一根及之后的K线。合并后仍按 win 截断，和主线程 d.ltf（= 完整数组最后 win 根）一致。
// 如果 Worker 里没有这个品种 / 缺口对不上，返回 { need: [keys] } 让主线程发整段
export class ComputeCore {
  constructor() { this.store = new Map(); }
  apply(msg) {
    const st = this.store.get(msg.sym) ?? {};
    const need = [];
    for (const [key, v] of Object.entries(msg.bars ?? {})) {
      if (v.full) { st[key] = v.full; continue; }
      const arr = st[key], tail = v.tail;
      if (!arr || !tail?.length) { if (!arr) need.push(key); continue; }
      // 主线程发的 tail 从"上次发过的最后一根"开始，第一根必须和这里的最后一根对上；
      // 对不上（Worker 重启过 / 主线程换了整段）就要整段重发
      if (tail[0].time !== arr[arr.length - 1].time) { need.push(key); continue; }
      arr[arr.length - 1] = tail[0];
      for (let j = 1; j < tail.length; j++) arr.push(tail[j]);
      const w = msg.win[key];
      if (arr.length > w) arr.splice(0, arr.length - w);
    }
    this.store.set(msg.sym, st);
    return need;
  }
  handle(msg) {
    if (msg.drop) { this.store.delete(msg.sym); return { id: msg.id, sym: msg.sym, dropped: true }; }
    const need = this.apply(msg);
    if (need.length) return { id: msg.id, sym: msg.sym, need };
    const st = this.store.get(msg.sym);
    const out = computeAll({ ltf: st.ltf, htf: st.htf ?? [], h4: st.h4 ?? [], d1: st.d1 ?? [], ltfSec: msg.ltfSec, params: msg.params });
    return { id: msg.id, sym: msg.sym, out };
  }
}
