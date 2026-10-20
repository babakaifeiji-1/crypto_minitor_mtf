// 价格结构引擎：所有画线（波段 / 支撑压力 / 趋势线 / 通道 / 中枢 / 波浪）共用同一套摆动点。
//
// 参考：
//   摆动点 + HH/HL + BOS/CHoCH ← joshyattridge/smart-money-concepts
//   中枢（笔中枢的生长规则）   ← waditu/czsc  get_zs_seq
//   趋势线（摆动点两两连线、按触碰次数打分、收盘穿越即失效）← ednunezg/pytrendline 的思路
//   波浪（在转折点序列上枚举，用三条铁律过滤、斐波那契打分）← drstevendev/ElliottWaveAnalyzer 的思路
//
// 无未来函数：
//   * 摆动点用 ATR ZigZag 逐根推进：价格从极值反向走出 mult×ATR 才确认，确认时刻 = 那根K线收盘。
//     已确认的摆动点、BOS/CHoCH 事件以后永远不会变（测试里有截断不变断言）。
//   * 趋势线、通道、中枢、波浪是"截至最后一根K线"的结构，只用已确认的摆动点 + 已收盘K线。
//     调用方只能传已收盘的K线进来；正在形成的那一段由 tentative 单独给出（虚线画）。
//
// ⚠️ 本文件所有阈值（ZigZag 倍数、容差、触碰数、打分权重）只经过形态层面的检查
// （test/structure_test.js），没有做过收益回测。只用于画图辅助人工判断，不参与信号和止损。
const Structure = (() => {
  // 各周期默认 ZigZag 倍数（× ATR14）。test/structure_test.js 在真实数据上统计过：
  // 这组倍数下每一笔平均约 10 根K线，图上 160 根左右的可视范围约 15 个转折点（各周期一致）
  const MULT = { 180: 2.4, 900: 2.2, 3600: 2.2, 14400: 2.2, 86400: 2.1 };

  function atrOf(k, n) {
    const out = new Array(k.length).fill(NaN);
    let s = 0;
    for (let i = 0; i < k.length; i++) {
      const tr = i === 0 ? k[i].high - k[i].low
        : Math.max(k[i].high - k[i].low, Math.abs(k[i].high - k[i - 1].close), Math.abs(k[i].low - k[i - 1].close));
      if (i < n) { s += tr; if (i === n - 1) out[i] = s / n; else out[i] = s / (i + 1); }
      else out[i] = (out[i - 1] * (n - 1) + tr) / n;
    }
    return out;
  }

  // ── 1. ATR ZigZag ─────────────────────────────────────────────────────────
  // 返回已确认的摆动点（高低交替）和最后一段未确认的走势 tentative
  function zigzag(k, atr, mult, barSec) {
    const sw = [];
    const n = k.length;
    if (!n) return { swings: sw, tentative: null };
    let dir = 0, hiI = 0, loI = 0, ext = 0;
    const push = (i, type, ci) => sw.push({ i, time: k[i].time, price: type === "H" ? k[i].high : k[i].low, type, ci, ct: k[ci].time + barSec });
    const argMin = (a, b) => { let m = a; for (let j = a + 1; j <= b; j++) if (k[j].low <= k[m].low) m = j; return m; };
    const argMax = (a, b) => { let m = a; for (let j = a + 1; j <= b; j++) if (k[j].high >= k[m].high) m = j; return m; };
    for (let i = 0; i < n; i++) {
      const th = mult * (isFinite(atr[i]) ? atr[i] : k[i].high - k[i].low);
      if (dir === 0) {
        if (k[i].high >= k[hiI].high) hiI = i;
        if (k[i].low <= k[loI].low) loI = i;
        if (hiI < i && k[hiI].high - k[i].low >= th && hiI > loI) { push(hiI, "H", i); dir = -1; ext = argMin(hiI + 1, i); }
        else if (loI < i && k[i].high - k[loI].low >= th && loI > hiI) { push(loI, "L", i); dir = 1; ext = argMax(loI + 1, i); }
        else if (hiI < i && loI < i && k[hiI].high - k[loI].low >= th) {
          // 起步阶段两个方向都够了：先出现的那个极值先确认
          if (hiI < loI) { push(hiI, "H", i); dir = -1; ext = argMin(hiI + 1, i); }
          else { push(loI, "L", i); dir = 1; ext = argMax(loI + 1, i); }
        }
      } else if (dir === 1) {
        if (k[i].high >= k[ext].high) ext = i;
        else if (k[ext].high - k[i].low >= th) { push(ext, "H", i); dir = -1; ext = argMin(ext + 1, i); }
      } else {
        if (k[i].low <= k[ext].low) ext = i;
        else if (k[i].high - k[ext].low >= th) { push(ext, "L", i); dir = 1; ext = argMax(ext + 1, i); }
      }
    }
    const tentative = dir === 0 ? null
      : { i: ext, time: k[ext].time, price: dir === 1 ? k[ext].high : k[ext].low, type: dir === 1 ? "H" : "L", tentative: true };
    // HH/HL/LH/LL：和上一个同类摆动点比较
    let lastH = null, lastL = null;
    for (const s of sw) {
      if (s.type === "H") { s.lab = lastH ? (s.price > lastH.price ? "HH" : "LH") : "H"; lastH = s; }
      else { s.lab = lastL ? (s.price > lastL.price ? "HL" : "LL") : "L"; lastL = s; }
    }
    return { swings: sw, tentative };
  }

  // ── 2. 结构突破：BOS（顺势突破前高/前低）/ CHoCH（逆势突破 = 结构转变）────────
  // 逐根推进，第 j 根只能用 ci < j 的摆动点（第 ci 根收盘才确认，下一根起可用）
  function breaks(k, swings, barSec) {
    const ev = [];
    let sp = 0, lastH = null, lastL = null, trend = 0;
    for (let j = 0; j < k.length; j++) {
      while (sp < swings.length && swings[sp].ci < j) {
        const s = swings[sp++];
        if (s.type === "H") lastH = { s, broken: false }; else lastL = { s, broken: false };
      }
      const c = k[j].close;
      if (lastH && !lastH.broken && c > lastH.s.price) {
        ev.push({ kind: trend >= 0 ? "BOS" : "CHoCH", dir: 1, j, time: k[j].time, ct: k[j].time + barSec, price: lastH.s.price, from: lastH.s });
        lastH.broken = true; trend = 1;
      }
      if (lastL && !lastL.broken && c < lastL.s.price) {
        ev.push({ kind: trend <= 0 ? "BOS" : "CHoCH", dir: -1, j, time: k[j].time, ct: k[j].time + barSec, price: lastL.s.price, from: lastL.s });
        lastL.broken = true; trend = -1;
      }
    }
    return { events: ev, trend };
  }

  // ── 3. 支撑压力区：摆动点按价格聚类 ──────────────────────────────────────────
  // 容差 0.6 ATR，簇总宽 ≤ 1.2 ATR（防止链式合并，原 levels.htf 踩过的坑）。
  // 每侧只挑 2 个：由近到远，触碰 ≥2 次的优先；最近的那个即使只碰过 1 次也保留（它就是最近的结构点）
  function zones(k, swings, atrNow, opt = {}) {
    const n = k.length, close = k[n - 1].close;
    const look = opt.lookback ?? 400, perSide = opt.perSide ?? 2, maxDist = (opt.maxDistAtr ?? 12) * atrNow;
    const pts = swings.filter((s) => s.i >= n - look).slice(-40);
    if (!pts.length) return { all: [], above: [], below: [] };
    const tol = 0.6 * atrNow, maxW = 1.2 * atrNow;
    const sorted = [...pts].sort((a, b) => a.price - b.price);
    const cl = [];
    let cur = null;
    for (const p of sorted) {
      if (cur && p.price - cur.hi <= tol && p.price - cur.lo <= maxW) {
        cur.pts.push(p); cur.hi = p.price;
      } else { cur = { lo: p.price, hi: p.price, pts: [p] }; cl.push(cur); }
    }
    const all = cl.map((c) => {
      const types = new Set(c.pts.map((p) => p.type));
      const lastI = Math.max(...c.pts.map((p) => p.i));
      const from = Math.min(...c.pts.map((p) => p.time));
      const price = c.pts.reduce((a, p) => a + p.price, 0) / c.pts.length;
      // 画出来的带至少 0.3 ATR 宽，单点簇不至于变成一根细线
      const half = Math.max((c.hi - c.lo) / 2, 0.15 * atrNow);
      const mid = (c.hi + c.lo) / 2;
      return {
        price, lo: mid - half, hi: mid + half, touches: c.pts.length, from, lastI,
        flip: types.size === 2, // 高点低点都在这里出现过 = 支撑压力互换位，通常更硬
        score: c.pts.length + (types.size === 2 ? 1 : 0) + (lastI >= n - 100 ? 0.5 : 0),
      };
    });
    const pick = (arr) => {
      const out = [];
      for (const z of arr) {
        if (out.length >= perSide) break;
        if (Math.abs(z.price - close) > maxDist) break;
        if (!out.length || z.touches >= 2) out.push(z);
      }
      return out;
    };
    const above = pick(all.filter((z) => z.lo > close).sort((a, b) => a.lo - b.lo));
    const below = pick(all.filter((z) => z.hi < close).sort((a, b) => b.hi - a.hi));
    // 价格正处在某个区内：单独给出
    const inside = all.filter((z) => z.lo <= close && z.hi >= close).sort((a, b) => b.score - a.score)[0] ?? null;
    return { all, above, below, inside };
  }

  // ── 4. 趋势线 ─────────────────────────────────────────────────────────────
  // 上升趋势线：两个已确认低点连线（后一个更高）。从第一个锚点到现在，收盘价不能跌破线下 0.25 ATR；
  // 锚点之间被跌破 = 这条线根本不成立；第二个锚点之后跌破 = 线已破（记录破位时间）。
  // 触碰 = 区间内的同类摆动点离线 ≤ 0.35 ATR。≥3 次 = 有效趋势线（实线），2 次 = 候选（虚线）。
  const lineAt = (L, t) => L.p0 + L.slope * (t - L.t0);
  function trendlines(k, swings, atrNow, opt = {}) {
    const n = k.length, recentBreak = opt.recentBreakBars ?? 30;
    const tolBreak = 0.25 * atrNow, tolTouch = 0.35 * atrNow, maxDist = (opt.tlMaxDistAtr ?? 10) * atrNow;
    const res = {};
    for (const side of ["up", "down"]) {
      const up = side === "up";
      const pts = swings.filter((s) => s.type === (up ? "L" : "H")).slice(-10);
      let best = null, bestBroken = null;
      for (let a = 0; a < pts.length - 1; a++) {
        for (let b = a + 1; b < pts.length; b++) {
          const A = pts[a], B = pts[b];
          if (up ? B.price <= A.price : B.price >= A.price) continue;
          const L = { t0: A.time, p0: A.price, slope: (B.price - A.price) / (B.time - A.time) };
          let ok = true, breakJ = -1;
          for (let j = A.i; j < n; j++) {
            const v = (k[j].close - lineAt(L, k[j].time)) * (up ? 1 : -1);
            if (v < -tolBreak) { if (j <= B.i) ok = false; else breakJ = j; break; }
          }
          if (!ok) continue;
          const endI = breakJ >= 0 ? breakJ : n - 1;
          let touches = 0;
          for (const p of pts) if (p.i >= A.i && p.i <= endI && Math.abs(p.price - lineAt(L, p.time)) <= tolTouch) touches++;
          if (endI - A.i < 10) continue;
          // 没破的线离现价太远（> maxDist ATR）画出来也只是一根远处的斜线，不要
          if (breakJ < 0 && Math.abs(k[n - 1].close - lineAt(L, k[n - 1].time)) > maxDist) continue;
          const cand = { ...L, side, a: A, b: B, touches, breakJ, breakTime: breakJ >= 0 ? k[breakJ].time : null, strong: touches >= 3 };
          // 打分：触碰次数优先，其次第二锚点越新越好
          const sc = touches * 1000 + B.i;
          if (breakJ < 0) { if (!best || sc > best.sc) best = { ...cand, sc }; }
          else if (breakJ >= n - recentBreak && touches >= 3) { if (!bestBroken || breakJ > bestBroken.breakJ || (breakJ === bestBroken.breakJ && sc > bestBroken.sc)) bestBroken = { ...cand, sc }; }
        }
      }
      res[side] = best;
      res[side + "Broken"] = bestBroken;
    }
    return res;
  }

  // ── 5. 平行通道 / 三角形 ─────────────────────────────────────────────────────
  // 以趋势线为基线，过区间内离基线最远的对侧极值画平行线。对侧也要有 ≥2 个摆动点贴近（0.5 ATR），
  // 才算"价格真的在通道里走"，否则不画。上下两条趋势线同时有效 → 收敛/扩散形态，不当通道
  function channel(k, swings, tl, atrNow) {
    const n = k.length;
    const up = tl.up, dn = tl.down;
    if (up && dn && up.strong && dn.strong) {
      const t = k[n - 1].time, w = lineAt(dn, t) - lineAt(up, t);
      const t0 = Math.max(up.t0, dn.t0), w0 = lineAt(dn, t0) - lineAt(up, t0);
      if (w > 0) return { kind: w < w0 * 0.8 ? "三角收敛" : w > w0 * 1.25 ? "扩散" : "矩形", up, dn };
    }
    const cands = [up, dn].filter(Boolean).sort((a, b) => b.touches - a.touches || b.b.i - a.b.i);
    for (const base of cands) {
      const isUp = base.side === "up";
      let off = 0, offI = -1;
      for (let j = base.a.i; j < n; j++) {
        const v = isUp ? k[j].high - lineAt(base, k[j].time) : lineAt(base, k[j].time) - k[j].low;
        if (v > off) { off = v; offI = j; }
      }
      if (offI < 0 || off < 2 * atrNow || off > 15 * atrNow) continue;
      const opp = swings.filter((s) => s.type === (isUp ? "H" : "L") && s.i >= base.a.i);
      const oppT = opp.filter((s) => Math.abs(s.price - (lineAt(base, s.time) + (isUp ? off : -off))) <= 0.5 * atrNow).length;
      if (oppT < 2) continue;
      const lo = isUp ? 0 : -off, hi = isUp ? off : 0;
      const c = k[n - 1].close, b = lineAt(base, k[n - 1].time);
      return {
        kind: isUp ? "上升通道" : "下降通道", base, offset: isUp ? off : -off, oppTouches: oppT,
        t0: base.t0, pos: (c - (b + lo)) / (hi - lo), // 0 = 下沿 1 = 上沿
      };
    }
    return null;
  }

  // ── 6. 中枢（缠论笔中枢）────────────────────────────────────────────────────
  // 笔 = 相邻两个已确认摆动点之间的一段。生长规则同 czsc.get_zs_seq：
  //   向上笔的高点仍低于中枢 ZD，或向下笔的低点仍高于 ZG（离开且回抽不回）→ 新开一个中枢；否则并入当前中枢。
  //   ZG = 前三笔高点的最小值，ZD = 前三笔低点的最大值；GG/DD = 全部笔的最高/最低。至少 3 笔且 ZG>ZD 才有效
  function pivotsZs(swings) {
    const strokes = [];
    for (let j = 1; j < swings.length; j++) {
      const a = swings[j - 1], b = swings[j];
      strokes.push({ a, b, dir: b.price > a.price ? 1 : -1, hi: Math.max(a.price, b.price), lo: Math.min(a.price, b.price) });
    }
    const list = [];
    const calc = (z) => {
      const f = z.bis.slice(0, 3);
      z.zg = Math.min(...f.map((x) => x.hi)); z.zd = Math.max(...f.map((x) => x.lo));
      z.gg = Math.max(...z.bis.map((x) => x.hi)); z.dd = Math.min(...z.bis.map((x) => x.lo));
    };
    for (const bi of strokes) {
      const z = list[list.length - 1];
      if (!z) { list.push({ bis: [bi] }); calc(list[0]); continue; }
      if ((bi.dir === 1 && bi.hi < z.zd) || (bi.dir === -1 && bi.lo > z.zg)) { const nz = { bis: [bi] }; calc(nz); list.push(nz); }
      else { z.bis.push(bi); calc(z); }
    }
    return list
      .filter((z) => z.bis.length >= 3 && z.zg > z.zd)
      .map((z) => ({
        zg: z.zg, zd: z.zd, gg: z.gg, dd: z.dd, n: z.bis.length,
        t0: z.bis[0].a.time, t1: z.bis[z.bis.length - 1].b.time,
        lastSwing: z.bis[z.bis.length - 1].b,
      }));
  }

  // ── 7. 波浪候选 ───────────────────────────────────────────────────────────
  // 在最近的转折点（含正在走的那一段的极值）上找推动浪 0-1-2-3-4-5：
  //   铁律：2 浪不破 1 浪起点；3 浪不是 1/3/5 里最短的；4 浪不进入 1 浪价格区（不重叠）。
  //   打分：2浪回撤≈0.618、3浪≈1.618×1浪、4浪回撤≈0.382、5浪≈1浪。
  // 只接受"最后一个点就是最近的转折点"的计数（才和当下有关），没完成的给出下一浪的目标参考。
  // 推动浪走完后再找 A-B-C：B 不超过 5 浪终点。
  const near = (x, target, tol) => Math.max(0, 1 - Math.abs(x - target) / tol);
  function impulseScore(p, nWaves, dir) {
    // p[0..nWaves] 价格；dir=1 向上推动
    const v = p.map((x) => x * dir);
    const w = []; for (let i = 1; i <= nWaves; i++) w.push(v[i] - v[i - 1]);
    // 方向交替
    for (let i = 0; i < w.length; i++) if ((i % 2 === 0) !== (w[i] > 0)) return null;
    if (nWaves >= 2 && v[2] <= v[0]) return null;                 // 2 浪不破 1 浪起点
    if (nWaves >= 3 && v[3] <= v[1]) return null;                 // 3 浪要创新高
    if (nWaves >= 4 && v[4] <= v[1]) return null;                 // 4 浪不与 1 浪重叠
    if (nWaves >= 5) {
      if (v[5] <= v[3]) return null;                              // 5 浪失败（不创新高）的不计
      if (w[2] < w[0] && w[2] < w[4]) return null;                // 3 浪不能最短
    } else if (nWaves >= 3 && w[2] < w[0] * 0.618) return null;   // 进行中：3 浪太短不像推动
    const parts = [];
    if (nWaves >= 2) parts.push(near(-w[1] / w[0], 0.618, 0.35));
    if (nWaves >= 3) parts.push(near(w[2] / w[0], 1.618, 1.0));
    if (nWaves >= 4) parts.push(near(-w[3] / w[2], 0.382, 0.25));
    if (nWaves >= 5) parts.push(Math.max(near(w[4] / w[0], 1, 0.5), near(w[4] / w[0], 0.618, 0.3)));
    return parts.reduce((a, b) => a + b, 0) / parts.length;
  }
  function waves(swings, tentative) {
    const pts = swings.slice(-14).map((s) => ({ time: s.time, price: s.price, type: s.type, i: s.i }));
    if (tentative) pts.push({ time: tentative.time, price: tentative.price, type: tentative.type, i: tentative.i, tentative: true });
    const N = pts.length;
    let best = null;
    // 推动浪：结束点必须是最后一个点（或最后一个已确认点，此时正在走的那段是下一浪）
    for (const endIdx of [N - 1, N - 2]) {
      if (endIdx < 3) continue;
      for (const nW of [5, 4, 3]) {
        const s = endIdx - nW;
        if (s < 0) continue;
        const seq = pts.slice(s, endIdx + 1);
        const dir = seq[1].price > seq[0].price ? 1 : -1;
        const sc = impulseScore(seq.map((x) => x.price), nW, dir);
        if (sc == null) continue;
        // 偏好：浪数多、分数高、结束在最后一个点
        const rank = nW * 0.15 + sc + (endIdx === N - 1 ? 0.1 : 0);
        if (!best || rank > best.rank) best = { kind: "impulse", dir, nW, score: sc, rank, pts: seq, labels: seq.map((_, i) => String(i)) };
      }
    }
    // 推动浪完成后的 A-B-C
    for (let m = 1; m <= 3; m++) {
      const e5 = N - 1 - m;
      if (e5 - 5 < 0) continue;
      const seq = pts.slice(e5 - 5, e5 + 1);
      const dir = seq[1].price > seq[0].price ? 1 : -1;
      const sc = impulseScore(seq.map((x) => x.price), 5, dir);
      if (sc == null) continue;
      const after = pts.slice(e5 + 1);
      const p5 = seq[5].price * dir, A = after[0]?.price * dir, B = after[1]?.price * dir, C = after[2]?.price * dir;
      if (!(A < p5) || (after[1] && !(B < p5 && B > A)) || (after[2] && !(C < B))) continue;
      const nC = after.length;
      let s2 = sc;
      if (nC >= 2) s2 = (s2 + near((B - A) / (p5 - A), 0.618, 0.3)) / 2;
      const rank = 0.75 + 0.1 * nC + s2 * 0.5;
      if (!best || rank > best.rank) best = { kind: "abc", dir, nW: 5, nC, score: s2, rank, pts: [...seq, ...after], labels: ["0", "1", "2", "3", "4", "5", "A", "B", "C"].slice(0, 6 + nC) };
    }
    if (!best || best.score < 0.35) return null;
    // 下一步参考（仅推动浪进行中）
    const p = best.pts.map((x) => x.price), d = best.dir;
    let next = null;
    if (best.kind === "impulse") {
      const w1 = Math.abs(p[1] - p[0]);
      if (best.nW === 3) next = { txt: "可能在走 4 浪回调", target: p[3] - d * 0.382 * Math.abs(p[3] - p[2]), limit: p[1], limitTxt: "4浪不应进入1浪区" };
      if (best.nW === 4) next = { txt: "可能在走 5 浪", target: p[4] + d * w1, limit: p[1], limitTxt: "跌破即计数失效" };
      if (best.nW === 5) next = { txt: "5 浪可能完成，留意 ABC 调整", target: p[5] - d * 0.382 * Math.abs(p[5] - p[0]), limit: null };
    } else if (best.nC < 3) next = { txt: best.nC === 1 ? "A 浪后可能有 B 浪反抽" : "可能在走 C 浪", target: null, limit: p[5], limitTxt: "超过5浪终点即失效" };
    return { ...best, next };
  }

  // ── 汇总 ──────────────────────────────────────────────────────────────────
  // k：已收盘的K线（时间升序）。barSec：周期秒数
  function analyze(k, barSec, opt = {}) {
    if (!k || k.length < 30) return null;
    const n = k.length;
    const mult = opt.mult ?? MULT[barSec] ?? 2.2;
    const atr = atrOf(k, 14);
    const atrNow = atr[n - 1];
    const { swings, tentative } = zigzag(k, atr, mult, barSec);
    const { events, trend } = breaks(k, swings, barSec);
    const zs = pivotsZs(swings);
    const lastSw = swings[swings.length - 1];
    const close = k[n - 1].close;
    // 当前中枢：最后一个中枢的最后一笔就是最后一笔已确认的笔 = 中枢还在延伸
    const zLast = zs[zs.length - 1];
    const activeZs = zLast && zLast.lastSwing === lastSw ? zLast : null;
    const tl = trendlines(k, swings, atrNow, opt);
    const ch = channel(k, swings, tl, atrNow);
    const zn = zones(k, swings, atrNow, opt);
    const wv = waves(swings, tentative);
    // 结构判定：最近一次突破的方向 + 最近两个高低点的排列
    const hs = swings.filter((s) => s.type === "H").slice(-2), ls = swings.filter((s) => s.type === "L").slice(-2);
    const hh = hs.length === 2 && hs[1].price > hs[0].price, hl = ls.length === 2 && ls[1].price > ls[0].price;
    const lh = hs.length === 2 && hs[1].price < hs[0].price, ll = ls.length === 2 && ls[1].price < ls[0].price;
    let bias = 0, biasTxt = "结构不明";
    if (activeZs && activeZs.n >= 5 && close <= activeZs.zg && close >= activeZs.zd) { bias = 0; biasTxt = `中枢震荡（${activeZs.n}笔）`; }
    else if (hh && hl) { bias = 1; biasTxt = "上升结构 HH+HL"; }
    else if (lh && ll) { bias = -1; biasTxt = "下降结构 LH+LL"; }
    else if (trend) { bias = trend; biasTxt = trend > 0 ? "偏多（最近一次向上突破）" : "偏空（最近一次向下突破）"; }
    const lastEv = events[events.length - 1] ?? null;
    let zsPos = null;
    if (zLast) zsPos = close > zLast.zg ? "above" : close < zLast.zd ? "below" : "inside";
    return {
      n, barSec, mult, atr, atrNow, close,
      swings, tentative, events, trend, bias, biasTxt, lastEv,
      zones: zn, tl, channel: ch, zs, activeZs, zsPos, wave: wv,
      avgLegBars: swings.length > 1 ? (swings[swings.length - 1].i - swings[0].i) / (swings.length - 1) : NaN,
    };
  }

  return { analyze, zigzag, breaks, zones, trendlines, channel, pivotsZs, waves, impulseScore, lineAt, atrOf, MULT };
})();
if (typeof module !== "undefined") module.exports = Structure;
