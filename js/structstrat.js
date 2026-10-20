// 结构策略（v1）：大周期定方向，小周期等回调结束（顺大周期方向的 CHoCH/BOS）入场，止损放在回调极值外。
//
// 规则（全部只用当时已知的数据）：
//   1. 大周期方向 htfBias(t)：t 时刻已确认的大周期摆动点里，最近两个高点、两个低点
//      HH+HL → 多；LH+LL → 空；否则取最近一次大周期 BOS/CHoCH 的方向；都没有 → 不做。
//   2. 触发：小周期出现与大周期同向的结构突破（trigger: "choch" 只要 CHoCH = 回调结束；"any" 含 BOS）。
//   3. 止损：被突破的那个摆动点到突破K线之间的极值（做多 = 回调最低点）外 slBuf×ATR。
//   4. 入场：entry "market" = 突破K线收盘价；"retest" = 在被突破的价位挂限价单，validBars 根内回踩成交，
//      成交前先碰到止损或先走到目标 → 撤单。
//   5. 出场：exit "fixed" = tpR 倍 R 止盈；"half" = 1R 平一半、止损移保本，剩余半仓跟踪最近确认的小周期摆动点。
//      两种都有 maxBars 时间止损。同一根K线同时碰到止损和止盈按止损算。
//   6. 同一品种同一时间只有一笔（含挂单），前一笔结束前的新触发忽略。
//
// 成本（R 为单位）在 cost() 里按"每条腿"算：吃单腿 taker 费 + 滑点，挂单腿 maker 费、无滑点。
const StructStrat = (() => {
  const S = typeof Structure !== "undefined" ? Structure : require("./structure.js");

  const DEFAULTS = {
    // 默认值 = 实验十三在 1h→4h 上按样本内挑出的组合（见 README「结构策略」）
    trigger: "any",     // "choch" | "any"
    entry: "market",    // "market" | "retest"
    exit: "half",       // "fixed" | "half"
    tpR: 2,
    slBuf: 0.1,         // × ATR
    minRiskAtr: 0.6, maxRiskAtr: 5,
    validBars: 12,      // 回踩挂单有效K线数
    maxBars: 192,       // 时间止损（K线数）
    trailBuf: 0.1,      // half 模式跟踪止损的缓冲（× ATR）
    multLtf: null, multHtf: null, // ZigZag 倍数，null = Structure.MULT 默认
  };

  // 大周期方向：预处理成按时间可查询的函数（指针单调前进，调用方必须按时间升序查询）
  function htfBiasFn(hk, hsec, mult) {
    const atr = S.atrOf(hk, 14);
    const { swings } = S.zigzag(hk, atr, mult ?? S.MULT[hsec] ?? 2.2, hsec);
    const { events } = S.breaks(hk, swings, hsec);
    let sp = 0, ep = 0, H = [], L = [], lastEv = 0;
    return (t) => {
      while (sp < swings.length && swings[sp].ct <= t) { const s = swings[sp++]; (s.type === "H" ? H : L).push(s.price); if (H.length > 2) H.shift(); if (L.length > 2) L.shift(); }
      while (ep < events.length && events[ep].ct <= t) lastEv = events[ep++].dir;
      if (H.length === 2 && L.length === 2) {
        if (H[1] > H[0] && L[1] > L[0]) return 1;
        if (H[1] < H[0] && L[1] < L[0]) return -1;
      }
      return lastEv;
    };
  }

  // 生成全部交易（已模拟出场）。k/hk 时间升序，k 是小周期，hk 是大周期
  function run(k, hk, sec, hsec, params = {}) {
    const p = { ...DEFAULTS, ...params };
    const n = k.length;
    const atr = S.atrOf(k, 14);
    const { swings } = S.zigzag(k, atr, p.multLtf ?? S.MULT[sec] ?? 2.2, sec);
    const { events } = S.breaks(k, swings, sec);
    const bias = htfBiasFn(hk, hsec, p.multHtf);
    // 已确认摆动点（按确认K线）——给 half 模式跟踪止损用
    const swByCi = [...swings].sort((a, b) => a.ci - b.ci);
    const trades = [];
    let busyUntil = -1;
    for (const e of events) {
      const j = e.j;
      if (j <= busyUntil || j >= n - 2 || !isFinite(atr[j])) continue;
      if (p.trigger === "choch" && e.kind !== "CHoCH") continue;
      const d = e.dir;
      const b = bias(k[j].time + sec); // 突破K线收盘时刻的大周期方向
      if (b !== d) continue;
      // 回调极值
      let ext = d > 0 ? Infinity : -Infinity;
      for (let m = e.from.i; m <= j; m++) ext = d > 0 ? Math.min(ext, k[m].low) : Math.max(ext, k[m].high);
      const sl = ext - d * p.slBuf * atr[j];
      // 入场价
      let entry = k[j].close, fillI = j, maker = false;
      if (p.entry === "retest" && (e.from.price - k[j].close) * d < 0) {
        const lim = e.from.price;
        const risk0 = (lim - sl) * d;
        const tp0 = lim + d * p.tpR * risk0;
        fillI = -1;
        for (let m = j + 1; m < Math.min(n, j + 1 + p.validBars); m++) {
          const x = k[m];
          // 成交前已经先走到目标 → 错过，撤单
          if (d > 0 ? x.high >= tp0 && x.low > lim : x.low <= tp0 && x.high < lim) break;
          if (d > 0 ? x.low <= lim : x.high >= lim) { fillI = m; break; }
        }
        if (fillI < 0) { busyUntil = j + p.validBars; continue; }
        entry = lim; maker = true;
      }
      const risk = (entry - sl) * d;
      if (!(risk >= p.minRiskAtr * atr[j]) || risk > p.maxRiskAtr * atr[j]) { busyUntil = Math.max(busyUntil, fillI); continue; }
      const t = simulate(k, atr, swByCi, { d, entry, sl, risk, fillI, maker, sameBarFill: fillI !== j }, p, sec);
      trades.push({
        time: k[j].time, sigI: j, side: d, kind: e.kind, entry, sl, risk, riskAtr: risk / atr[j],
        fillI, fillTime: k[fillI].time, maker, ...t,
      });
      busyUntil = t.exitI;
    }
    return trades;
  }

  function simulate(k, atr, swByCi, o, p, sec) {
    const { d, entry, sl, risk, fillI } = o;
    const n = k.length;
    let stop = sl, half = false, realized = 0;
    const tp = entry + d * (p.exit === "half" ? 1 : p.tpR) * risk;
    let sp = 0; // swByCi 指针
    const legs = []; // [份额, 是否挂单成交]
    const end = Math.min(n - 1, fillI + p.maxBars);
    // 回踩成交那根：价格已经碰到挂单价，同一根如果也碰到止损 → 止损（保守）
    for (let m = o.sameBarFill ? fillI : fillI + 1; m <= end; m++) {
      const x = k[m];
      // 跟踪止损只用 m 之前已确认的摆动点
      if (half) {
        while (sp < swByCi.length && swByCi[sp].ci < m) {
          const s = swByCi[sp++];
          if (s.type === (d > 0 ? "L" : "H") && s.i > fillI) {
            const ns = s.price - d * p.trailBuf * atr[s.ci];
            if ((ns - stop) * d > 0) stop = ns;
          }
        }
      }
      const hitStop = d > 0 ? x.low <= stop : x.high >= stop;
      const hitTp = !half && (d > 0 ? x.high >= tp : x.low <= tp) && !(m === fillI);
      if (hitStop) {
        // 跳空穿过止损按开盘价成交
        const px = (d > 0 ? x.open < stop : x.open > stop) && m !== fillI ? x.open : stop;
        const r = ((px - entry) * d) / risk;
        const share = half ? 0.5 : 1;
        realized += share * r; legs.push([share, false]);
        return { r: realized, exitI: m, barsHeld: m - fillI, exitType: half ? (r > 0 ? "trail" : "be") : "stop", legs };
      }
      if (hitTp) {
        if (p.exit === "half") {
          realized += 0.5; legs.push([0.5, true]); half = true; stop = entry;
          // 同一根后续是否回到保本：保守起见下一根开始才检查
          continue;
        }
        realized += p.tpR; legs.push([1, true]);
        return { r: realized, exitI: m, barsHeld: m - fillI, exitType: "tp", legs };
      }
    }
    const px = k[end].close, r = ((px - entry) * d) / risk, share = half ? 0.5 : 1;
    realized += share * r; legs.push([share, false]);
    // 数据到头了还没出场 = 持仓中（看板显示用；回测里这类交易按最后收盘价计）
    const open = end === n - 1 && end < fillI + p.maxBars;
    return { r: realized, exitI: end, barsHeld: end - fillI, exitType: open ? "open" : "time", legs, open, stop, half, tp };
  }

  // 成本（R）：feeTaker/feeMaker 为单边 %，slipBps 为吃单腿单边滑点
  function cost(t, c, sec) {
    const px = t.entry, R = t.risk;
    const leg = (maker) => (maker ? c.feeMaker / 100 : c.feeTaker / 100 + c.slipBps / 1e4);
    let frac = leg(t.maker);
    for (const [share, maker] of t.legs) frac += share * leg(maker);
    let fund = 0;
    if (c.fundingAnnual) {
      const periods = (t.barsHeld * sec) / 3600 / 8;
      fund = t.side * periods * (c.fundingAnnual / (365 * 3));
    }
    return { costR: (frac + fund) * px / R, feeR: frac * px / R, fundR: fund * px / R };
  }

  return { run, cost, htfBiasFn, DEFAULTS };
})();
if (typeof module !== "undefined") module.exports = StructStrat;
