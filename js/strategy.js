// 策略：1h 定方向 + 15m 多指标共振打分 + 入场触发形态
// 只在已收盘K线上判定信号（不重绘），当前未收盘K线只显示"形成中"状态
const Strategy = (() => {
  const DEFAULTS = {
    scoreThreshold: 65, // 共振分数阈值，越高信号越少、胜率越高
    strictHtf: true, // 必须与 1h 趋势同向
    cooldownBars: 4, // 同方向信号最小间隔
    maxChaseAtr: 1.5, // 价格偏离 EMA21 超过 N 倍 ATR 不追
    tp1R: 1.0,
    tp2R: 2.0,
    maxHoldBars: 32, // 回测最长持仓（32 根 15m = 8 小时）
    minRiskAtr: 0.8, // 止损最窄 N 倍 ATR
    maxRiskAtr: 2.0, // 止损最宽 N 倍 ATR
    // 以下默认值经 45 天 5 品种样本内/样本外对比选出（见 README）
    minAdx: 20, // ADX 硬门槛，过滤震荡市
    htfStrong: true, // 要求 1h Supertrend 也同向
    strictPullback: true, // 回踩必须真实收在 EMA9 另一侧，且本根突破前一根高/低点
    triggers: { pullback: true, breakout: true, flip: false }, // 趋势翻转信号回测为负，默认关闭
    minRiskPct: 0, // 止损距离小于价格的 N% 时跳过（止损太窄会被手续费吃掉）
    maxFeeR: 0.15, // 手续费占止损距离超过 N 倍 R 时跳过（大盘股波动小，止损窄，手续费占比过高）
    market: "crypto", // crypto / us / kr，股票类合约有交易时段概念
    skipWeekend: true, // 股票类合约周末（UTC 周六周日）不出信号：正股休市，合约价格缺乏定价
    feePct: 0.08, // 回测双边手续费 %（maker 开 + taker 平约 0.07%）
    // 支撑压力位
    minRoomR: 0, // 到对面最近压力/支撑的空间至少 N 倍止损距离，否则不开（0 = 不过滤）
    srStop: true, // 止损放到最近支撑/压力区外侧
    srTarget: false, // TP2 设在下一个压力/支撑前
    // TP1 之后剩余半仓的管理："fixed" 固定 TP2 / "chandelier" 吊灯移动止损 / "st" 沿 Supertrend 移动止损
    trail: "chandelier",
    trailAtr: 2.5,
    runnerMaxBars: 64,
    // 信号有效期：回测显示信号后 2 根K线内、价格顺向偏离不超过 0.6R 时入场，结果与第一时间入场相当；
    // 价格跌回信号价另一侧（多单跌回信号价下方）时胜率明显下降
    entryWindowBars: 2,
    maxChaseR: 0.6,

    // ───────── MTF 版新增。全部默认关闭，默认参数下与原版逐笔一致 ─────────
    // 第 2 层：止损候选位加入高周期硬位（4h/日线摆动点 + 周高低聚类出的位）
    htfStop: false,
    // 锚定到高周期硬位时允许的最大止损宽度（倍 ATR）。必须 > maxRiskAtr，
    // 否则日线硬位往往比 2 倍 15m ATR 远得多，止损只会顶到原上限，等于没测到东西
    htfStopMaxAtr: 3.0,
    // 第 3 层：regime gate。"off" 不过滤 / "trend" 只在趋势出信号 / "range" 只在震荡出信号
    regimeGate: "off",
    regimeTf: "1d",      // regime 判定用的周期："1d" 或 "4h"
    regimeN: 30,         // regime 回看根数
    regimeEr: 0.35,      // 效率比阈值，≥ 判趋势
    regimeMinR2: 0,      // 回归通道 r² 下限（0 = 不启用这一条）
    regimeChN: 60,       // 通道拟合根数
    // regime 要求方向与信号一致（趋势↑只做多）。仅在 regimeGate="trend" 时生效
    regimeAlign: false,
  };

  function computeHtf(k) {
    const c = k.map((x) => x.close), h = k.map((x) => x.high), l = k.map((x) => x.low);
    const e20 = TA.ema(c, 20), e50 = TA.ema(c, 50);
    const st = TA.supertrend(h, l, c, 10, 3);
    return k.map((x, i) => {
      let trend = 0;
      if (e20[i] > e50[i] && c[i] > e50[i]) trend = 1;
      else if (e20[i] < e50[i] && c[i] < e50[i]) trend = -1;
      return { closeTime: x.time + 3600, trend, strong: trend !== 0 && st.dir[i] === trend, ema20: e20[i], ema50: e50[i] };
    });
  }

  function computeLtf(k) {
    const c = k.map((x) => x.close), h = k.map((x) => x.high), l = k.map((x) => x.low), v = k.map((x) => x.volume);
    return {
      c, h, l, v,
      o: k.map((x) => x.open),
      ema9: TA.ema(c, 9),
      ema21: TA.ema(c, 21),
      atr: TA.atr(h, l, c, 14),
      rsi: TA.rsi(c, 14),
      macd: TA.macd(c),
      adx: TA.adx(h, l, c, 14),
      st: TA.supertrend(h, l, c, 10, 3),
      volMa: TA.sma(v, 20),
    };
  }

  // 为每根 15m K线找到"在它收盘时已经收盘"的最后一根 1h K线（避免未来函数）
  function alignHtf(ltfK, htf, interval) {
    const out = new Array(ltfK.length).fill(null);
    let j = -1;
    for (let i = 0; i < ltfK.length; i++) {
      const ltfClose = ltfK[i].time + interval;
      while (j + 1 < htf.length && htf[j + 1].closeTime <= ltfClose) j++;
      out[i] = j >= 0 ? htf[j] : null;
    }
    return out;
  }

  // 计算第 i 根K线的多/空共振分数与明细
  function scoreAt(ind, htfRow, i, side) {
    const s = side; // 1 多 / -1 空
    const items = [];
    let score = 0;
    const add = (ok, pts, label) => {
      items.push({ ok, pts, label });
      if (ok) score += pts;
    };
    const c = ind.c[i];
    const htfTrend = htfRow ? htfRow.trend : 0;
    add(htfTrend === s, 20, `1h趋势${s > 0 ? "向上" : "向下"}`);
    add(ind.st.dir[i] === s, 15, `Supertrend${s > 0 ? "多" : "空"}`);
    add(s > 0 ? ind.ema9[i] > ind.ema21[i] && c > ind.ema21[i] : ind.ema9[i] < ind.ema21[i] && c < ind.ema21[i], 15, "EMA9/21排列");
    const a = ind.adx;
    add(a.adx[i] >= 20 && (s > 0 ? a.pdi[i] > a.mdi[i] : a.mdi[i] > a.pdi[i]), 15, "ADX≥20有趋势");
    add(a.adx[i] > a.adx[i - 1], 5, "ADX上升");
    const hst = ind.macd.hist;
    add(s > 0 ? hst[i] > 0 && hst[i] > hst[i - 1] : hst[i] < 0 && hst[i] < hst[i - 1], 10, "MACD动能增强");
    const r = ind.rsi[i];
    add(s > 0 ? r >= 50 && r <= 72 : r <= 50 && r >= 28, 10, "RSI健康区间");
    const vr = ind.v[i] / ind.volMa[i];
    add(vr >= 1.2, 10, "放量≥1.2x");
    // 超买超卖惩罚
    if (s > 0 && r > 78) score -= 10;
    if (s < 0 && r < 22) score -= 10;
    return { score: Math.max(0, Math.min(100, score)), items, volRatio: vr };
  }

  // 入场触发形态
  function triggerAt(ind, i, side, p = DEFAULTS) {
    const s = side, c = ind.c[i], o = ind.o[i], atr = ind.atr[i];
    const tg = p.triggers;
    const bodyOk = s > 0 ? c > o : c < o;
    // 1) 回踩确认：近4根内触及 EMA21 或 Supertrend 轨附近，本根收回 EMA9 之上/下
    let touched = false;
    for (let j = i - 3; j <= i; j++) {
      if (s > 0 && (ind.l[j] <= ind.ema21[j] + 0.1 * atr || ind.l[j] <= ind.st.line[j] + 0.3 * atr)) touched = true;
      if (s < 0 && (ind.h[j] >= ind.ema21[j] - 0.1 * atr || ind.h[j] >= ind.st.line[j] - 0.3 * atr)) touched = true;
    }
    let reclaim;
    if (p.strictPullback) {
      let dipped = false;
      for (let j = i - 3; j < i; j++) if (s > 0 ? ind.c[j] < ind.ema9[j] : ind.c[j] > ind.ema9[j]) dipped = true;
      reclaim = dipped && (s > 0 ? c > ind.ema9[i] && c > ind.h[i - 1] : c < ind.ema9[i] && c < ind.l[i - 1]);
    } else {
      reclaim = s > 0 ? c > ind.ema9[i] && ind.c[i - 1] <= ind.ema9[i - 1] * 1.002 : c < ind.ema9[i] && ind.c[i - 1] >= ind.ema9[i - 1] * 0.998;
    }
    if (tg.pullback && touched && reclaim && bodyOk) return "回踩确认";
    // 2) 放量突破：突破前20根高/低点 + 量能≥1.5x
    const vr = ind.v[i] / ind.volMa[i];
    if (tg.breakout && vr >= 1.5 && bodyOk) {
      if (s > 0 && c > TA.highest(ind.h, 20, i - 1)) return "放量突破";
      if (s < 0 && c < TA.lowest(ind.l, 20, i - 1)) return "放量跌破";
    }
    // 3) Supertrend 翻转
    if (tg.flip && ind.st.dir[i] === s && ind.st.dir[i - 1] === -s) return "趋势翻转";
    return null;
  }

  function buildLevels(ind, i, side, p, lvls, hardLvls) {
    const entry = ind.c[i], atr = ind.atr[i];
    let structural = side > 0
      ? Math.min(TA.lowest(ind.l, 3, i), ind.st.dir[i] === 1 ? ind.st.line[i] : Infinity) - 0.2 * atr
      : Math.max(TA.highest(ind.h, 3, i), ind.st.dir[i] === -1 ? ind.st.line[i] : -Infinity) + 0.2 * atr;
    const near = Levels.nearest(lvls, entry, 0.15 * atr);
    const behind = side > 0 ? near.sup : near.res; // 身后的支撑（多）/ 压力（空）
    const ahead = side > 0 ? near.res : near.sup; // 前方的压力（多）/ 支撑（空）
    if (p.srStop && behind && Math.abs(entry - behind.price) <= p.maxRiskAtr * atr) {
      structural = side > 0 ? Math.min(structural, behind.lo - 0.25 * atr) : Math.max(structural, behind.hi + 0.25 * atr);
    }
    // 第 2 层：身后最近的高周期硬位。只有命中时才放宽止损上限到 htfStopMaxAtr，
    // 否则（上限仍是 maxRiskAtr）日线位会被 clamp 吃掉，改动等于无效
    let capAtr = p.maxRiskAtr, htfBehind = null;
    if (p.htfStop && hardLvls && hardLvls.length) {
      const nh = Levels.nearest(hardLvls, entry, 0.15 * atr);
      htfBehind = side > 0 ? nh.sup : nh.res;
      if (htfBehind) {
        const edge = side > 0 ? htfBehind.lo - 0.25 * atr : htfBehind.hi + 0.25 * atr;
        if (Math.abs(entry - edge) <= p.htfStopMaxAtr * atr) {
          structural = side > 0 ? Math.min(structural, edge) : Math.max(structural, edge);
          capAtr = p.htfStopMaxAtr;
        } else {
          htfBehind = null; // 太远，用不上
        }
      }
    }
    let risk = Math.abs(entry - structural);
    risk = Math.min(Math.max(risk, p.minRiskAtr * atr), capAtr * atr); // 止损宽度限制在 ATR 区间内
    const tp1 = entry + side * risk * p.tp1R;
    let tp2 = entry + side * risk * p.tp2R, tp2Src = `${p.tp2R}R`;
    if (p.srTarget) {
      // 越过 TP1 之后的第一个价位，止盈挂在它前面一点
      let best = null;
      for (const l of lvls) {
        if ((l.price - tp1) * side <= 0.1 * atr) continue;
        if (!best || (l.price - best.price) * side < 0) best = l;
      }
      if (best) {
        const t = best.price - side * 0.1 * atr, rr = ((t - entry) * side) / risk;
        if (rr >= 1.3 && rr <= 3) { tp2 = t; tp2Src = side > 0 ? "压力位" : "支撑位"; }
      }
    }
    const roomR = ahead ? Math.abs(ahead.price - entry) / risk : Infinity;
    return { entry, sl: entry - side * risk, risk, atr, tp1, tp2, tp2Src, roomR, ahead, behind, htfBehind, capAtr };
  }

  const isWeekend = (t) => { const d = new Date(t * 1000).getUTCDay(); return d === 0 || d === 6; };

  // MTF 上下文：高周期硬位 + regime 判定。
  // 无未来函数：Levels.htf / regime / channel 都只吃 closeTime 之前已收盘的高周期K线。
  // 性能：这些量只在 4h / 日线收盘边界上变化，所以按 4h 桶缓存（日线边界是 4h 边界的整数倍），
  // 否则每根 15m 都重算一遍高周期聚类，长样本下会退化。
  function mtfCtx(p, opts) {
    const h4k = opts.h4k || [], d1k = opts.d1k || [];
    if (!h4k.length && !d1k.length) return null;
    const useTf4h = p.regimeTf === "4h";
    const rSrc = useTf4h ? h4k : d1k, rSec = useTf4h ? 4 * 3600 : 86400;
    let bucket = -1, cached = null;
    return function at(closeTime) {
      const key = Math.floor(closeTime / (4 * 3600));
      if (key !== bucket) {
        bucket = key;
        const closed = rSrc.filter((x) => x.time + rSec <= closeTime);
        cached = {
          hard: p.htfStop ? Levels.htf(h4k, d1k, closeTime).filter((l) => l.hard) : null,
          regime: p.regimeGate !== "off" ? Levels.regime(closed, p.regimeN, p.regimeEr) : null,
          channel: p.regimeGate !== "off" && p.regimeMinR2 > 0 ? Levels.channel(closed, p.regimeChN) : null,
        };
      }
      return cached;
    };
  }

  // regime gate：返回 true = 放行
  function regimeOk(p, m, side) {
    if (p.regimeGate === "off") return true;
    if (!m || !m.regime) return false; // 要求过滤但数据不足 → 不开仓（保守）
    if (p.regimeMinR2 > 0 && !(m.channel && m.channel.r2 >= p.regimeMinR2)) return false;
    if (p.regimeGate === "trend") {
      if (!m.regime.trending) return false;
      if (p.regimeAlign && (m.regime.up ? 1 : -1) !== side) return false;
      return true;
    }
    if (p.regimeGate === "range") return !m.regime.trending;
    return true;
  }

  // 生成全部历史信号（仅已收盘K线；最后一根若未收盘则排除）
  function run(ltfK, htfK, interval, opts = {}) {
    const p = { ...DEFAULTS, ...opts };
    const ind = computeLtf(ltfK);
    const htf = computeHtf(htfK);
    const htfAligned = alignHtf(ltfK, htf, interval);
    const srCtx = Levels.prepare(ltfK, htfK);
    const levelsAt = (i) => Levels.at(srCtx, ltfK[i].time + interval, 0.6 * ind.atr[i]);
    const mtfAt = (p.htfStop || p.regimeGate !== "off") ? mtfCtx(p, opts) : null;
    const signals = [];
    const lastSig = { 1: -1e9, "-1": -1e9 };
    const nowSec = Date.now() / 1000;
    const warmup = 60;
    for (let i = warmup; i < ltfK.length; i++) {
      if (ltfK[i].time + interval > nowSec) break; // 未收盘
      if (isNaN(ind.atr[i]) || isNaN(ind.adx.adx[i]) || isNaN(ind.volMa[i])) continue;
      if (p.skipWeekend && p.market !== "crypto" && isWeekend(ltfK[i].time)) continue;
      // 本根收盘时可见的高周期信息（未收盘的高周期K线不参与）
      const m = mtfAt ? mtfAt(ltfK[i].time + interval) : null;
      for (const side of [1, -1]) {
        if (i - lastSig[side] < p.cooldownBars) continue;
        const htfRow = htfAligned[i];
        if (p.strictHtf && (!htfRow || htfRow.trend !== side)) continue;
        if (p.htfStrong && !htfRow?.strong) continue;
        if (p.minAdx && !(ind.adx.adx[i] >= p.minAdx && (side > 0 ? ind.adx.pdi[i] > ind.adx.mdi[i] : ind.adx.mdi[i] > ind.adx.pdi[i]))) continue;
        if (!regimeOk(p, m, side)) continue;
        const trig = triggerAt(ind, i, side, p);
        if (!trig) continue;
        if (Math.abs(ind.c[i] - ind.ema21[i]) > p.maxChaseAtr * ind.atr[i]) continue;
        const sc = scoreAt(ind, htfRow, i, side);
        if (sc.score < p.scoreThreshold) continue;
        const lv = buildLevels(ind, i, side, p, levelsAt(i), m?.hard);
        if ((lv.risk / lv.entry) * 100 < p.minRiskPct) continue;
        if (p.maxFeeR && ((p.feePct / 100) * lv.entry) / lv.risk > p.maxFeeR) continue;
        if (p.minRoomR && lv.roomR < p.minRoomR) continue;
        signals.push({
          i, time: ltfK[i].time, side, trigger: trig, score: sc.score, items: sc.items,
          entry: lv.entry, sl: lv.sl, tp1: lv.tp1, tp2: lv.tp2, tp2Src: lv.tp2Src,
          risk: lv.risk, roomR: lv.roomR, ahead: lv.ahead, behind: lv.behind,
          htfStopUsed: !!lv.htfBehind, riskAtr: lv.risk / lv.atr,
        });
        lastSig[side] = i;
      }
    }
    const bt = backtest(ltfK, signals, p, ind);
    return { ind, htfAligned, signals, bt, params: p, levelsAt };
  }

  // 回测：在信号K线收盘价入场；TP1 平半仓并把止损移到保本，剩余半仓按 p.trail 管理
  // 同一根K线同时触及止损和止盈，按止损处理（保守）
  function simulate(k, s, p, ind) {
    const side = s.side;
    const hit = (bar, lvl) => (side > 0 ? bar.high >= lvl : bar.low <= lvl);
    const stopHit = (bar, lvl) => (side > 0 ? bar.low <= lvl : bar.high >= lvl);
    const rOf = (px) => ((px - s.entry) * side) / s.risk;
    let sl = s.sl, hitTp1 = false, r = 0, extreme = s.entry;
    const end1 = Math.min(k.length - 1, s.i + p.maxHoldBars);
    let j = s.i + 1;
    for (; j <= end1; j++) {
      const bar = k[j];
      if (stopHit(bar, sl)) return { state: "loss", r: -1, exitI: j };
      if (hit(bar, s.tp1)) {
        hitTp1 = true; r = 0.5 * rOf(s.tp1); sl = s.entry; extreme = s.tp1;
        if (p.trail === "fixed" && hit(bar, s.tp2)) return { state: "tp2", r: r + 0.5 * rOf(s.tp2), exitI: j };
        break;
      }
      if (j === end1 && j - s.i >= p.maxHoldBars) {
        const xr = rOf(bar.close);
        return { state: xr > 0 ? "timeout+" : "timeout-", r: xr, exitI: j };
      }
    }
    if (!hitTp1) return { state: "open", r: 0, hitTp1: false };
    // 剩余半仓
    const maxBars = p.trail === "fixed" ? p.maxHoldBars : p.runnerMaxBars;
    const end2 = Math.min(k.length - 1, s.i + maxBars);
    for (j = j + 1; j <= end2; j++) {
      const bar = k[j];
      if (p.trail === "chandelier") {
        const t = extreme - side * p.trailAtr * ind.atr[j - 1];
        if ((t - sl) * side > 0) sl = t;
      } else if (p.trail === "st" && ind.st.dir[j - 1] === side) {
        if ((ind.st.line[j - 1] - sl) * side > 0) sl = ind.st.line[j - 1];
      }
      if (stopHit(bar, sl)) {
        const px = side > 0 ? Math.min(sl, bar.open) : Math.max(sl, bar.open);
        const xr = rOf(px);
        return { state: xr > 0.05 ? "trail" : "tp1", r: r + 0.5 * xr, exitI: j };
      }
      if (p.trail === "fixed" && hit(bar, s.tp2)) return { state: "tp2", r: r + 0.5 * rOf(s.tp2), exitI: j };
      extreme = side > 0 ? Math.max(extreme, bar.high) : Math.min(extreme, bar.low);
      if (j === end2 && j - s.i >= maxBars) return { state: "tp1", r: r + 0.5 * rOf(bar.close), exitI: j };
    }
    return { state: "open", r, hitTp1: true, trailSl: sl };
  }

  function backtest(k, signals, p, ind) {
    let wins = 0, losses = 0, tp2Hits = 0, totalR = 0, closed = 0, open = 0, feeR = 0;
    const names = { loss: "止损", tp1: "TP1后保本", tp2: "TP2", trail: "移动止盈", "timeout+": "超时盈利", "timeout-": "超时亏损" };
    for (const s of signals) {
      const res = simulate(k, s, p, ind);
      s.trailSl = res.trailSl;
      if (res.state === "open") {
        open++;
        s.hitTp1 = res.hitTp1;
        s.result = res.hitTp1 ? "持仓中(已TP1)" : "持仓中";
        s.r = null;
        continue;
      }
      s.hitTp1 = res.state !== "loss" && !res.state.startsWith("timeout");
      s.result = names[res.state];
      s.exitI = res.exitI;
      const fee = (p.feePct / 100) * s.entry / s.risk; // 手续费换算成 R
      s.r = res.r - fee;
      closed++;
      totalR += s.r;
      feeR += fee;
      if (s.r > 0) wins++; else losses++;
      if (res.state === "tp2" || res.state === "trail") tp2Hits++;
    }
    return {
      total: signals.length, closed, open, wins, losses,
      winRate: closed ? wins / closed : NaN,
      tp2Rate: closed ? tp2Hits / closed : NaN,
      avgR: closed ? totalR / closed : NaN,
      totalR,
      avgFeeR: closed ? feeR / closed : NaN,
    };
  }

  // 当前（含未收盘K线）实时状态，用于看板显示
  function liveState(res, k) {
    const { ind, htfAligned } = res;
    const i = k.length - 1;
    if (i < 60) return null;
    const htfRow = htfAligned[i];
    const L = scoreAt(ind, htfRow, i, 1), S = scoreAt(ind, htfRow, i, -1);
    const trend = htfRow ? htfRow.trend : 0;
    let status, tone;
    const st = ind.st.dir[i];
    if (trend === 1 && st === 1) { status = "多头趋势"; tone = "long"; }
    else if (trend === -1 && st === -1) { status = "空头趋势"; tone = "short"; }
    else if (trend !== 0) { status = trend > 0 ? "多头回调中" : "空头反弹中"; tone = "wait"; }
    else { status = "震荡观望"; tone = "flat"; }
    // 未收盘K线是否正在形成信号
    let forming = null;
    for (const side of [1, -1]) {
      if (res.params.strictHtf && trend !== side) continue;
      const trig = triggerAt(ind, i, side, res.params);
      const sc = side > 0 ? L : S;
      if (trig && sc.score >= res.params.scoreThreshold) forming = { side, trigger: trig, score: sc.score };
    }
    return {
      price: ind.c[i], trend, htfStrong: htfRow?.strong, status, tone,
      long: L, short: S, forming,
      rsi: ind.rsi[i], adx: ind.adx.adx[i], atr: ind.atr[i], macdHist: ind.macd.hist[i], volRatio: L.volRatio,
      atrPct: (ind.atr[i] / ind.c[i]) * 100,
    };
  }

  // 信号当前所处阶段，给出能不能进场的建议
  // code: go 可入场 / weak 走弱 / chased 已偏离 / expired 过期 / manage 已到TP1 / done 已结束
  function signalStatus(sig, res, k, interval) {
    const p = res.params, side = sig.side;
    const price = k[k.length - 1].close;
    // 入场窗口：到信号后第 entryWindowBars 根K线收盘为止
    const minLeft = Math.ceil((sig.time + interval * (1 + p.entryWindowBars) - Date.now() / 1000) / 60);
    const prog = ((price - sig.entry) * side) / sig.risk;
    const chaseLimit = sig.entry + side * p.maxChaseR * sig.risk;
    const base = { prog, chaseLimit, minLeft: Math.max(0, minLeft), price };
    if (sig.r != null) return { ...base, code: "done", label: `已结束 · ${sig.result}` };
    if (sig.hitTp1) return { ...base, code: "manage", label: "已到 TP1", stop: sig.trailSl ?? sig.entry };
    if (minLeft <= 0) return { ...base, code: "expired", label: "入场窗口已过" };
    if (prog < 0) return { ...base, code: "weak", label: side > 0 ? "跌回信号价下方" : "涨回信号价上方" };
    if (prog > p.maxChaseR) return { ...base, code: "chased", label: `已偏离 ${prog.toFixed(1)}R` };
    return { ...base, code: "go", label: "可入场" };
  }

  // 大周期（4h / 日线）趋势序列：只用于参考显示和分组统计，不参与信号判定
  function trendSeries(k, sec) {
    const c = k.map((x) => x.close), h = k.map((x) => x.high), l = k.map((x) => x.low);
    const e20 = TA.ema(c, 20), e50 = TA.ema(c, 50), st = TA.supertrend(h, l, c, 10, 3);
    return k.map((x, i) => ({
      closeTime: x.time + sec,
      st: st.dir[i],
      stack: e20[i] > e50[i] && c[i] > e50[i] ? 1 : e20[i] < e50[i] && c[i] < e50[i] ? -1 : 0,
      px20: c[i] > e20[i] ? 1 : -1,
      ok: !isNaN(e50[i]) && st.dir[i] !== 0,
    }));
  }
  // 时间 t 时已收盘的最后一根
  function trendAt(series, t) {
    let lo = 0, hi = series.length - 1, ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].closeTime <= t) { ans = series[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return ans?.ok ? ans : null;
  }

  // 最近一个信号之后是否出现离场警告（Supertrend 反向或收盘跌破/升破 EMA21）
  function exitWarning(res, k) {
    const last = res.signals[res.signals.length - 1];
    if (!last) return null;
    const { ind } = res;
    for (let j = last.i + 1; j < k.length; j++) {
      if (ind.st.dir[j] === -last.side) return { i: j, time: k[j].time, reason: "Supertrend反向", side: last.side };
      if (last.side > 0 ? ind.c[j] < ind.ema21[j] : ind.c[j] > ind.ema21[j])
        if (j - last.i >= 2) return { i: j, time: k[j].time, reason: "收盘破EMA21", side: last.side };
    }
    return null;
  }

  return { DEFAULTS, run, liveState, exitWarning, simulate, isWeekend, signalStatus, trendSeries, trendAt };
})();
