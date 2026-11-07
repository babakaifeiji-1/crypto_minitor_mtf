// 形态引擎：三类可执行的交易形态 + 它们依赖的结构元素。全部只用已收盘K线，逐根推进，无未来函数。
//
//   A 扫流动性收回（Brooks 失败突破 / 威科夫 Spring·UTAD / ICT liquidity sweep）
//     价位 = 已确认的摆动低点、等低（EQL）、昨日低点（多头；空头镜像）。
//     第 j 根最低价刺穿价位 ≥ 0.05ATR、刺穿深度 ≤ 1.5ATR，且在刺穿后 ≤ 3 根内收盘收回价位上方；
//     收回那根必须收在自身振幅的上半部（有力度）。大周期结构反向（htfBias = -side）时不做。
//     入场 = 收回K线收盘；止损 = 刺穿极值外 0.1ATR；TP1 = 1R（平一半、止损移保本）；
//     TP2 = 对侧最近的流动性（前高 / 等高 / 昨高），没有就 3R。
//   B 区间高抛低吸（Brooks TR / 缠论中枢）
//     区间 = 最近两个已确认高点、两个已确认低点各自对齐（差 ≤ max(0.6ATR, 20% 区间宽)），宽 ≥ 3ATR；
//     收盘跑出区间 0.5ATR 即失效。下沿 1/4 内出现有力度的阳线（收在振幅上 40%）做多，上沿镜像做空；
//     中间不做。止损 = 区间外 0.2ATR；TP1 = 区间中线；TP2 = 对边内侧 10%。做过一次后要回到中线才再做同一边。
//   C 顺势回调（ICT OTE / Brooks H2，等同结构策略 + 回调深度过滤）
//     大周期方向 = side 时，小周期出现同向 BOS/CHoCH；回调深度 = (被突破高点 - 回调低点) / 上一段推动，
//     要求 ≥ 0.5（进入折价区）且回调没有跌破推动起点。止损 = 回调极值外 0.1ATR（这里被破 = 结构反转）；
//     TP1 = 1R，TP2 = 3R。
//
// 共振分（0-100，只做显示，回测里另行检验是否有用）：大周期同向 +20、成交量 ≥1.5 倍 +15、
//   RSI（A：刺穿时 ≤35 / ≥65 或背离；C：回调到 40~60）+15、主动成交同向 +10、近 5 根同向 FVG +10、
//   伦敦 / 纽约时段 +10、等高等低或昨日高低 +10，基础 10。
//
// ⚠️ 所有阈值是网上通行的经验值，回测结论见 quant/src/experiments/15_setups.js 和 README。
import { Structure as S } from "./structure.js";
import { StructStrat } from "./structstrat.js";
import { TA } from "./indicators.js";

