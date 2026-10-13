// 支撑 / 压力位：纯K线摆动高低点 + 前一日高低点，聚类成价格区
// 严格无未来函数：在第 i 根K线上只使用当时已确认的摆动点
const Levels = (() => {
  // 摆动点：第 j 根的高点是前后 n 根中最高 → 摆动高点，要等到 j+n 根收盘才确认
  function pivots(k, n, barSec, weight, src) {
    const out = [];
    for (let j = n; j < k.length - n; j++) {
      let isH = true, isL = true;
      for (let m = j - n; m <= j + n; m++) {
        if (m === j) continue;
        if (k[m].high >= k[j].high) isH = false;
        if (k[m].low <= k[j].low) isL = false;
      }
      const confirmTime = k[j + n].time + barSec;
      if (isH) out.push({ price: k[j].high, time: k[j].time, confirmTime, type: "H", weight, src });
      if (isL) out.push({ price: k[j].low, time: k[j].time, confirmTime, type: "L", weight, src });
    }
    return out;
  }

  // 按 UTC 日统计的日内高低点（用前一天的，作为强位置）
  function dailyHL(k) {
    const days = new Map();
    for (const x of k) {
      const d = Math.floor(x.time / 86400);
      const v = days.get(d);
      if (!v) days.set(d, { high: x.high, low: x.low });
      else { v.high = Math.max(v.high, x.high); v.low = Math.min(v.low, x.low); }
    }
    return days;
  }

  // 预计算：返回一个上下文，之后可以对任意时间点查询当时的价位
  function prepare(ltfK, htfK) {
    const all = [...pivots(ltfK, 5, 900, 1, "15m"), ...pivots(htfK, 3, 3600, 2, "1h")];
    all.sort((a, b) => a.confirmTime - b.confirmTime);
    return { pivots: all, daily: dailyHL(ltfK), cache: new Map() };
  }

  // 第 i 根K线收盘时可见的价位区（聚类后），tol 为合并距离（价格单位）
  function at(ctx, closeTime, tol) {
    const key = closeTime;
    if (ctx.cache.has(key)) return ctx.cache.get(key);
    const pts = [];
    for (const p of ctx.pivots) {
      if (p.confirmTime > closeTime) break;
      const age = closeTime - p.time;
      if (p.src === "15m" && age > 3 * 86400) continue; // 15m 摆动点看 3 天
      if (p.src === "1h" && age > 10 * 86400) continue; // 1h 摆动点看 10 天
      pts.push(p);
    }
    const prevDay = ctx.daily.get(Math.floor(closeTime / 86400) - 1);
    if (prevDay) {
      pts.push({ price: prevDay.high, type: "H", weight: 2, src: "昨高" });
      pts.push({ price: prevDay.low, type: "L", weight: 2, src: "昨低" });
    }
    pts.sort((a, b) => a.price - b.price);
    const levels = [];
    let cur = null;
    for (const p of pts) {
      if (cur && p.price - cur.maxP <= tol) {
        cur.sumPW += p.price * p.weight; cur.strength += p.weight; cur.touches++; cur.maxP = p.price;
        if (p.src === "昨高" || p.src === "昨低") cur.tags.add(p.src);
      } else {
        cur = { sumPW: p.price * p.weight, strength: p.weight, touches: 1, minP: p.price, maxP: p.price, tags: new Set() };
        if (p.src === "昨高" || p.src === "昨低") cur.tags.add(p.src);
        levels.push(cur);
      }
    }
    const out = levels
      .map((l) => ({ price: l.sumPW / l.strength, strength: l.strength, touches: l.touches, lo: l.minP, hi: l.maxP, tags: [...l.tags] }))
      .filter((l) => l.strength >= 2); // 至少一个 1h 摆动点 / 两次 15m 触及 / 昨日高低
    if (ctx.cache.size > 5000) ctx.cache.clear();
    ctx.cache.set(key, out);
    return out;
  }

  // 价格上方最近的压力 / 下方最近的支撑（gap 以外）
  function nearest(levels, price, gap) {
    let res = null, sup = null;
    for (const l of levels) {
      if (l.price > price + gap && (!res || l.price < res.price)) res = l;
      if (l.price < price - gap && (!sup || l.price > sup.price)) sup = l;
    }
    return { res, sup };
  }

  // 日线级别关键位：日线摆动点（左右各 2 天）聚类，看近 90 天；只用已收盘的日K
  // 仅用于显示，不参与止损计算
  function daily(d1k, nowSec) {
    const k = d1k.filter((x) => x.time + 86400 <= nowSec);
    if (k.length < 10) return [];
    const recent = k.slice(-90);
    const pts = [];
    const n = 2;
    for (let j = n; j < recent.length - n; j++) {
      let isH = true, isL = true;
      for (let m = j - n; m <= j + n; m++) {
        if (m === j) continue;
        if (recent[m].high >= recent[j].high) isH = false;
        if (recent[m].low <= recent[j].low) isL = false;
      }
      if (isH) pts.push(recent[j].high);
      if (isL) pts.push(recent[j].low);
    }
    // 近 7 日高低点
    const lastWeek = k.slice(-7);
    pts.push(Math.max(...lastWeek.map((x) => x.high)), Math.min(...lastWeek.map((x) => x.low)));
    const tr = recent.slice(-14).map((x) => x.high - x.low);
    const tol = (tr.reduce((a, b) => a + b, 0) / tr.length) * 0.25;
    pts.sort((a, b) => a - b);
    const out = [];
    for (const p of pts) {
      const cur = out[out.length - 1];
      if (cur && p - cur.hi <= tol) { cur.sum += p; cur.touches++; cur.hi = p; }
      else out.push({ sum: p, touches: 1, lo: p, hi: p });
    }
    return out.map((c) => ({ price: c.sum / c.touches, touches: c.touches, lo: c.lo, hi: c.hi }));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 以下为 MTF 版新增（显示层）。全部只用已收盘K，无未来函数。
  //
  // ⚠️ 重要：这一节的阈值（权重、回看天数、tol 系数、ER 阈值）都是**拍的，没有回测
  // 验证过**。和上面 testState / rejection 那些带回测数字的注释不是一个性质。
  // 它们只用于在图上画出来辅助人工判断，不参与信号、不参与止损。
  // 要把其中任何一项变成过滤条件，必须先过 walk-forward（见 quant/ 实验框架：
  // 11 个滚动窗口上，对这套策略做参数优化的结果比固定参数更差 0.015R）。
  // ───────────────────────────────────────────────────────────────────────────

  // 高周期关键位：4h + 日线摆动点合并聚类。
  // 相比原来的 daily()，多了 4h 这一层 —— 原项目止损只用 15m/1h 位，
  // 4h 这个粒度正好是"比 1h 硬、又比日线贴近当前价"的那一档。
  // 权重：4h 摆动点 3，日线摆动点 5，近 7 日高低 5（和 strength ≥ 5 的"强位"口径对齐）
  function htf(h4k, d1k, nowSec) {
    const pts = [];
    // time = 该摆动点所在K线的时间；聚类后 from = 最早那个点，用来决定这条线从哪开始画
    const push = (price, weight, src, time) => pts.push({ price, weight, src, time });

    // 4h：左右各 3 根（前后 12 小时都没更高/更低），看近 60 天
    const h4 = (h4k || []).filter((x) => x.time + 4 * 3600 <= nowSec).slice(-360);
    for (let j = 3; j < h4.length - 3; j++) {
      let isH = true, isL = true;
      for (let m = j - 3; m <= j + 3; m++) {
        if (m === j) continue;
        if (h4[m].high >= h4[j].high) isH = false;
        if (h4[m].low <= h4[j].low) isL = false;
      }
      if (isH) push(h4[j].high, 3, "4h", h4[j].time);
      if (isL) push(h4[j].low, 3, "4h", h4[j].time);
    }

    // 日线：左右各 2 根，看近 180 天
    const d1 = (d1k || []).filter((x) => x.time + 86400 <= nowSec).slice(-180);
    for (let j = 2; j < d1.length - 2; j++) {
      let isH = true, isL = true;
      for (let m = j - 2; m <= j + 2; m++) {
        if (m === j) continue;
        if (d1[m].high >= d1[j].high) isH = false;
        if (d1[m].low <= d1[j].low) isL = false;
      }
      if (isH) push(d1[j].high, 5, "日线", d1[j].time);
      if (isL) push(d1[j].low, 5, "日线", d1[j].time);
    }
    if (d1.length >= 7) {
      const w = d1.slice(-7);
      const hiBar = w.reduce((a, x) => (x.high > a.high ? x : a)), loBar = w.reduce((a, x) => (x.low < a.low ? x : a));
      push(hiBar.high, 5, "周高", hiBar.time);
      push(loBar.low, 5, "周低", loBar.time);
    }
    if (!pts.length) return [];

    // 合并容差用日线真实波幅，比用 15m ATR 宽得多 —— 高周期位本来就该是"区"而不是"线"
    const base = d1.length >= 14 ? d1.slice(-14) : d1;
    const tol = base.reduce((a, x) => a + (x.high - x.low), 0) / base.length * 0.3;
    // 簇总宽度上限。只看"相邻间隔 ≤ tol"会产生链式合并：密集的摆动点一个接一个串下去，
    // 最后糊出一个占价格 20% 的"价位"。实测加入 4h 点后每个品种都会出现一个
    // strength 300+、宽 12~14 倍 tol 的巨簇。所以再加一条总宽度约束。
    const maxWidth = tol * 1.5;

    pts.sort((a, b) => a.price - b.price);
    const out = [];
    let cur = null;
    for (const p of pts) {
      if (cur && p.price - cur.hi <= tol && p.price - cur.lo <= maxWidth) {
        cur.sumPW += p.price * p.weight; cur.strength += p.weight; cur.touches++; cur.hi = p.price;
        cur.srcs.add(p.src); cur.from = Math.min(cur.from, p.time);
      } else {
        cur = { sumPW: p.price * p.weight, strength: p.weight, touches: 1, lo: p.price, hi: p.price, srcs: new Set([p.src]), from: p.time };
        out.push(cur);
      }
    }
    return out.map((c) => ({
      // 钳位：单点簇的 p*w/w 有浮点误差（实测 2.8e-14），会让 price 掉到 [lo,hi] 外
      price: Math.min(c.hi, Math.max(c.lo, c.sumPW / c.strength)),
      strength: c.strength, touches: c.touches,
      lo: c.lo, hi: c.hi, srcs: [...c.srcs],
      from: c.from, // 最早的摆动点时间：这个位从这时才开始存在
      // 日线/周高低参与过的位 = 硬位；纯 4h 堆出来的 = 软位
      hard: c.srcs.has("日线") || c.srcs.has("周高") || c.srcs.has("周低"),
    }));
  }

  // 线性回归通道：对 log(收盘价) 做最小二乘，中轴 ± mult 倍残差标准差。
  // 用回归而不是手连趋势线，是因为手连趋势线要选锚点 —— 换两个点整条线就变了，
  // 不可复现也无法回测。回归通道是确定性的：给定 K 线和窗口长度，结果唯一。
  // 取 log 价格使通道上下在百分比意义上等宽（线性价格会让下沿被压扁）。
  //
  // 自变量用**真实时间（天）**而不是K线序号，这样才能把日线/4h 的通道求值到
  // 15m 图的时间点上画出来（序号回归没法跨周期投影），顺带也不怕数据缺口。
  // 对一段K线做 log 收盘价的最小二乘拟合，返回纯参数（不含 points，便于逐根滚动时复用）
  function fitLog(w) {
    const N = w.length;
    if (N < 10) return null;
    const t0 = w[0].time;
    let xs = 0, ys = 0;
    const x = new Array(N), y = new Array(N);
    for (let i = 0; i < N; i++) { x[i] = (w[i].time - t0) / 86400; y[i] = Math.log(w[i].close); xs += x[i]; ys += y[i]; }
    const xm = xs / N, ym = ys / N;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < N; i++) { sxy += (x[i] - xm) * (y[i] - ym); sxx += (x[i] - xm) ** 2; }
    if (sxx === 0) return null;
    const b = sxy / sxx, a = ym - b * xm;
    let ssr = 0, sst = 0;
    for (let i = 0; i < N; i++) { const f = a + b * x[i]; ssr += (y[i] - f) ** 2; sst += (y[i] - ym) ** 2; }
    return { t0, a, b, sigma: Math.sqrt(ssr / Math.max(1, N - 2)), r2: sst > 0 ? 1 - ssr / sst : 0, from: w[0].time, to: w[N - 1].time, n: N };
  }
  // 拟合参数在任意时刻求值
  function evalFit(f, timeSec, mult = 2) {
    const v = f.a + f.b * ((timeSec - f.t0) / 86400);
    return { mid: Math.exp(v), up: Math.exp(v + mult * f.sigma), dn: Math.exp(v - mult * f.sigma) };
  }

  function channel(k, n, mult = 2) {
    const w = (k || []).slice(-n);
    const f = fitLog(w);
    if (!f) return null;
    // 在任意时间点求通道三条线的价格。超出拟合窗口就是外推，调用方自己决定外推多远。
    const lineAt = (timeSec) => evalFit(f, timeSec, mult);
    return {
      lineAt,
      points: w.map((b) => ({ time: b.time, ...lineAt(b.time) })),
      r2: f.r2,                                         // 拟合度：越高说明"趋势"这个描述越贴合
      pctPerDay: (Math.exp(f.b) - 1) * 100,             // 中轴日斜率（%）
      bandPct: (Math.exp(mult * f.sigma) - 1) * 100,    // 通道半宽（%）
      slopeUp: f.b > 0,
      from: f.from, to: f.to,
      n: f.n,
    };
  }

  // ── 逐根滚动版本（无未来函数）─────────────────────────────────────────────
  // channel() / regime() 给出的是"此刻"的结构：用截至现在的 n 根拟合。把它画满整张图，
  // 历史那一段的线就是用后来的数据画出来的（重绘）—— 图上"价格刚好在下轨反弹"，
  // 是因为这条线本来就是用那些反弹点拟合的，当时并不存在。
  //
  // 下面两个函数在第 i 根收盘时只用 [i-n+1, i] 这 n 根，validFrom = 这根的收盘时刻，
  // 表示"从这一刻起才知道这个结果"。任何周期的图表上，某根K线收盘时能看到的，
  // 就是 validFrom ≤ 该收盘时刻的最后一个结果。
  function channelFits(k, n, barSec) {
    const out = [];
    if (!k || k.length < n) return out;
    for (let i = n - 1; i < k.length; i++) {
      const f = fitLog(k.slice(i - n + 1, i + 1));
      if (f) out.push({ ...f, validFrom: k[i].time + barSec, i });
    }
    return out;
  }
  function regimeFits(k, n, barSec, erThreshold = 0.35) {
    const out = [];
    if (!k || k.length < n) return out;
    for (let i = n - 1; i < k.length; i++) {
      const r = regime(k.slice(i - n + 1, i + 1), n, erThreshold);
      if (r) out.push({ ...r, validFrom: k[i].time + barSec, i });
    }
    return out;
  }
  // 在 fits（按 validFrom 升序）里找 validFrom ≤ t 的最后一个；二分
  function asOf(fits, t) {
    let lo = 0, hi = fits.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (fits[m].validFrom <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans >= 0 ? fits[ans] : null;
  }

  // 趋势 / 震荡判定。用 Kaufman 效率比（净位移 / 路径总长）：
  //   ER → 1 单边走，ER → 0 来回磨。比 ADX 直观，而且没有 ADX 的平滑滞后。
  // 震荡时给出 Donchian 上下沿作为区间边界。
  // 阈值 0.35 是拍的，没验证过（见本节开头警告）。
  function regime(k, n, erThreshold = 0.35) {
    const w = (k || []).slice(-n);
    if (w.length < 10) return null;
    let path = 0;
    for (let i = 1; i < w.length; i++) path += Math.abs(w[i].close - w[i - 1].close);
    const net = Math.abs(w[w.length - 1].close - w[0].close);
    const er = path > 0 ? net / path : 0;
    const hi = Math.max(...w.map((x) => x.high)), lo = Math.min(...w.map((x) => x.low));
    const mid = (hi + lo) / 2;
    return {
      er,
      trending: er >= erThreshold,
      hi, lo, mid,
      widthPct: mid > 0 ? (hi - lo) / mid * 100 : 0,
      up: w[w.length - 1].close > w[0].close,
      n: w.length,
    };
  }

  // 判定"碰到价位"用的窄区间：画线位置上下 0.4 ATR（聚类区可能很宽，不能直接用）
  const zone = (L, atr) => ({ lo: Math.max(L.lo, L.price - 0.4 * atr), hi: Math.min(L.hi, L.price + 0.4 * atr) });

  // 价位在第 i 根K线收盘时的测试状态：最近 6 根里有几根碰到过
  // 回测（16 个品种 90 天）：★★★ 首次测试时 3 小时内被突破约 26%，之前磨过的约 40%
  function testState(L0, k, i, atr) {
    const L = { ...L0, ...zone(L0, atr) };
    const isRes = L.price > k[i].close;
    const edge = isRes ? L.lo - 0.1 * atr : L.hi + 0.1 * atr;
    let tests = 0;
    for (let m = Math.max(0, i - 5); m <= i; m++) if (isRes ? k[m].high >= edge : k[m].low <= edge) tests++;
    return { isRes, tests };
  }

  // 第 i 根K线是否在强价位（★★★）出现"拒绝"：触及价位区、影线 ≥ 50%、收盘收回区内
  // 回测：★★★ 首次测试 + 长影线收回，之后 3 小时内被突破的只有约 10%（随机价位同样形态约 19%）
  function rejection(lv, k, i, atr) {
    const b = k[i], pc = k[i - 1].close, rng = b.high - b.low || 1e-9;
    for (const L0 of lv) {
      if (L0.strength < 5) continue;
      const L = { ...L0, ...zone(L0, atr) };
      let side = 0;
      if (L.price > pc && b.high >= L.lo - 0.1 * atr && b.close < L.lo && (b.high - Math.max(b.open, b.close)) / rng >= 0.5) side = 1;
      else if (L.price < pc && b.low <= L.hi + 0.1 * atr && b.close > L.hi && (Math.min(b.open, b.close) - b.low) / rng >= 0.5) side = -1;
      if (!side) continue;
      let prior = 0;
      for (let m = Math.max(0, i - 6); m < i; m++) if (side > 0 ? k[m].high >= L.lo - 0.1 * atr : k[m].low <= L.hi + 0.1 * atr) prior++;
      return { level: L0, isRes: side > 0, first: prior === 0, time: b.time, i };
    }
    return null;
  }

  return { prepare, at, nearest, daily, htf, channel, regime, channelFits, regimeFits, asOf, evalFit, testState, rejection };
})();