export const Setups = (() => {
  const DEFAULTS = {
    kinds: { A: true, B: true, C: true },
    sweepPen: 0.05, maxDepth: 1.5, reclaimBars: 3, reclaimQ: 0.5,
    eqTol: 0.15, poolsPerSide: 10,
    rangeTolAtr: 0.6, rangeTolW: 0.2, rangeMinAtr: 3, edgeFrac: 0.25, rangeQ: 0.6,
    cMinRetr: 0.5, cMaxRetr: 1.0, cDisp: false,
    slBuf: 0.1, bSlBuf: 0.2, minRiskAtr: 0.3, maxRiskAtr: 3,
    htfFilterA: true, htfFilterB: false,
    tp2R: 3, maxTp2R: 6, maxBars: 96, minScore: 0,
  };
  const NAMES = { A: "扫流动性收回", B: "区间高抛低吸", C: "顺势回调" };
  const killzone = (t) => { const h = new Date(t * 1000).getUTCHours(); return (h >= 7 && h < 10) || (h >= 12 && h < 16); };

  // k: 已收盘K线（时间升序）；hk: 大周期已收盘K线（定方向用，可空）
  function detect(k, sec, hk = null, hsec = 0, params = {}) {
    const p = { ...DEFAULTS, ...params, kinds: { ...DEFAULTS.kinds, ...(params.kinds ?? {}) } };
    const n = k.length;
    const out = { events: [], pools: { L: [], H: [] }, range: null, fvgs: [], obs: [], atrNow: NaN, bias: 0, p };
    if (n < 40) return out;
    const atr = S.atrOf(k, 14);
    const { swings } = S.zigzag(k, atr, p.mult ?? S.MULT[sec] ?? 2.2, sec);
    const { events: brk } = S.breaks(k, swings, sec);
    const close = k.map((x) => x.close), rsi = TA.rsi(close, 14), vma = TA.sma(k.map((x) => x.volume), 20);
    const bias = hk?.length > 30 ? StructStrat.htfBiasFn(hk, hsec) : () => 0;
    const swIdx = new Map(swings.map((s, i) => [s, i]));
    const pools = { L: [], H: [] }, conf = [];
    let sp = 0, bp = 0, range = null, day = -1, dH = -Infinity, dL = Infinity, b = 0;
    const fvgs = [], obs = [], busy = { A: -1, B: -1, C: -1 };
    const intraday = sec < 86400;

    const addPool = (side, price, i, time, src, tol) => {
      const arr = pools[side];
      const m = src === "swing" ? arr.find((q) => q.src !== "pd" && Math.abs(q.price - price) <= tol) : null;
      if (m) { m.eq = true; m.n++; m.price = side === "L" ? Math.min(m.price, price) : Math.max(m.price, price); m.lastI = i; return; }
      arr.push({ side, price, i, lastI: i, time, src, eq: false, n: 1, brI: -1, brExt: NaN });
      if (arr.length > p.poolsPerSide) { const r = arr.findIndex((q) => q.src !== "pd"); arr.splice(r < 0 ? 0 : r, 1); }
    };
    const poolName = (q) => (q.src === "pd" ? (q.side === "L" ? "昨低" : "昨高") : q.eq ? (q.side === "L" ? "等低" : "等高") : q.side === "L" ? "前低" : "前高");

    function score(kind, d, j, extra) {
      const it = [];
      const add = (ok, pts, label) => { if (ok) it.push([pts, label]); };
      add(b === d, 20, "大周期同向");
      add(vma[j] > 0 && k[j].volume >= 1.5 * vma[j], 15, "放量");
      if (kind === "A" || kind === "B") add(extra.rsiOk, 15, extra.rsiTxt ?? "RSI");
      if (kind === "C") add(rsi[extra.extI] >= 40 && rsi[extra.extI] <= 60, 15, "回调 RSI 40~60");
      add(k[j].volume > 0 && ((2 * (k[j].takerBuy ?? k[j].volume / 2)) / k[j].volume - 1) * d > 0.1, 10, "主动成交同向");
      add(fvgs.some((f) => f.dir === d && f.i >= j - 5), 10, "同向 FVG");
      add(intraday && killzone(k[j].time + sec), 10, "伦敦/纽约时段");
      add(extra.liq, 10, "等高等低/昨日高低");
      return { score: 10 + it.reduce((a, x) => a + x[0], 0), items: it.map((x) => x[1]) };
    }
    function emit(kind, d, j, entry, sl, tp1, tp2, info) {
      if (!p.kinds[kind] || j <= busy[kind]) return false;
      const risk = (entry - sl) * d, a = atr[j];
      if (!(risk >= p.minRiskAtr * a) || risk > p.maxRiskAtr * a) return false;
      if ((tp2 - entry) * d < 1.2 * risk || (tp1 - entry) * d < 0.4 * risk) return false;
      const sc = score(kind, d, j, info);
      if (sc.score < p.minScore) return false;
      const ev = { kind, name: NAMES[kind], side: d, j, time: k[j].time, entry, sl, risk, riskAtr: risk / a, tp1, tp2, ...info, ...sc, bias: b, maker: false };
      Object.assign(ev, simulate(k, ev, p));
      busy[kind] = ev.exitI;
      out.events.push(ev);
      return true;
    }
    // TP2：对侧最近的流动性（1.5R 以外、maxTp2R 以内），没有就 tp2R
    const target = (d, entry, risk) => {
      let best = null;
      for (const q of pools[d > 0 ? "H" : "L"]) {
        const dist = (q.price - entry) * d;
        if (dist >= 1.5 * risk && dist <= p.maxTp2R * risk && (!best || dist < (best - entry) * d)) best = q.price;
      }
      return best ?? entry + d * p.tp2R * risk;
    };

    for (let j = 1; j < n; j++) {
      const x = k[j], a = atr[j];
      if (!isFinite(a)) continue;
      // 1. 新确认的摆动点（第 ci 根收盘确认，第 ci+1 根起可用）→ 流动性池 + 区间
      let swNew = false;
      while (sp < swings.length && swings[sp].ci < j) {
        const s = swings[sp++];
        conf.push(s); swNew = true;
        addPool(s.type, s.price, s.i, s.time, "swing", p.eqTol * atr[s.ci]);
      }
      if (swNew && conf.length >= 4) {
        const last = conf.slice(-4), Hs = last.filter((s) => s.type === "H"), Ls = last.filter((s) => s.type === "L");
        if (Hs.length === 2 && Ls.length === 2) {
          const top = Math.max(Hs[0].price, Hs[1].price), bot = Math.min(Ls[0].price, Ls[1].price), w = top - bot;
          const tol = Math.max(p.rangeTolAtr * a, p.rangeTolW * w);
          const ok = w >= p.rangeMinAtr * a && Math.abs(Hs[0].price - Hs[1].price) <= tol && Math.abs(Ls[0].price - Ls[1].price) <= tol
            && Math.min(Hs[0].price, Hs[1].price) > Math.max(Ls[0].price, Ls[1].price);
          if (ok) {
            const from = last[0];
            let inside = true;
            for (let m = from.i; m < j; m++) if (k[m].close > top + 0.5 * atr[m] || k[m].close < bot - 0.5 * atr[m]) { inside = false; break; }
            if (inside && (!range || range.top !== top || range.bot !== bot)) range = { top, bot, mid: (top + bot) / 2, w, from: from.time, fromI: from.i, sinceI: j, armL: true, armS: true };
          }
        }
      }
      // 2. 昨日高低（日内周期）。新的一天开始时上一天的高低点生效
      if (intraday) {
        const dd = Math.floor(x.time / 86400);
        if (dd !== day) {
          if (day >= 0) {
            for (const s of ["L", "H"]) pools[s] = pools[s].filter((q) => q.src !== "pd");
            addPool("H", dH, j - 1, x.time - 86400, "pd", 0);
            addPool("L", dL, j - 1, x.time - 86400, "pd", 0);
          }
          day = dd; dH = x.high; dL = x.low;
        } else { dH = Math.max(dH, x.high); dL = Math.min(dL, x.low); }
      }
      b = bias(x.time + sec);
      // 3. A：扫流动性收回
      const firedA = { 1: false, "-1": false };
      for (const side of ["L", "H"]) {
        const d = side === "L" ? 1 : -1, cand = [];
        for (const q of pools[side]) {
          if (q.lastI >= j) continue;
          const pen = (q.price - (d > 0 ? x.low : x.high)) * d;
          const back = (x.close - q.price) * d > 0;
          if (q.brI < 0) {
            if (pen <= p.sweepPen * a) continue;
            if (pen > p.maxDepth * a) { q.dead = true; continue; }
            if (back) { q.dead = true; cand.push([q, d > 0 ? x.low : x.high]); }
            else { q.brI = j; q.brExt = d > 0 ? x.low : x.high; }
          } else {
            q.brExt = d > 0 ? Math.min(q.brExt, x.low) : Math.max(q.brExt, x.high);
            if ((q.price - q.brExt) * d > p.maxDepth * a || j - q.brI > p.reclaimBars) { q.dead = true; continue; }
            if (back) { q.dead = true; cand.push([q, q.brExt]); }
          }
        }
        pools[side] = pools[side].filter((q) => !q.dead);
        if (!cand.length) continue;
        const rng = x.high - x.low || 1e-12;
        const strong = d > 0 ? (x.close - x.low) / rng >= p.reclaimQ : (x.high - x.close) / rng >= p.reclaimQ;
        if (!strong) continue;
        if (p.htfFilterA && b === -d) continue;
        // 同一根扫了多个价位：取最"重"的（等低/昨低优先，其次最远的那个）
        cand.sort((u, v) => (v[0].eq || v[0].src === "pd") - (u[0].eq || u[0].src === "pd") || (u[0].price - v[0].price) * d);
        const [q, ext] = cand[0];
        const entry = x.close, sl = ext - d * p.slBuf * a, risk = (entry - sl) * d;
        // RSI：刺穿时超卖/超买，或和上一个同类摆动点比背离（价格更低、RSI 更高）
        let extI = j; for (let m = j; m >= Math.max(0, j - p.reclaimBars); m--) if ((d > 0 ? k[m].low : k[m].high) === ext) { extI = m; break; }
        const div = rsi[extI] * d > rsi[q.i] * d && (ext - q.price) * d < 0;
        const rsiOk = (d > 0 ? rsi[extI] <= 35 : rsi[extI] >= 65) || div;
        const ok = emit("A", d, j, entry, sl, entry + d * risk, target(d, entry, risk), {
          level: { price: q.price, name: poolName(q), time: q.time }, ext, extI, rsiOk, rsiTxt: div ? "RSI 背离" : "RSI 超卖/超买", liq: q.eq || q.src === "pd",
          inRange: !!range && (d > 0 ? Math.abs(q.price - range.bot) : Math.abs(q.price - range.top)) <= 0.25 * range.w,
        });
        firedA[d] = ok;
      }
      // 4. FVG（第 j 根收盘确认）与回补
      if (j >= 2) {
        if (x.low > k[j - 2].high && x.low - k[j - 2].high >= 0.3 * a) fvgs.push({ dir: 1, top: x.low, bot: k[j - 2].high, i: j, time: k[j - 1].time, touched: false });
        if (x.high < k[j - 2].low && k[j - 2].low - x.high >= 0.3 * a) fvgs.push({ dir: -1, top: k[j - 2].low, bot: x.high, i: j, time: k[j - 1].time, touched: false });
        for (let f = fvgs.length - 1; f >= 0; f--) {
          const g = fvgs[f];
          if (g.i === j) continue;
          if (g.dir > 0 ? x.low <= g.top : x.high >= g.bot) g.touched = true;
          if (g.dir > 0 ? x.close < g.bot : x.close > g.top) fvgs.splice(f, 1);
        }
        if (fvgs.length > 30) fvgs.splice(0, fvgs.length - 30);
      }
      // 5. 区间：收盘跑出 0.5ATR 失效；B 高抛低吸
      if (range && (x.close > range.top + 0.5 * a || x.close < range.bot - 0.5 * a)) range = null;
      if (range && range.sinceI <= j) {
        const R = range, rng = x.high - x.low || 1e-12;
        if (x.close >= R.mid) R.armL = true;
        if (x.close <= R.mid) R.armS = true;
        for (const d of [1, -1]) {
          if (firedA[d] || !(d > 0 ? R.armL : R.armS)) continue;
          if (p.htfFilterB && b === -d) continue;
          const atEdge = d > 0 ? x.low <= R.bot + p.edgeFrac * R.w : x.high >= R.top - p.edgeFrac * R.w;
          const strong = d > 0 ? x.close > x.open && (x.close - x.low) / rng >= p.rangeQ : x.close < x.open && (x.high - x.close) / rng >= p.rangeQ;
          const notMid = d > 0 ? x.close < R.mid - 0.1 * R.w : x.close > R.mid + 0.1 * R.w;
          if (!atEdge || !strong || !notMid) continue;
          const entry = x.close, sl = (d > 0 ? Math.min(x.low, R.bot) : Math.max(x.high, R.top)) - d * p.bSlBuf * a;
          const tp2 = d > 0 ? R.top - 0.1 * R.w : R.bot + 0.1 * R.w;
          const rsiOk = d > 0 ? rsi[j] <= 40 : rsi[j] >= 60;
          if (emit("B", d, j, entry, sl, R.mid, tp2, { range: { top: R.top, bot: R.bot, from: R.from }, rsiOk, rsiTxt: "RSI 偏低/偏高", liq: false, extI: j })) {
            if (d > 0) R.armL = false; else R.armS = false;
          }
        }
      }
      // 6. 结构突破 → OB + C 顺势回调
      while (bp < brk.length && brk[bp].j < j) bp++;
      while (bp < brk.length && brk[bp].j === j) {
        const e = brk[bp++], d = e.dir;
        // OB：突破之前最后一根反向K线
        for (let m = j - 1; m >= Math.max(e.from.i, j - 30); m--) {
          if (d > 0 ? k[m].close < k[m].open : k[m].close > k[m].open) { obs.push({ dir: d, top: k[m].high, bot: k[m].low, i: m, time: k[m].time, j }); break; }
        }
        if (b !== d) continue;
        const si = swIdx.get(e.from), L0 = si > 0 ? swings[si - 1] : null;
        if (!L0 || L0.type === e.from.type) continue;
        let ext = d > 0 ? Infinity : -Infinity, extI = e.from.i;
        for (let m = e.from.i; m <= j; m++) { const v = d > 0 ? k[m].low : k[m].high; if (d > 0 ? v < ext : v > ext) { ext = v; extI = m; } }
        const leg = (e.from.price - L0.price) * d;
        if (!(leg > 0)) continue;
        const retr = (e.from.price - ext) * d / leg;
        if (retr < p.cMinRetr || retr > p.cMaxRetr) continue;
        if (p.cDisp && !(Math.abs(x.close - x.open) >= 0.8 * a || fvgs.some((f) => f.dir === d && f.i >= j - 2))) continue;
        const entry = x.close, sl = ext - d * p.slBuf * a, risk = (entry - sl) * d;
        emit("C", d, j, entry, sl, entry + d * risk, entry + d * p.tp2R * risk, { brk: { kind: e.kind, price: e.price, time: e.from.time }, retr, ext, extI, liq: false });
      }
      for (let o = obs.length - 1; o >= 0; o--) { const g = obs[o]; if (g.j < j && (g.dir > 0 ? x.close < g.bot : x.close > g.top)) obs.splice(o, 1); }
      if (obs.length > 12) obs.splice(0, obs.length - 12);
    }
    out.pools = pools; out.range = range; out.fvgs = fvgs; out.obs = obs; out.atrNow = atr[n - 1]; out.bias = b; out.swings = swings;
    return out;
  }

  // 出场：TP1 平一半、止损移保本；剩余到 TP2；maxBars 时间止损。同一根同时碰到止损和止盈按止损算。
  // legs 格式和 StructStrat.cost 一致：[份额, 是否挂单成交]（止盈是挂单，止损 / 超时是吃单）
  function simulate(k, ev, p) {
    const n = k.length, d = ev.side, R = ev.risk;
    let stop = ev.sl, half = false, r = 0;
    const legs = [], end = Math.min(n - 1, ev.j + p.maxBars);
    const rOf = (px) => ((px - ev.entry) * d) / R;
    for (let m = ev.j + 1; m <= end; m++) {
      const x = k[m];
      if (d > 0 ? x.low <= stop : x.high >= stop) {
        const px = (d > 0 ? x.open < stop : x.open > stop) ? x.open : stop, share = half ? 0.5 : 1;
        r += share * rOf(px); legs.push([share, false]);
        return { r, exitI: m, barsHeld: m - ev.j, exitType: half ? "be" : "stop", legs, hitTp1: half };
      }
      if (!half && (d > 0 ? x.high >= ev.tp1 : x.low <= ev.tp1)) { r += 0.5 * rOf(ev.tp1); legs.push([0.5, true]); half = true; stop = ev.entry; continue; }
      if (half && (d > 0 ? x.high >= ev.tp2 : x.low <= ev.tp2)) { r += 0.5 * rOf(ev.tp2); legs.push([0.5, true]); return { r, exitI: m, barsHeld: m - ev.j, exitType: "tp2", legs, hitTp1: true }; }
    }
    const share = half ? 0.5 : 1;
    r += share * rOf(k[end].close); legs.push([share, false]);
    const open = end === n - 1 && end < ev.j + p.maxBars;
    return { r, exitI: end, barsHeld: end - ev.j, exitType: open ? "open" : "time", legs, open, hitTp1: half, stop };
  }

  return { detect, simulate, DEFAULTS, NAMES, killzone };
})();
export default Setups;
