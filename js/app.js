// 盯盘助手主程序：数据加载 / WebSocket 实时更新 / 图表 / 提醒
(() => {
  const LTF = "15m", HTF = "1h";
  const LTF_SEC = 900;
  const REST = "https://fapi.binance.com";
  const WS_URLS = ["wss://fstream.binance.com/market/stream", "wss://fstream.binance.com/stream"];
  const DEFAULT_SYMBOLS = [
    "BTCUSDT", "ETHUSDT",
    "SNDKUSDT", "MUUSDT", "SKHYNIXUSDT", "NVDAUSDT", "TSLAUSDT", "MSTRUSDT", "MRVLUSDT", "INTCUSDT", "CRCLUSDT", "GOOGLUSDT",
  ];
  const SYMBOLS_VER = 2; // 默认列表变更时递增，老用户会自动合并新默认品种
  const CN_NAMES = {
    BTCUSDT: "比特币", ETHUSDT: "以太坊", SOLUSDT: "SOL",
    MUUSDT: "美光", SNDKUSDT: "闪迪", SKHYNIXUSDT: "海力士", SKHYUSDT: "海力士ADR", SAMSUNGUSDT: "三星",
    NVDAUSDT: "英伟达", TSLAUSDT: "特斯拉", MSTRUSDT: "微策略", MRVLUSDT: "迈威尔", INTCUSDT: "英特尔", CRCLUSDT: "Circle",
    GOOGLUSDT: "谷歌", AAPLUSDT: "苹果", MSFTUSDT: "微软", AMZNUSDT: "亚马逊", METAUSDT: "Meta", AMDUSDT: "AMD", TSMUSDT: "台积电",
    AVGOUSDT: "博通", PLTRUSDT: "Palantir", COINUSDT: "Coinbase", HOODUSDT: "Robinhood", QQQUSDT: "纳指ETF", SPYUSDT: "标普ETF",
    SOXLUSDT: "半导体3x", WDCUSDT: "西部数据", SPCXUSDT: "SpaceX",
  };
  const MARKET_NAMES = { crypto: "加密货币", us: "美股", kr: "韩股", hk: "港股", other: "其他" };
  const TZ = -new Date().getTimezoneOffset() * 60; // 图表显示本地时间
  // 加密货币：信号K线主动成交偏向 ≥ 0.2（主动买入占成交量 ≥ 60%，空单反之）视为"过热追单"
  // 6 个月 6 个币回测：这类信号每笔 -0.15R，其余 -0.02R，前后两半和 5/6 个币结论一致
  const HOT_FLOW = 0.2;

  // localStorage 前缀。本仓库（mtf 版）部署在 babakaifeiji-1.github.io 的另一个路径下，
  // 和原版 crypto_minitor 是**同一个 origin**，localStorage 是共用的。
  // 必须和原版的 "tm_" 区分开，否则两个看板会互相覆盖设置、分组统计和推送开关。
  const STORE_PREFIX = "mtf_";
  const store = {
    load(key, def) { try { const v = JSON.parse(localStorage.getItem(STORE_PREFIX + key)); return v ?? def; } catch { return def; } },
    save(key, v) { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(v)); },
  };

  function initialSymbols() {
    const saved = store.load("symbols", null);
    if (!saved) return [...DEFAULT_SYMBOLS];
    if (store.load("symbolsVer", 1) < SYMBOLS_VER) {
      const merged = [...saved, ...DEFAULT_SYMBOLS.filter((s) => !saved.includes(s))];
      store.save("symbols", merged);
      store.save("symbolsVer", SYMBOLS_VER);
      return merged;
    }
    return saved;
  }

  // 图层：每一层独立开关。结构类图层全部来自 Structure.analyze（同一套摆动点）
  const LAYERS = [
    { id: "swing", name: "波段", color: "rgba(210,215,230,.8)", tip: "ATR ZigZag 转折点连线，标 HH/HL/LH/LL；最后一段虚线 = 还没确认" },
    { id: "zone", name: "支撑压力", color: "#ef5350", tip: "本周期摆动点聚类成区，每侧最多 2 个；×N = 触碰次数，⇅ = 支撑压力互换过" },
    { id: "htf", name: "大周期位", color: "rgba(188,148,255,.95)", tip: "上两级周期的支撑压力区，投影到本图（半透明色带）" },
    { id: "tl", name: "趋势线", color: "#26a69a", tip: "已确认低点/高点连线；实线 ≥3 次触碰，虚线 = 2 次（候选），灰色 = 最近被收盘击穿" },
    { id: "ch", name: "通道", color: "#4c8dff", tip: "趋势线 + 过对侧极值的平行线；对侧也要 ≥2 次触碰才画。两条线收敛时标三角形" },
    { id: "zs", name: "中枢", color: "rgba(255,170,40,.95)", tip: "缠论笔中枢：至少 3 笔重叠的区间 [ZD, ZG]，就是震荡区间" },
    { id: "wave", name: "波浪", color: "#00d9ff", tip: "推动浪/ABC 候选：只保留满足三条铁律、斐波那契比例最贴近的一组" },
    { id: "bos", name: "BOS/CHoCH", color: "#f5c542", tip: "BOS = 顺势突破前高/前低；CHoCH = 逆势突破，结构可能转变" },
    { id: "sig", name: "信号", color: "#c9d1e0", tip: "策略信号、止损/TP1、趋势转弱、🧱 强价位被拒" },
    { id: "ma", name: "均线", color: "#f5c542", tip: "EMA9 / EMA21 / Supertrend" },
    { id: "old", name: "策略价位", color: "rgba(239,83,80,.6)", tip: "旧版画法：策略止损用的 15m/1h ★价位 + 4h/日线紫色位" },
    { id: "reg", name: "回归通道", color: "rgba(0,217,255,.95)", tip: "旧版：log 收盘价回归通道 + 底部形态色带 + Donchian 震荡框" },
  ];
  const LAYER_DEFAULT = { swing: 0, zone: 1, htf: 1, tl: 1, ch: 0, zs: 1, wave: 0, bos: 0, sig: 1, ma: 0, old: 0, reg: 0 };
  const LAYER_PRESETS = {
    简洁: { zone: 1, htf: 1, tl: 1, sig: 1 },
    结构: { swing: 1, zone: 1, htf: 1, tl: 1, ch: 1, zs: 1, bos: 1, sig: 1 },
    波浪: { swing: 1, wave: 1, zone: 1, sig: 1 },
  };

  const sizing = store.load("sizing", { risk: 10 }); // 每笔愿意亏多少 USDT
  const state = {
    symbols: initialSymbols(),
    params: { ...Strategy.DEFAULTS, ...store.load("params", {}) },
    market: {}, // sym -> crypto / us / kr / hk / other
    active: null,
    data: {},
    sound: false,
    feed: [],
    flashUntil: {}, // sym -> 时间戳，卡片闪烁
    chTf: store.load("chTf", "1d"), // 15m 图上「趋势通道」面板的周期档位："1d" 或 "4h"
    chartTf: store.load("chartTf", "15m"), // 主图周期："3m" / "15m"（短线）/ "1h" / "4h" / "1d"（长线）
    layers: { ...LAYER_DEFAULT, ...store.load("layers", {}) }, // 图上各图层开关，见 LAYERS
  };
  state.active = state.symbols[0];

  const $ = (id) => document.getElementById(id);
  const decimals = (p) => (p >= 1000 ? 2 : p >= 10 ? 3 : p >= 1 ? 4 : 6);
  const fmtPrice = (p) => (p == null || isNaN(p) ? "-" : p.toFixed(decimals(Math.abs(p))));
  const fmtPct = (p, base) => { const v = ((p - base) / base) * 100; return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`; };
  const fmtTime = (t) => {
    const d = new Date(t * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const sideTxt = (s) => (s > 0 ? "做多" : "做空");
  const sideCls = (s) => (s > 0 ? "long" : "short");
  const short = (sym) => sym.replace(/USDT$/, "");
  const nameOf = (sym) => `${short(sym)}${CN_NAMES[sym] ? " " + CN_NAMES[sym] : ""}`;
  const marketOf = (sym) => state.market[sym] ?? (sym === "BTCUSDT" || sym === "ETHUSDT" ? "crypto" : "us");
  // 按固定亏损额算下单量：数量 = 风险金额 / 止损距离
  function sizeFor(sig) {
    if (!(sizing.risk > 0)) return null;
    const dist = Math.abs(sig.entry - sig.sl);
    if (!dist) return null;
    const qty = sizing.risk / dist, notional = qty * sig.entry;
    const fee = notional * (state.params.feePct / 100);
    return { qty, notional, fee, lev: Math.max(1, Math.ceil(notional / (sizing.risk * 20))) };
  }
  const fmtQty = (q, px) => (q * px >= 1 && q >= 100 ? q.toFixed(0) : q >= 1 ? q.toFixed(3) : q.toPrecision(3));
  const sizeTxt = (sig) => {
    const z = sizeFor(sig);
    return z ? `亏 ${sizing.risk}U 的仓位：<b>${fmtQty(z.qty, sig.entry)}</b> 个（约 ${z.notional.toFixed(0)}U）` : "";
  };
  const paramsFor = (sym) => ({ ...state.params, market: marketOf(sym) });

  // ---------------- 交易时段 ----------------
  function sessionOf(sym) {
    const m = marketOf(sym);
    if (m === "crypto") return null;
    const now = new Date();
    if (state.params.skipWeekend && Strategy.isWeekend(now / 1000)) return { txt: "周末休市 · 暂停出信号", cls: "off" };
    const tz = m === "kr" ? "Asia/Seoul" : m === "hk" ? "Asia/Hong_Kong" : "America/New_York";
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hour12: false, weekday: "short" }).formatToParts(now);
    const get = (t) => parts.find((x) => x.type === t).value;
    const mins = (+get("hour") % 24) * 60 + +get("minute");
    if (get("weekday") === "Sat" || get("weekday") === "Sun") return { txt: "正股休市", cls: "off" };
    if (m === "us") {
      if (mins >= 570 && mins < 960) return { txt: "美股盘中", cls: "on" };
      if (mins >= 240 && mins < 570) return { txt: "美股盘前", cls: "pre" };
      if (mins >= 960 && mins < 1200) return { txt: "美股盘后", cls: "pre" };
      return { txt: "美股夜盘", cls: "pre" };
    }
    if (m === "kr") return mins >= 540 && mins < 930 ? { txt: "韩股盘中", cls: "on" } : { txt: "韩股休市时段", cls: "pre" };
    if (m === "hk") return (mins >= 570 && mins < 720) || (mins >= 780 && mins < 960) ? { txt: "港股盘中", cls: "on" } : { txt: "港股休市时段", cls: "pre" };
    return null;
  }

  // ---------------- 数据 ----------------
  async function fetchJson(path) {
    const r = await fetch(REST + path);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function fetchKlines(sym, interval, limit) {
    const arr = await fetchJson(`/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
    return arr.map((x) => ({ time: x[0] / 1000, open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5], takerBuy: +x[9] }));
  }

  // 合约类型（加密 / 美股 / 韩股…），以及美股成交量排行
  async function loadMeta() {
    try {
      const ei = await fetchJson("/fapi/v1/exchangeInfo");
      const map = { COIN: "crypto", INDEX: "crypto", EQUITY: "us", PREMARKET: "us", KR_EQUITY: "kr", HK_EQUITY: "hk" };
      const types = {};
      for (const s of ei.symbols) if (s.status === "TRADING") types[s.symbol] = map[s.underlyingType] ?? "other";
      state.allTypes = types;
      for (const sym of Object.keys(types)) state.market[sym] = types[sym];
      const t24 = await fetchJson("/fapi/v1/ticker/24hr");
      const hot = t24
        .filter((x) => ["us", "kr"].includes(types[x.symbol]))
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, 25);
      $("hotList").innerHTML = hot
        .map((x) => `<option value="${x.symbol}">${CN_NAMES[x.symbol] ?? ""} 24h成交 ${(x.quoteVolume / 1e6).toFixed(0)}M USDT</option>`)
        .join("");
    } catch (e) {
      console.warn("合约信息加载失败，按默认规则判断类型", e);
    }
  }

  async function loadSymbol(sym) {
    const [ltf, htf, h4, d1, m3] = await Promise.all([
      // 4h/日线拉得比原版多：通道拟合窗口拉长到 4h 360 根 / 日线 120 根，还要留出余量
      fetchKlines(sym, LTF, 1500), fetchKlines(sym, HTF, 500), fetchKlines(sym, "4h", 1000), fetchKlines(sym, "1d", 500),
      // 3m 只用于短线副图（入场确认），不参与策略。失败不影响其它
      fetchKlines(sym, "3m", 1000).catch(() => []), // 3m 只用于画图（短线入场），不参与策略
    ]);
    const prev = state.data[sym];
    state.data[sym] = {
      ltf, htf, h4, d1, m3, res: null, live: null, dirty: true, computedAt: 0,
      seen: prev?.seen ?? new Map(), exitAlerted: prev?.exitAlerted ?? new Set(), initialized: prev?.initialized ?? false,
    };
    recompute(sym);
  }

  function recompute(sym) {
    const d = state.data[sym];
    if (!d || d.ltf.length < 100) return;
    // 额外把 4h / 日线喂进去：htfStop（高周期硬位止损）和 regimeGate 需要。
    // 两者默认关闭，此时 Strategy 内部不会碰这两个数组，行为与原版一致。
    d.res = Strategy.run(d.ltf, d.htf, LTF_SEC, { ...paramsFor(sym), h4k: d.h4, d1k: d.d1 });
    d.computedAt = Date.now();
    // 大周期背景（只显示和统计，不影响信号）
    d.ctx = { h4: Strategy.trendSeries(d.h4, 14400), d1: Strategy.trendSeries(d.d1, 86400) };
    for (const sg of d.res.signals) {
      const t = sg.time + LTF_SEC;
      const a = Strategy.trendAt(d.ctx.d1, t), b = Strategy.trendAt(d.ctx.h4, t);
      sg.d1 = a ? (a.st === sg.side ? "同向" : "逆向") : null;
      sg.h4 = b ? (b.st === sg.side ? "同向" : "逆向") : null;
      const hist = d.res.ind.macd.hist;
      sg.mt = (hist[sg.i] - hist[sg.i - 1]) * sg.side > 0 ? "是" : "否"; // MACD 柱是否朝信号方向拐头
      const bar = d.ltf[sg.i];
      sg.flow = bar?.volume ? ((2 * bar.takerBuy) / bar.volume - 1) * sg.side : null; // >0 表示主动成交和信号同方向
      sg.hot = marketOf(sym) === "crypto" && sg.flow >= HOT_FLOW;
    }
    recordJournal(sym, d.res.signals);
    // 最近 300 根已收盘K线里的强价位拒绝
    {
      const k = d.ltf, ind = d.res.ind;
      let last = k.length - 1;
      if (k[last].time + LTF_SEC > Date.now() / 1000) last--;
      d.rejections = [];
      for (let i = Math.max(61, last - 300); i <= last; i++) {
        const ev = Levels.rejection(d.res.levelsAt(i - 1), k, i, ind.atr[i - 1]);
        if (ev) d.rejections.push(ev);
      }
    }
    d.live = Strategy.liveState(d.res, d.ltf);
    d.exit = Strategy.exitWarning(d.res, d.ltf);
    const last = d.res.signals[d.res.signals.length - 1];
    d.lastStatus = last ? Strategy.signalStatus(last, d.res, d.ltf, LTF_SEC) : null;
    d.dirty = false;
    checkAlerts(sym);
  }

  // 本机信号日志：长期累积已平仓信号及其大周期分组，用于判断日线/4h过滤到底有没有用
  const journal = store.load("journal", {});
  let journalDirty = false;
  function recordJournal(sym, signals) {
    for (const sg of signals) {
      if (sg.r == null || !sg.d1 || !sg.h4) continue;
      const key = `${sym}|${sg.time}`;
      if (journal[key]) continue;
      journal[key] = { sym, t: sg.time, side: sg.side, r: +sg.r.toFixed(3), d1: sg.d1, h4: sg.h4, mt: sg.mt, tg: sg.trigger, hot: sg.hot ? 1 : 0, crypto: marketOf(sym) === "crypto" ? 1 : 0 };
      journalDirty = true;
    }
  }
  setInterval(() => {
    if (!journalDirty) return;
    const keys = Object.keys(journal);
    if (keys.length > 5000) keys.sort((a, b) => journal[a].t - journal[b].t).slice(0, keys.length - 5000).forEach((k) => delete journal[k]);
    store.save("journal", journal);
    journalDirty = false;
  }, 10000);

  // ---------------- 合约资金面（加密货币）----------------
  // 持仓量：实时接口每 10 秒一次（延迟约 5 秒），4 小时以上的变化用 5 分钟统计补齐；
  // 资金费率每分钟刷新
  async function loadFlow(sym) {
    const d = state.data[sym];
    if (!d || marketOf(sym) !== "crypto") return;
    try {
      const [oi, pi] = await Promise.all([
        fetchJson(`/futures/data/openInterestHist?symbol=${sym}&period=5m&limit=60`),
        fetchJson(`/fapi/v1/premiumIndex?symbol=${sym}`),
      ]);
      d.flow = {
        ...(d.flow ?? {}),
        hist: oi.map((x) => ({ t: x.timestamp / 1000 + 300, v: +x.sumOpenInterestValue })), // 统计值在该 5 分钟结束时才有
        funding: +pi.lastFundingRate, nextFunding: pi.nextFundingTime / 1000, mark: +pi.markPrice,
      };
      d.flow.live = d.flow.live ?? [];
    } catch (e) {
      console.warn("资金面数据加载失败", sym, e);
    }
  }
  async function loadLiveOi(sym) {
    const d = state.data[sym];
    if (!d?.flow || marketOf(sym) !== "crypto") return;
    try {
      const r = await fetchJson(`/fapi/v1/openInterest?symbol=${sym}`);
      const px = d.ltf[d.ltf.length - 1]?.close ?? d.flow.mark;
      const pt = { t: r.time / 1000, v: +r.openInterest * px, c: +r.openInterest };
      const live = d.flow.live;
      if (!live.length || pt.t > live[live.length - 1].t) live.push(pt);
      while (live.length && live[0].t < pt.t - 3 * 3600) live.shift();
      d.flow.liveAt = Date.now();
      d.dirty = true;
    } catch (e) { /* 偶发失败下一轮重试 */ }
  }
  // 合并后的持仓序列：5 分钟统计 + 实时点（用合约张数比较，避免价格波动干扰）
  function oiSeries(d) {
    const f = d.flow;
    if (!f) return [];
    const live = f.live ?? [];
    const firstLive = live.length ? live[0].t : Infinity;
    const lastPx = d.ltf[d.ltf.length - 1].close;
    return [...(f.hist ?? []).filter((x) => x.t < firstLive).map((x) => ({ t: x.t, c: x.v / (d.ltf.find((b) => b.time + LTF_SEC > x.t)?.close ?? lastPx) })), ...live];
  }
  function oiChange(d, sec) {
    const a = oiSeries(d);
    if (a.length < 2) return null;
    const now = a[a.length - 1];
    let then = null;
    for (let j = a.length - 1; j >= 0; j--) if (a[j].t <= now.t - sec) { then = a[j]; break; }
    if (!then || now.t - then.t > sec + 600) return null;
    return (now.c / then.c - 1) * 100;
  }
  function oiSpark(d) {
    const a = oiSeries(d).filter((x) => x.t >= Date.now() / 1000 - 2 * 3600);
    if (a.length < 3) return "";
    const W = 300, Hh = 34, t0 = a[0].t, t1 = a[a.length - 1].t || t0 + 1;
    const lo = Math.min(...a.map((x) => x.c)), hi = Math.max(...a.map((x) => x.c)), span = hi - lo || 1;
    const pts = a.map((x) => `${(((x.t - t0) / (t1 - t0)) * W).toFixed(1)},${(Hh - 2 - ((x.c - lo) / span) * (Hh - 4)).toFixed(1)}`).join(" ");
    const up = a[a.length - 1].c >= a[0].c;
    return `<svg class="spark" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${up ? "#26a69a" : "#ef5350"}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
  }
  const pctTxt = (v, digits = 2) => (v == null || isNaN(v) ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`);
  // 信号推送用的一行资金面摘要
  function flowSummary(sym, s) {
    const d = state.data[sym], parts = [];
    if (s.flow != null) parts.push(`主动${s.side > 0 ? "买" : "卖"}占比 ${(((s.flow + 1) / 2) * 100).toFixed(0)}%${s.hot ? "（过热）" : ""}`);
    const o1 = oiChange(d, 3600);
    if (o1 != null) parts.push(`持仓1h ${pctTxt(o1)}`);
    if (d.flow) parts.push(`资金费率 ${(d.flow.funding * 100).toFixed(4)}%`);
    let txt = parts.length ? "资金面：" + parts.join(" · ") : "";
    if (s.hot) txt += "<br><b>⚠️ 信号K线主动成交过于集中，回测这类信号胜率偏低，建议减半仓或放弃</b>";
    return txt;
  }

  function upsertCandle(arr, c) {
    const last = arr[arr.length - 1];
    if (last && last.time === c.time) arr[arr.length - 1] = c;
    else if (!last || c.time > last.time) { arr.push(c); if (arr.length > 1600) arr.shift(); }
  }

  // ---------------- 提醒 ----------------
  function checkAlerts(sym) {
    const d = state.data[sym];
    const sigs = d.res.signals;
    const p = d.res.params;
    if (!d.initialized) {
      // 首次加载：历史信号不提醒，只记录状态
      sigs.forEach((s) => d.seen.set(s.time, { result: s.result, weak: true }));
      if (d.exit) d.exitAlerted.add(d.exit.time);
      d.rejSeen = new Set((d.rejections ?? []).map((e) => e.time));
      d.initialized = true;
      return;
    }
    const nowSec = Date.now() / 1000;
    for (const s of sigs) {
      const prev = d.seen.get(s.time);
      const age = nowSec - (s.time + LTF_SEC);
      if (!prev) {
        d.seen.set(s.time, { result: s.result, weak: false });
        if (age > 2 * LTF_SEC) continue; // 太旧的（如参数调整后新出现的历史信号）不提醒
        const sess = sessionOf(sym);
        const ctxTxt = [s.d1 && `日线${s.d1}`, s.h4 && `4h${s.h4}`].filter(Boolean).join(" · ");
        const flowTxt = marketOf(sym) === "crypto" ? flowSummary(sym, s) : "";
        notify({
          kind: sideCls(s.side), event: "signal", sym,
          title: `${s.side > 0 ? "🟢" : "🔴"} ${nameOf(sym)} ${sideTxt(s.side)}信号`,
          body: `${s.trigger} · ${s.score}分${sess ? " · " + sess.txt : ""}${ctxTxt ? "<br>大周期：" + ctxTxt : ""}${flowTxt ? "<br>" + flowTxt : ""}<br>
            入场 <b>${fmtPrice(s.entry)}</b>，最多追到 ${fmtPrice(s.entry + s.side * p.maxChaseR * s.risk)}<br>
            ${sizeTxt(s) ? sizeTxt(s) + "<br>" : ""}
            止损 ${fmtPrice(s.sl)}（${fmtPct(s.sl, s.entry)}）· TP1 ${fmtPrice(s.tp1)}（${fmtPct(s.tp1, s.entry)}）<br>
            <span class="muted">${p.entryWindowBars * 15} 分钟内有效；价格回到 ${fmtPrice(s.entry)} ${s.side > 0 ? "下方" : "上方"}则放弃</span>`,
          feed: `<b class="${sideCls(s.side)}">${sideTxt(s.side)}</b> ${s.trigger} ${s.score}分 @ ${fmtPrice(s.entry)}`,
        });
        continue;
      }
      // 持仓事件：只针对近期信号
      if (prev.result !== s.result && age < p.runnerMaxBars * LTF_SEC) {
        if (s.result === "持仓中(已TP1)") {
          notify({
            kind: "info", event: "tp1", sym, title: `🎯 ${nameOf(sym)} 到达 TP1`,
            body: `${sideTxt(s.side)}单 TP1 ${fmtPrice(s.tp1)} 已到<br>平一半仓位，止损移到入场价 ${fmtPrice(s.entry)}，剩余仓位用移动止损跟踪`,
            feed: `<b class="long">TP1 到达</b> ${sideTxt(s.side)}单 → 平半仓、止损移保本`,
          });
        } else if (s.r != null) {
          const good = s.r > 0;
          notify({
            kind: good ? "info" : "exit", event: "close", sym, title: `${good ? "✅" : "❌"} ${nameOf(sym)} ${sideTxt(s.side)}单结束：${s.result}`,
            body: `结果约 ${s.r >= 0 ? "+" : ""}${s.r.toFixed(2)}R（已扣手续费）`,
            feed: `<b class="${good ? "long" : "short"}">${s.result}</b> ${sideTxt(s.side)}单 ${s.r >= 0 ? "+" : ""}${s.r.toFixed(2)}R`,
          });
        }
      }
      prev.result = s.result;
      // 信号走弱：入场窗口内价格回到信号价另一侧
      if (!prev.weak && age < (p.entryWindowBars + 1) * LTF_SEC) {
        const st = Strategy.signalStatus(s, d.res, d.ltf, LTF_SEC);
        if (st.code === "weak") {
          prev.weak = true;
          notify({
            kind: "exit", event: "weak", sym, title: `⚠️ ${nameOf(sym)} 信号走弱`,
            body: `价格回到信号价 ${fmtPrice(s.entry)} ${s.side > 0 ? "下方" : "上方"}<br>还没进场的先别进；已进场的按止损 ${fmtPrice(s.sl)} 执行`,
            feed: `<b class="wait">信号走弱</b> ${sideTxt(s.side)} @ ${fmtPrice(s.entry)}`,
          });
        }
      }
    }
    d.rejSeen = d.rejSeen ?? new Set((d.rejections ?? []).map((e) => e.time));
    for (const ev of d.rejections ?? []) {
      if (d.rejSeen.has(ev.time)) continue;
      d.rejSeen.add(ev.time);
      if (nowSec - (ev.time + LTF_SEC) > 2 * LTF_SEC) continue;
      const L = ev.level, what = ev.isRes ? "压力" : "支撑";
      const last = sigs[sigs.length - 1], holding = last && last.r == null && last.side === (ev.isRes ? 1 : -1);
      notify({
        kind: "exit", event: "level", sym,
        title: `🧱 ${nameOf(sym)} ${ev.isRes ? "涨不动" : "跌不动"}：强${what} ${fmtPrice(L.price)} 被拒`,
        body: `${ev.first ? "首次测试" : "反复测试后"}，${ev.isRes ? "长上影" : "长下影"}收回${what}区内。<br>
          回测：这种形态之后 3 小时内被突破的概率约 ${ev.first ? "10%" : "20%"}（普通价位约 40%）${holding ? `<br><b>你的${sideTxt(last.side)}单正顶着这个${what}，可考虑先减仓或收紧止损</b>` : ""}`,
        feed: `<b class="wait">🧱 强${what}被拒</b> ${fmtPrice(L.price)}${ev.first ? "（首次）" : ""}`,
      });
    }
    const ex = d.exit;
    if (ex && !d.exitAlerted.has(ex.time) && ex.time + LTF_SEC <= nowSec) {
      d.exitAlerted.add(ex.time);
      notify({
        kind: "exit", event: "exit", sym,
        title: `${nameOf(sym)} 趋势转弱提醒`,
        body: `${sideTxt(ex.side)}单：${ex.reason}，持仓的考虑减仓/收紧止损`,
        feed: `<b class="wait">趋势转弱</b> ${sideTxt(ex.side)}单 ${ex.reason}`,
      });
    }
  }

  let audioCtx = null;
  function beep(kind) {
    if (!state.sound || !audioCtx) return;
    const seq = kind === "long" ? [660, 880, 1100] : kind === "short" ? [1100, 880, 660] : kind === "info" ? [880, 1100] : [520, 400];
    seq.forEach((f, idx) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f;
      const t0 = audioCtx.currentTime + idx * 0.18;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + 0.17);
    });
  }

  let titleTimer = null;
  function notify({ kind, event, sym, title, body, feed }) {
    beep(kind);
    Push.send(event, title, body, sym);
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = `<span class="close">✕</span><div class="t">${title}</div><div>${body}</div><div class="muted small">${fmtTime(Date.now() / 1000)}</div>`;
    el.onclick = (e) => { if (!e.target.classList.contains("close")) selectSymbol(sym); el.remove(); };
    $("toasts").prepend(el);
    setTimeout(() => el.remove(), 90000);
    state.feed.unshift({ sym, html: feed, t: Date.now() / 1000 });
    renderFeed();
    state.flashUntil[sym] = Date.now() + 8000;
    renderWatchlist();
    clearInterval(titleTimer);
    let n = 0;
    const orig = "盯盘助手 · 15m 趋势跟随";
    const tag = { long: "多", short: "空", info: "持仓", exit: "注意" }[kind];
    titleTimer = setInterval(() => {
      document.title = n++ % 2 ? orig : `【${tag}】${short(sym)}`;
      if (n > 20) { clearInterval(titleTimer); document.title = orig; }
    }, 800);
  }

  // ---------------- WebSocket ----------------
  let ws = null, wsUrlIdx = 0, wsRetry = 0, wsTimer = null, lastMsgAt = 0, downSince = 0;
  function connectWs() {
    if (ws) { ws.onclose = null; ws.close(); }
    const streams = state.symbols.flatMap((s) => [LTF, HTF, "4h", "1d", "3m"].map((iv) => `${s.toLowerCase()}@kline_${iv}`)).join("/");
    const url = `${WS_URLS[wsUrlIdx]}?streams=${streams}`;
    setConn("wait", "连接中");
    ws = new WebSocket(url);
    let gotData = false;
    ws.onmessage = (ev) => {
      if (!gotData) {
        gotData = true; wsRetry = 0; setConn("ok", "实时");
        if (downSince && Date.now() - downSince > 3 * 60000) {
          const mins = Math.round((Date.now() - downSince) / 60000);
          notify({ kind: "exit", event: "health", sym: state.active, title: "盯盘中断后已恢复", body: `行情连接中断了约 ${mins} 分钟，期间可能漏掉信号，请留意持仓。`, feed: `<b class="wait">连接恢复</b> 中断 ${mins} 分钟` });
        }
        downSince = 0;
      }
      const msg = JSON.parse(ev.data);
      const k = msg.data?.k;
      if (!k) return;
      const d = state.data[k.s];
      if (!d) return;
      const c = { time: k.t / 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, takerBuy: +k.V };
      lastMsgAt = Date.now();
      const arr = { [LTF]: d.ltf, [HTF]: d.htf, "4h": d.h4, "1d": d.d1, "3m": d.m3 }[k.i];
      if (arr) upsertCandle(arr, c);
      if (k.i === "3m") return; // 3m 只用于画图，不触发策略重算
      d.dirty = true;
      if (k.x) recompute(k.s); // K线收盘立刻计算信号
    };
    ws.onclose = () => {
      setConn("bad", "断线重连中");
      if (!downSince) downSince = lastMsgAt || Date.now();
      if (!gotData) wsUrlIdx = (wsUrlIdx + 1) % WS_URLS.length; // 换备用地址
      clearTimeout(wsTimer);
      wsTimer = setTimeout(async () => {
        await Promise.allSettled(state.symbols.map(loadSymbol)); // 补齐断线期间的K线
        connectWs();
      }, Math.min(30000, 2000 * 2 ** wsRetry++));
    };
    ws.onerror = () => ws.close();
  }
  function setConn(cls, txt) {
    $("conn").className = `conn ${cls}`;
    $("conn").querySelector("span").textContent = txt;
  }

  // ---------------- 图表 ----------------
  // 自绘图层（lightweight-charts v4.2 primitive）。原生 price line 只能横贯整张图，
  // 画出来就像"这个位一直存在"——对历史K线来说是假的。所以区、线、框都从它开始存在的那根K线画起。
  //
  // 图元（时间已经加过 TZ、并且对齐到图上存在的K线时间）：
  //   rect  { t0,t1,lo,hi, fill, fade, stroke, edge:"lo"|"hi"|"both"|"frame", dash, width, label, lc }
  //   line  { t0,p0,t1,p1, color, width, dash, label, lc, la:"end"|"mid" }
  //   poly  { pts:[{time,price}], color, width, dashLast }
  //   band  { pts:[{time,up,dn}], fill }
  //   text  { time, price, text, color, pos:"above"|"below", circle, size, off }
  //   vline { time, color, label }
  // 视觉规则：
  //   * 区只描"朝向现价的那条边"（压力描下沿、支撑描上沿），另一边靠填充表达 —— 横线数量减半
  //   * 区的填充从左到右渐浓（fade），越老的部分越淡，视线自然落到右侧现价附近
  //   * 标签是右端的小胶囊，按优先级（prio 小的先放）摆放，和已放的重叠就不画，不再往下挤成一串
  class Overlay {
    constructor(z) { this._z = z; this._items = []; this._views = [this]; }
    attached(p) { this._chart = p.chart; this._series = p.series; this._req = p.requestUpdate; }
    detached() { this._chart = this._series = null; }
    set(items) { this._items = items; this._req?.(); }
    updateAllViews() {
      const ts = this._chart?.timeScale(), s = this._series;
      if (!ts || !s) { this._g = null; return; }
      const X = (t) => ts.timeToCoordinate(t), Y = (p) => s.priceToCoordinate(p);
      this._g = this._items.map((it) => {
        switch (it.t) {
          case "rect": return { ...it, x0: X(it.t0), x1: X(it.t1), y0: Y(it.hi), y1: Y(it.lo) };
          case "line": return { ...it, x0: X(it.t0), x1: X(it.t1), y0: Y(it.p0), y1: Y(it.p1) };
          case "poly": return { ...it, xy: it.pts.map((p) => [X(p.time), Y(p.price)]) };
          case "band": return { ...it, xy: it.pts.map((p) => [X(p.time), Y(p.up), Y(p.dn)]) };
          case "text": return { ...it, x: X(it.time), y: Y(it.price) };
          case "vline": return { ...it, x: X(it.time) };
          default: return null;
        }
      }).filter(Boolean);
    }
    paneViews() { return this._views; }
    zOrder() { return this._z; }
    renderer() { return this; }
    draw(target) {
      const g = this._g;
      if (!g) return;
      const ok = (...v) => v.every((x) => x != null && isFinite(x));
      target.useBitmapCoordinateSpace(({ context: c, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize }) => {
        c.save();
        const W = bitmapSize.width;
        if (this._z === "bottom") {
          for (const it of g) {
            if (it.t === "rect" && it.fill && ok(it.x0, it.x1, it.y0, it.y1)) {
              const x0 = Math.max(0, it.x0 * hr), x1 = Math.min(W, it.x1 * hr);
              if (x1 <= x0) continue;
              if (it.fade) {
                // 渐变：左端 15% 浓度 → 右端 100%
                const m = it.fill.match(/rgba?\(([^)]+)\)/), parts = m ? m[1].split(",").map((x) => x.trim()) : null;
                const a = parts?.[3] != null ? +parts[3] : 1, rgb = parts ? parts.slice(0, 3).join(",") : "128,128,128";
                const gr = c.createLinearGradient(x0, 0, x1, 0);
                gr.addColorStop(0, `rgba(${rgb},${a * 0.15})`); gr.addColorStop(1, `rgba(${rgb},${a})`);
                c.fillStyle = gr;
              } else c.fillStyle = it.fill;
              c.fillRect(x0, it.y0 * vr, x1 - x0, Math.max(1, (it.y1 - it.y0) * vr));
            } else if (it.t === "band") {
              const p = it.xy.filter((q) => ok(...q));
              if (p.length < 2) continue;
              c.beginPath();
              p.forEach((q, i) => (i ? c.lineTo(q[0] * hr, q[1] * vr) : c.moveTo(q[0] * hr, q[1] * vr)));
              for (let i = p.length - 1; i >= 0; i--) c.lineTo(p[i][0] * hr, p[i][2] * vr);
              c.closePath(); c.fillStyle = it.fill; c.fill();
            }
          }
          c.restore();
          return;
        }
        const font = (sz, w = 600) => `${w} ${sz * vr}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
        const placed = [];
        const hits = (r) => placed.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
        // 胶囊标签：(x,y) 为锚点，align=right 时右端对齐锚点；垂直居中于 y。撞了就不画
        const pill = (txt, x, y, color, align = "right", sz = 10, force = false) => {
          c.font = font(sz);
          const tw = c.measureText(txt).width, h = (sz + 6) * vr, pad = 4 * hr;
          const r = { x: align === "right" ? x - tw - 2 * pad : x, y: y - h / 2, w: tw + 2 * pad, h };
          r.x = Math.max(0, Math.min(W - r.w, r.x));
          if (!force && hits(r)) return false;
          placed.push(r);
          c.fillStyle = "rgba(14,17,23,.85)";
          c.beginPath(); c.roundRect ? c.roundRect(r.x, r.y, r.w, r.h, 3 * hr) : c.rect(r.x, r.y, r.w, r.h); c.fill();
          c.setLineDash([]); c.lineWidth = 1 * hr; c.strokeStyle = color; c.globalAlpha = 0.55; c.stroke(); c.globalAlpha = 1;
          c.fillStyle = color; c.textBaseline = "middle"; c.textAlign = "left"; c.fillText(txt, r.x + pad, r.y + h / 2 + 0.5 * vr);
          return true;
        };
        const stroke = (color, width, dash) => {
          c.strokeStyle = color; c.lineWidth = Math.max(1, width * hr);
          c.setLineDash(dash ? (dash === 2 ? [2 * hr, 3 * hr] : [6 * hr, 4 * hr]) : []);
        };
        const hline = (x0, x1, y) => { c.beginPath(); c.moveTo(x0, Math.round(y) + 0.5); c.lineTo(x1, Math.round(y) + 0.5); c.stroke(); };
        const labels = []; // [prio, fn]
        for (const it of g) {
          if (it.t === "rect") {
            if (!ok(it.x0, it.x1, it.y0, it.y1)) continue;
            const x0 = it.x0 * hr, x1 = it.x1 * hr, y0 = it.y0 * vr, y1 = it.y1 * vr;
            if (it.stroke && it.edge) {
              stroke(it.stroke, it.width ?? 1, it.dash);
              if (it.edge === "frame") c.strokeRect(x0, y0, x1 - x0, y1 - y0);
              if (it.edge === "hi" || it.edge === "both") hline(x0, x1, y0);
              if (it.edge === "lo" || it.edge === "both") hline(x0, x1, y1);
            }
            if (it.label) {
              const ly = it.la === "left" ? y0 + 9 * vr : it.edge === "lo" ? y1 : it.edge === "hi" ? y0 : (y0 + y1) / 2;
              labels.push([it.prio ?? 5, () => pill(it.label, it.la === "left" ? x0 + 4 * hr : x1 - 3 * hr, ly, it.lc ?? it.stroke, it.la === "left" ? "left" : "right")]);
            }
          } else if (it.t === "line") {
            if (!ok(it.x0, it.x1, it.y0, it.y1)) continue;
            stroke(it.color, it.width ?? 1, it.dash);
            c.beginPath(); c.moveTo(it.x0 * hr, it.y0 * vr); c.lineTo(it.x1 * hr, it.y1 * vr); c.stroke();
            if (it.label) labels.push([it.prio ?? 4, () => it.la === "mid"
              ? pill(it.label, (it.x0 + it.x1) / 2 * hr, (it.y0 + it.y1) / 2 * vr - 10 * vr, it.lc ?? it.color, "left", 9)
              : pill(it.label, it.x1 * hr - 3 * hr, it.y1 * vr - 11 * vr, it.lc ?? it.color, "right", 9.5)]);
          } else if (it.t === "poly") {
            const p = it.xy;
            for (let i = 1; i < p.length; i++) {
              if (!ok(...p[i - 1], ...p[i])) continue;
              stroke(it.color, it.width ?? 1, it.dashLast && i === p.length - 1 ? 1 : it.dash);
              c.beginPath(); c.moveTo(p[i - 1][0] * hr, p[i - 1][1] * vr); c.lineTo(p[i][0] * hr, p[i][1] * vr); c.stroke();
            }
          } else if (it.t === "text") {
            if (!ok(it.x, it.y)) continue;
            labels.push([it.prio ?? 6, () => {
              const sz = it.size ?? 10, off = (it.off ?? 8) * vr;
              c.font = font(sz, it.circle ? 700 : 600);
              const tw = c.measureText(it.text).width, x = it.x * hr;
              const y = it.pos === "below" ? it.y * vr + off + sz * vr / 2 : it.y * vr - off - sz * vr / 2;
              const r = { x: x - tw / 2 - 2 * hr, y: y - sz * vr / 2 - 1, w: tw + 4 * hr, h: sz * vr + 2 };
              if (!it.circle && hits(r)) return;
              placed.push(r);
              c.textBaseline = "middle"; c.textAlign = "center";
              if (it.circle) {
                const rad = Math.max(tw / 2 + 3 * hr, (sz / 2 + 3) * vr);
                c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fillStyle = "rgba(14,17,23,.92)"; c.fill();
                c.setLineDash([]); c.lineWidth = 1.2 * hr; c.strokeStyle = it.color; c.stroke();
              }
              c.fillStyle = it.color; c.fillText(it.text, x, y + 0.5 * vr);
              c.textAlign = "left";
            }]);
          } else if (it.t === "vline") {
            if (!ok(it.x)) continue;
            stroke(it.color, 1, 1);
            c.beginPath(); c.moveTo(it.x * hr, 0); c.lineTo(it.x * hr, bitmapSize.height); c.stroke();
            if (it.label) labels.push([3, () => pill(it.label, it.x * hr + 4 * hr, 12 * vr, it.color, "left")]);
          }
        }
        c.setLineDash([]);
        labels.sort((a, b) => a[0] - b[0]).forEach(([, f]) => f());
        c.restore();
      });
    }
  }
  const fillLayer = new Overlay("bottom"), lineLayer = new Overlay("normal");

  // ── 价格结构（structure.js）：每个周期一份，只用已收盘K线，按最后一根收盘时间缓存 ──
  const TFS = {
    "3m": { key: "m3", sec: 180, label: "3m" },
    "15m": { key: "ltf", sec: LTF_SEC, label: "15m" },
    "1h": { key: "htf", sec: 3600, label: "1h" },
    "4h": { key: "h4", sec: 4 * 3600, label: "4h" },
    "1d": { key: "d1", sec: 86400, label: "日线" },
    "1w": { key: "w1", sec: 7 * 86400, label: "周线" },
  };
  // 每个主图周期投影哪两级大周期（近的那级每侧 2 个区，远的那级每侧 1 个）
  const HTF_OF = { "3m": ["15m", "1h"], "15m": ["1h", "4h"], "1h": ["4h", "1d"], "4h": ["1d", "1w"], "1d": ["1w"] };
  // 周线由日线合成（周一 00:00 UTC 开盘），不额外请求
  function weeklyOf(d) {
    const d1 = d.d1 ?? [];
    const ck = `${d1.length}|${d1[d1.length - 1]?.time}|${d1[d1.length - 1]?.close}`;
    if (d._w1ck === ck) return d._w1;
    const out = [];
    for (const x of d1) {
      const day = Math.floor(x.time / 86400), wk = (Math.floor((day + 3) / 7) * 7 - 3) * 86400;
      const w = out[out.length - 1];
      if (w && w.time === wk) { w.high = Math.max(w.high, x.high); w.low = Math.min(w.low, x.low); w.close = x.close; w.volume += x.volume; }
      else out.push({ time: wk, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume });
    }
    d._w1 = out; d._w1ck = ck;
    return out;
  }
  const barsOf = (d, tf) => (tf === "1w" ? weeklyOf(d) : d?.[TFS[tf].key] ?? []);
  const stCache = new Map();
  function structOf(sym, tf) {
    const d = state.data[sym], cfg = TFS[tf];
    if (!d || !cfg) return null;
    const all = barsOf(d, tf), nowS = Date.now() / 1000;
    let n = all.length;
    while (n > 0 && all[n - 1].time + cfg.sec > nowS) n--; // 去掉正在形成的K线
    if (n < 30) return null;
    const ck = `${sym}|${tf}|${n}|${all[n - 1].time}`;
    if (stCache.has(ck)) return stCache.get(ck);
    const S = Structure.analyze(all.slice(Math.max(0, n - 1500), n), cfg.sec);
    if (S) S.tf = tf;
    if (stCache.size > 80) stCache.clear();
    stCache.set(ck, S);
    return S;
  }

  // 图层图元生成。k = 图上的K线（含正在形成的），sec = 图的周期
  // 配色：本周期 红压/绿撑；大周期 紫（近一级）/粉（远一级）；中枢 橙；通道 蓝；波浪 青。
  const rgba = (rgb, a) => `rgba(${rgb},${a})`;
  const COL = {
    res: "239,83,80", sup: "38,166,154", mid: "245,197,66", htf: ["188,148,255", "255,128,200"], zs: "255,170,40",
    up: "#26a69a", dn: "#ef5350", broken: "rgba(140,150,170,.55)", ch: "rgba(96,156,255,.8)", chFill: "rgba(96,156,255,.05)",
    swing: "rgba(200,206,220,.32)", wave: "#00d9ff", bos: "#f5c542",
  };
  function chartFrame(k, sec) {
    const T = (t) => t + TZ;
    const snap = (t) => {
      if (t <= k[0].time) return k[0].time;
      let lo = 0, hi = k.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (k[m].time <= t) lo = m; else hi = m - 1; }
      return k[lo].time;
    };
    const lastT = k[k.length - 1].time;
    return { T, snap, lastT, futEnd: lastT + FWD * sec, t0: k[0].time };
  }
  // 一条斜线（趋势线/通道线）从 ta 画到 tb；起点早于图上第一根时截到第一根
  function slopeLine(F, L, ta, tb, extra) {
    const a = Math.max(F.snap(ta), F.t0);
    return { t: "line", t0: F.T(a), p0: Structure.lineAt(L, a), t1: F.T(tb), p1: Structure.lineAt(L, tb), ...extra };
  }
  const fmtTouch = (z) => `×${z.touches}${z.flip ? "⇅" : ""}`;
  // 区的浓度跟强度走：触碰越多、和大周期重叠，越浓
  const zoneAlpha = (z, conf) => Math.min(0.26, 0.09 + 0.04 * Math.min(z.touches, 4) + (conf ? 0.05 : 0));

  function structItems(S, k, sec, Ly, o = {}) {
    const items = [], tags = [];
    if (!S || !k.length) return { items, tags };
    const F = chartFrame(k, sec), { T, snap, futEnd } = F;
    const inChart = (t) => t >= F.t0;
    // 波段：细淡线，只标最近 10 个点的 HH/HL/LH/LL（撞到别的标签就不标）
    if (Ly.swing) {
      const sw = S.swings.filter((s) => inChart(s.time));
      const pts = sw.map((s) => ({ time: T(s.time), price: s.price }));
      if (S.tentative && inChart(S.tentative.time)) pts.push({ time: T(S.tentative.time), price: S.tentative.price });
      items.push({ t: "poly", pts, color: COL.swing, width: 1, dashLast: !!S.tentative });
      for (const s of sw.slice(-10)) {
        const good = s.lab === "HH" || s.lab === "HL";
        items.push({ t: "text", time: T(s.time), price: s.price, text: s.lab, pos: s.type === "H" ? "above" : "below", color: good ? "rgba(38,166,154,.8)" : "rgba(239,83,80,.8)", size: 9, off: 5, prio: 8 });
      }
    }
    // BOS / CHoCH：从被突破的那个摆动点画到突破K线，点线
    if (Ly.bos) {
      for (const e of S.events.filter((x) => inChart(x.from.time)).slice(-4)) {
        const color = e.kind === "CHoCH" ? COL.bos : e.dir > 0 ? "rgba(38,166,154,.75)" : "rgba(239,83,80,.75)";
        items.push({ t: "line", t0: T(e.from.time), p0: e.price, t1: T(e.time), p1: e.price, color, width: 1, dash: 2, label: e.kind, la: "mid", lc: color, prio: 6 });
      }
    }
    // 中枢：最近 2 个。当前（或最后一个）实线框，前一个淡虚线不带标签
    if (Ly.zs) {
      const list = S.zs.filter((z) => z.t1 >= F.t0).slice(-2);
      list.forEach((z, idx) => {
        const active = z === S.activeZs, lastOne = idx === list.length - 1;
        items.push({
          t: "rect", t0: T(snap(z.t0)), t1: T(active ? futEnd : snap(z.t1)), lo: z.zd, hi: z.zg,
          fill: rgba(COL.zs, lastOne ? 0.07 : 0.035), stroke: rgba(COL.zs, lastOne ? 0.85 : 0.35), edge: "frame",
          width: 1, dash: active ? 0 : 1, label: lastOne ? `中枢 ${z.n}笔` : "", la: "left", prio: 3,
        });
      });
    }
    // 支撑压力区：只描朝向现价的那条边，填充左淡右浓；标签在右端
    if (Ly.zone) {
      const z = S.zones;
      const draw = (x, rgb, nm, edge) => {
        const cf = [...new Set((o.htfZones ?? []).filter((h) => h.lo <= x.hi && h.hi >= x.lo).map((h) => h.tf))].map((t) => "+" + TFS[t].label).join("");
        const strong = x.touches >= 3 || !!cf;
        items.push({ t: "rect", t0: T(snap(x.from)), t1: T(futEnd), lo: x.lo, hi: x.hi, fill: rgba(rgb, zoneAlpha(x, cf)), fade: true,
          stroke: rgba(rgb, strong ? 0.95 : 0.7), edge, width: strong ? 1.6 : 1, dash: edge === "both" ? 1 : 0,
          label: `${nm} ${fmtTouch(x)}${cf}`, lc: rgba(rgb, 1), prio: 1 });
        tags.push([x.price, rgba(rgb, 0.95)]);
      };
      z.above.forEach((x) => draw(x, COL.res, "压", "lo"));
      z.below.forEach((x) => draw(x, COL.sup, "撑", "hi"));
      if (z.inside) draw(z.inside, COL.mid, "区内", "both");
    }
    // 趋势线 + 通道
    if (Ly.tl || Ly.ch) {
      const tl = S.tl;
      const tlLine = (L, color) => slopeLine(F, L, L.a.time, futEnd, {
        color, width: L.strong ? 2 : 1.3, dash: L.strong ? 0 : 1, label: `${L.touches}触`, lc: color, prio: 2,
      });
      if (Ly.tl) {
        if (tl.up) items.push(tlLine(tl.up, COL.up));
        if (tl.down) items.push(tlLine(tl.down, COL.dn));
        for (const B of [tl.upBroken, tl.downBroken]) if (B) {
          items.push(slopeLine(F, B, B.a.time, B.breakTime, { color: COL.broken, width: 1, dash: 1 }));
          items.push({ t: "text", time: T(snap(B.breakTime)), price: Structure.lineAt(B, B.breakTime), text: "破", pos: B.side === "up" ? "below" : "above", color: "rgba(170,180,200,.9)", size: 9.5, prio: 5 });
        }
      }
      const ch = S.channel;
      if (Ly.ch && ch) {
        if (ch.base) {
          const P = { t0: ch.base.t0, p0: ch.base.p0 + ch.offset, slope: ch.base.slope };
          items.push(slopeLine(F, P, ch.base.a.time, futEnd, { color: COL.ch, width: 1.2, dash: 1, label: `${ch.kind.replace("通道", "")}通道 ${Math.round(ch.pos * 100)}%`, lc: COL.ch, prio: 3 }));
          if (!Ly.tl) items.push(tlLine(ch.base, COL.ch));
          const ts = k.filter((x) => x.time >= ch.base.a.time).map((x) => x.time).concat([futEnd]);
          items.push({ t: "band", fill: COL.chFill, pts: ts.map((t) => { const b = Structure.lineAt(ch.base, t); return { time: T(t), up: Math.max(b, b + ch.offset), dn: Math.min(b, b + ch.offset) }; }) });
        } else if (ch.up && ch.dn) {
          const t0 = Math.max(ch.up.a.time, ch.dn.a.time);
          const ts = k.filter((x) => x.time >= t0).map((x) => x.time).concat([futEnd]);
          items.push({ t: "band", fill: "rgba(245,197,66,.05)", pts: ts.map((t) => ({ time: T(t), up: Structure.lineAt(ch.dn, t), dn: Structure.lineAt(ch.up, t) })) });
          if (!Ly.tl) { items.push(tlLine(ch.up, COL.up)); items.push(tlLine(ch.dn, COL.dn)); }
          items.push({ t: "text", time: T(snap(t0)), price: Structure.lineAt(ch.dn, t0), text: ch.kind, pos: "above", color: "#f5c542", size: 10, prio: 3 });
        }
      }
    }
    // 波浪
    if (Ly.wave && S.wave) {
      const w = S.wave, pts = w.pts.filter((p) => inChart(p.time));
      items.push({ t: "poly", pts: pts.map((p) => ({ time: T(p.time), price: p.price })), color: "rgba(0,217,255,.75)", width: 1.6, dashLast: !!w.pts[w.pts.length - 1].tentative });
      w.pts.forEach((p, i) => {
        if (!inChart(p.time)) return;
        const isHigh = i > 0 ? p.price > w.pts[i - 1].price : p.price > w.pts[1].price;
        items.push({ t: "text", time: T(p.time), price: p.price, text: w.labels[i], pos: isHigh ? "above" : "below", color: COL.wave, circle: true, size: 10, off: o.swingOn ? 17 : 9, prio: 0 });
      });
      const last = w.pts[w.pts.length - 1];
      if (w.next?.target) items.push({ t: "line", t0: T(snap(last.time)), p0: w.next.target, t1: T(futEnd), p1: w.next.target, color: "rgba(0,217,255,.7)", width: 1, dash: 2, label: `目标 ${fmtPrice(w.next.target)}`, lc: COL.wave, prio: 2 });
      if (w.next?.limit) items.push({ t: "line", t0: T(snap(last.time)), p0: w.next.limit, t1: T(futEnd), p1: w.next.limit, color: "rgba(0,217,255,.4)", width: 1, dash: 1, label: "失效", lc: "rgba(0,217,255,.75)", prio: 2 });
    }
    return { items, tags };
  }
  // 大周期支撑压力区投影到本图：淡色渐变带 + 朝向现价的一条虚线边
  function htfItems(list, k, sec, o = {}) {
    const items = [], tags = [];
    if (!k.length) return { items, tags };
    const F = chartFrame(k, sec);
    // 每级大周期每侧只取 1 个；和本周期区（o.own）或更近一级已画的区重叠的不再单独画 ——
    // 重叠的那个本周期区会标上 "+1h"，表示多周期共振
    const taken = [...(o.own ?? [])];
    const overlaps = (z) => taken.some((t) => t.lo <= z.hi && t.hi >= z.lo);
    list.forEach(({ S, tf }, rank) => {
      if (!S) return;
      const rgb = COL.htf[rank] ?? COL.htf[1], nm = TFS[tf].label;
      const draw = (z, isRes) => {
        items.push({ t: "rect", t0: F.T(F.snap(z.from)), t1: F.T(F.futEnd), lo: z.lo, hi: z.hi, fill: rgba(rgb, 0.1), fade: true,
          stroke: rgba(rgb, 0.8), edge: isRes ? "lo" : "hi", dash: 1, width: 1.2,
          label: `${nm}${isRes ? "压" : "撑"} ${fmtTouch(z)}`, lc: rgba(rgb, 1), prio: 2 + rank });
        tags.push([z.price, rgba(rgb, 0.9)]);
        taken.push(z);
      };
      for (const [arr, isRes] of [[S.zones.above, true], [S.zones.below, false]]) {
        const z = arr.find((x) => !overlaps(x));
        if (z) draw(z, isRes);
      }
      // 3m 图上额外投影 15m 的趋势线（3m 就是在 15m 结构里找入场点）
      if (o.withTl && rank === 0) for (const L of [S.tl.up, S.tl.down]) if (L) {
        items.push(slopeLine(F, L, L.a.time, F.futEnd, { color: rgba(rgb, 0.85), width: 1.5, dash: L.strong ? 0 : 1, label: `${nm}线`, lc: rgba(rgb, 1), prio: 3 }));
      }
    });
    return { items, tags };
  }

  // 高周期结构的唯一来源：图表和面板都从这里取，保证两边数字一致。
  // rgN 用 30/90，和 strategy.js 里 regimeN、quant/ 第 3 层实验的口径一致
  const STRUCT = {
    htf: { label: "1h", sec: 3600, chN: 360, rgN: 90 },
    d1: { label: "日线", sec: 86400, chN: 120, rgN: 30 },
    h4: { label: "4h", sec: 4 * 3600, chN: 360, rgN: 90 },
  };
  const structCache = new Map();
  function structureFor(sym, key) {
    const d = state.data[sym], cfg = STRUCT[key];
    if (!d || !cfg) return null;
    const nowS = Date.now() / 1000;
    const src = (d[key] ?? []).filter((x) => x.time + cfg.sec <= nowS); // 只用已收盘的
    if (src.length < 10) return null;
    const ck = `${sym}|${key}|${src.length}|${src[src.length - 1].time}`;
    if (structCache.has(ck)) return structCache.get(ck);
    const ch = Levels.channel(src, cfg.chN);
    const rg = Levels.regime(src, cfg.rgN, 0.35);
    const fits = Levels.channelFits(src, cfg.chN, cfg.sec);
    const rfits = Levels.regimeFits(src, cfg.rgN, cfg.sec, 0.35);
    // 可靠性的两个口径：事后（当前通道窗口内收盘落在带内）vs 当时（第 i 根时的通道，下一根落在带内）
    let inIn = 0;
    if (ch) src.slice(-ch.n).forEach((x, i) => { const p = ch.points[i]; if (x.close >= p.dn && x.close <= p.up) inIn++; });
    let o1 = 0, t1 = 0;
    for (const f of fits) {
      const nx = src[f.i + 1];
      if (!nx) continue;
      const v = Levels.evalFit(f, nx.time);
      t1++; if (nx.close >= v.dn && nx.close <= v.up) o1++;
    }
    // 当前形态已经持续了多少根（按当时的判定往回数）
    let streak = 0;
    const lr = rfits[rfits.length - 1];
    if (lr) for (let j = rfits.length - 1; j >= 0 && rfits[j].trending === lr.trending && (!lr.trending || rfits[j].up === lr.up); j--) streak++;
    const out = { ...cfg, key, src, ch, rg, fits, rfits, inSample: ch ? inIn / ch.n : NaN, oos1: t1 ? o1 / t1 : NaN, oosN: t1, streak };
    if (structCache.size > 60) structCache.clear();
    structCache.set(ck, out);
    return out;
  }
  let chart, candle, vol, ema9S, ema21S, stUpS, stDnS, priceLines = [];
  // 回归通道：当前通道（中轴 + 上下轨）+ 当时实际的通道轨迹（上下轨）+ 底部形态色带
  let chMidS, chUpS, chDnS, trUpS, trDnS, regimeS, futS;
  function initChart() {
    chart = LightweightCharts.createChart($("chart"), {
      layout: { background: { color: "#0e1117" }, textColor: "#9aa3b5" },
      grid: { vertLines: { color: "#1a1f2a" }, horzLines: { color: "#1a1f2a" } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "#262d3b" },
      timeScale: { borderColor: "#262d3b", timeVisible: true, secondsVisible: false, rightOffset: 8 },
      autoSize: true,
    });
    candle = chart.addCandlestickSeries({ upColor: "#26a69a", downColor: "#ef5350", borderVisible: false, wickUpColor: "#26a69a", wickDownColor: "#ef5350" });
    candle.attachPrimitive(fillLayer);  // 填充画在K线下面
    candle.attachPrimitive(lineLayer);  // 框线、价位线段画在上面
    // 鼠标悬停 / 手指点按某根K线时显示它的高低点和涨跌幅
    chart.subscribeCrosshairMove((param) => {
      const d = state.data[state.active];
      if (!d?.ltf?.length) return;
      const bars = chartBars?.length ? chartBars : d.ltf;
      hoverIdx = param.time != null ? bars.findIndex((x) => x.time + TZ === param.time) : -1;
      renderOhlc();
    });
    vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0.025 } });
    // 底部形态色带：每根K线当时（只用当时已收盘的数据）判定的趋势/震荡。无未来函数
    regimeS = chart.addHistogramSeries({ priceScaleId: "regime", lastValueVisible: false, priceLineVisible: false, base: 0 });
    chart.priceScale("regime").applyOptions({ scaleMargins: { top: 0.982, bottom: 0 }, visible: false });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.18 } });
    const lineOpt = { lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
    ema9S = chart.addLineSeries({ ...lineOpt, color: "#f5c542" });
    ema21S = chart.addLineSeries({ ...lineOpt, color: "#4c8dff" });
    stUpS = chart.addLineSeries({ ...lineOpt, color: "#26a69a", lineWidth: 2, lineStyle: 2 });
    stDnS = chart.addLineSeries({ ...lineOpt, color: "#ef5350", lineWidth: 2, lineStyle: 2 });
    // 通道不参与价格轴自动缩放（autoscaleInfoProvider 返回 null）。日线通道半宽 ±11%，
    // 参与缩放会把 15m 图的价格轴拉到 74000~98000、K 线压成一条线。价格轴只由 K 线决定，
    // 通道超出范围的部分自然裁掉。
    const chOpt = { ...lineOpt, autoscaleInfoProvider: () => null };
    chMidS = chart.addLineSeries({ ...chOpt, color: "rgba(0,217,255,.85)", lineWidth: 1, lineStyle: 2 });
    chUpS = chart.addLineSeries({ ...chOpt, color: "rgba(0,217,255,.95)", lineWidth: 2, lineStyle: 0 });
    chDnS = chart.addLineSeries({ ...chOpt, color: "rgba(0,217,255,.95)", lineWidth: 2, lineStyle: 0 });
    // 当时实际的通道（逐根滚动拟合的右端点）：这才是历史上每个时刻你真正能看到的位置
    trUpS = chart.addLineSeries({ ...chOpt, color: "rgba(150,170,190,.55)", lineWidth: 1, lineStyle: 1 });
    trDnS = chart.addLineSeries({ ...chOpt, color: "rgba(150,170,190,.55)", lineWidth: 1, lineStyle: 1 });
    // 只用来把时间轴往右撑出 FWD 根空白（通道外推、区间框延伸都画在这里）
    futS = chart.addLineSeries({ ...chOpt, visible: false });
  }

  // 15m 主图时「趋势通道」面板可以独立选的周期
  const CH_TF = { "1d": { label: "日线", key: "d1" }, "4h": { label: "4h", key: "h4" }, "1h": { label: "1h", key: "htf" } };
  const FWD = 8; // 通道外推 / 区间框向右延伸的根数（按主图周期）

  function syncChartTfBtns() {
    document.querySelectorAll("[data-ctf]").forEach((b) => b.classList.toggle("on", b.dataset.ctf === state.chartTf));
  }

  // 主图可切换的周期（通道/区间的参数统一在 STRUCT 里）
  const CHART_TF = {
    "3m": { label: "3m", key: "m3", sec: 180, bars: 200 },
    "15m": { label: "15m", key: "ltf", sec: LTF_SEC, bars: 160 },
    "1h": { label: "1h", key: "htf", sec: 3600, bars: 240 },
    "4h": { label: "4h", key: "h4", sec: 4 * 3600, bars: 240 },
    "1d": { label: "日线", key: "d1", sec: 86400, bars: 150 },
  };

  // 大周期方向：取当前（含未收盘）K线的 Supertrend
  function ctxNow(d) {
    const last = (arr) => { const x = arr?.[arr.length - 1]; return x?.ok ? x : null; };
    return { d1: last(d.ctx?.d1), h4: last(d.ctx?.h4), h1: d.live?.trend ?? 0 };
  }
  const arrow = (v) => (v > 0 ? '<span class="long">↑</span>' : v < 0 ? '<span class="short">↓</span>' : '<span class="muted">→</span>');
  function phaseOf(c) {
    if (!c.d1 || !c.h4 || !c.h1) return null;
    if (c.h1 === c.h4.st && c.h4.st === c.d1.st) return { txt: "全周期同向 · 趋势较成熟", cls: "muted" };
    if (c.h1 !== c.h4.st) return { txt: "1h 已转向、4h 未跟上 · 可能是趋势早期", cls: "wait" };
    return { txt: "1h/4h 与日线相反 · 日线级别的回调或反弹", cls: "wait" };
  }

  const stars = (l) => (l.strength >= 5 ? "★★★" : l.strength >= 3 ? "★★" : "★");

  // 当前价格上下最近的几个支撑压力位（用最后一根已收盘K线计算）
  function keyLevels(d, n = 3) {
    const k = d.ltf, res = d.res;
    let i = k.length - 1;
    if (k[i].time + LTF_SEC > Date.now() / 1000) i--;
    const lv = res.levelsAt(i), price = k[k.length - 1].close, atr = res.ind.atr[i];
    const near = lv.filter((l) => Math.abs(l.price - price) <= 6 * atr);
    const above = near.filter((l) => l.price > price).sort((a, b) => a.price - b.price).slice(0, n);
    const below = near.filter((l) => l.price <= price).sort((a, b) => b.price - a.price).slice(0, n);
    for (const l of [...above, ...below]) l.test = Levels.testState(l, k, i, atr).tests;
    return { above, below, price };
  }

  let chartSym = null, chartKey = "";
  const chartKeyOf = (d) => {
    const last = d.res.signals[d.res.signals.length - 1];
    const hk = d[(CHART_TF[state.chartTf] ?? CHART_TF["15m"]).key] ?? [];
    return `${state.active}|${state.chartTf}|${d.ltf.length}|${hk[hk.length - 1]?.time}|${d.res.signals.length}|${last?.result}|${last?.trailSl}|${d.lastStatus?.code}`;
  };

  // K线信息条：开高低收、涨跌幅（相对上一根收盘）、振幅（最高最低差 / 上一根收盘）
  let hoverIdx = -1;
  let chartBars = null;  // 当前主图实际画的那组K线（15m / 4h / 日线）
  let chartStats = null; // 当前主图周期的指标快照；15m 时为 null（直接用策略算好的）
  function renderOhlc() {
    const d = state.data[state.active];
    if (!d?.ltf?.length) return;
    const k = chartBars?.length ? chartBars : d.ltf, i = hoverIdx >= 0 && hoverIdx < k.length ? hoverIdx : k.length - 1;
    const x = k[i], prevClose = i > 0 ? k[i - 1].close : x.open;
    const chg = ((x.close - prevClose) / prevClose) * 100, amp = ((x.high - x.low) / prevClose) * 100;
    const cls = chg >= 0 ? "long" : "short";
    const vol = x.volume >= 1e6 ? (x.volume / 1e6).toFixed(2) + "M" : x.volume >= 1e3 ? (x.volume / 1e3).toFixed(1) + "K" : x.volume.toFixed(0);
    setHtml("ohlc", `<span>${fmtTime(x.time)}${i === k.length - 1 ? ' <span class="hover">最新</span>' : ""}</span>
      <span><span class="k">开</span>${fmtPrice(x.open)}</span>
      <span><span class="k">高</span><span class="long">${fmtPrice(x.high)}</span></span>
      <span><span class="k">低</span><span class="short">${fmtPrice(x.low)}</span></span>
      <span><span class="k">收</span><span class="${cls}">${fmtPrice(x.close)}</span></span>
      <span><span class="k">涨跌</span><span class="${cls}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span></span>
      <span class="ohlc-extra"><span class="k">振幅</span>${amp.toFixed(2)}%</span>
      <span class="ohlc-extra"><span class="k">量</span>${vol}</span>`);
  }

  function renderChart() {
    const sym = state.active, d = state.data[sym];
    if (!d?.res) return;
    const T = (t) => t + TZ;
    // 主图周期。15m = 原版行为；4h / 日线 = 看大结构，此时信号标记和 15m 指标不适用
    const ctf = CHART_TF[state.chartTf] ?? CHART_TF["15m"];
    const isLtf = ctf.key === "ltf";
    const narrowUi = matchMedia("(max-width: 900px)").matches; // 窄屏缩短价格线标签
    // 显示包含正在形成的那根（原来高周期图把它滤掉了，日线图上看不到今天）。
    // 通道/区间/形态只用已收盘K线算，见 structureFor
    const k = d[ctf.key] ?? [];
    if (!k.length) return;
    // 15m 用策略已算好的指标；高周期现算（同样的 TA 函数、同样的参数）
    const ind = isLtf ? d.res.ind : (() => {
      const c = k.map((x) => x.close), h = k.map((x) => x.high), l = k.map((x) => x.low);
      return { ema9: TA.ema(c, 9), ema21: TA.ema(c, 21), st: TA.supertrend(h, l, c, 10, 3), atr: TA.atr(h, l, c, 14) };
    })();
    // 底部指标条要跟着主图周期走，否则看着日线K线却读到 15m 的 RSI/ADX/ATR
    chartStats = isLtf ? null : (() => {
      const c = k.map((x) => x.close), h = k.map((x) => x.high), l = k.map((x) => x.low), v = k.map((x) => x.volume);
      const i = c.length - 1;
      const rsi = TA.rsi(c, 14), ax = TA.adx(h, l, c, 14), md = TA.macd(c), vma = TA.sma(v, 20);
      return {
        tf: ctf.label,
        rsi: rsi[i], adx: ax.adx[i], macdHist: md.hist[i],
        volRatio: vma[i] > 0 ? v[i] / vma[i] : NaN,
        atr: ind.atr[i], atrPct: (ind.atr[i] / c[i]) * 100,
        stDir: ind.st.dir[i],
      };
    })();

    chartBars = k; // 供 OHLC 信息条和十字光标用（它们要跟着主图周期走）
    const prec = decimals(k[k.length - 1].close);
    candle.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 10 ** -prec } });
    candle.setData(k.map((x) => ({ time: T(x.time), open: x.open, high: x.high, low: x.low, close: x.close })));
    vol.setData(k.map((x) => ({ time: T(x.time), value: x.volume, color: x.close >= x.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)" })));
    const line = (arr) => k.map((x, i) => (isNaN(arr[i]) ? { time: T(x.time) } : { time: T(x.time), value: arr[i] }));
    ema9S.setData(line(ind.ema9));
    ema21S.setData(line(ind.ema21));
    stUpS.setData(k.map((x, i) => (ind.st.dir[i] === 1 ? { time: T(x.time), value: ind.st.line[i] } : { time: T(x.time) })));
    stDnS.setData(k.map((x, i) => (ind.st.dir[i] === -1 ? { time: T(x.time), value: ind.st.line[i] } : { time: T(x.time) })));

    const Ly = state.layers;
    [ema9S, ema21S, stUpS, stDnS].forEach((x) => x.applyOptions({ visible: !!Ly.ma }));

    // 信号标记只在 15m 图上有意义（信号就是 15m 收盘判定的）
    const sigOn = isLtf && Ly.sig;
    const markers = !sigOn ? [] : d.res.signals.map((s) => ({
      time: T(s.time),
      position: s.side > 0 ? "belowBar" : "aboveBar",
      color: s.side > 0 ? "#26a69a" : "#ef5350",
      shape: s.side > 0 ? "arrowUp" : "arrowDown",
      text: `${s.side > 0 ? "多" : "空"}${s.score}`,
    }));
    if (sigOn && d.exit) markers.push({ time: T(d.exit.time), position: d.exit.side > 0 ? "aboveBar" : "belowBar", color: "#f5a623", shape: "circle", text: "弱" });
    if (sigOn) for (const ev of (d.rejections ?? []).filter((e) => e.first)) markers.push({
      time: T(ev.time), position: ev.isRes ? "aboveBar" : "belowBar", color: "#f5a623",
      shape: "square", size: ev.first ? 1 : 0.6, text: ev.first ? "🧱" : "",
    });
    markers.sort((a, b) => a.time - b.time);
    candle.setMarkers(markers);

    priceLines.forEach((pl) => candle.removePriceLine(pl));
    priceLines = [];
    const add = (price, color, title, style = 2, width = 1) =>
      priceLines.push(candle.createPriceLine({ price, color, title, lineWidth: width, lineStyle: style, axisLabelVisible: true }));
    // 只在价格轴上挂标签，线本身由 lineLayer 从"它开始存在的那根K线"画起
    const axisTag = (price, color, title) =>
      priceLines.push(candle.createPriceLine({ price, color, title, lineVisible: false, axisLabelVisible: true }));
    const F = chartFrame(k, ctf.sec), { snap, lastT, futEnd } = F;
    futS.setData(Array.from({ length: FWD }, (_, i) => ({ time: T(lastT + (i + 1) * ctf.sec) })));
    const items = [];
    const pxNow = k[k.length - 1].close, atrNow = ind.atr[ind.atr.length - 1];
    const nowSec = Date.now() / 1000;

    // ── 新结构图层（structure.js）：本周期 + 上两级周期投影 ─────────────────────
    const S = structOf(sym, state.chartTf);
    const htfList = Ly.htf ? (HTF_OF[state.chartTf] ?? []).map((tf) => ({ tf, S: structOf(sym, tf) })) : [];
    const ownZ = S && Ly.zone ? [...S.zones.above, ...S.zones.below, ...(S.zones.inside ? [S.zones.inside] : [])] : [];
    const htfZ = htfList.flatMap(({ tf, S: H }) => (H ? [...H.zones.above.slice(0, 2), ...H.zones.below.slice(0, 2)].map((z) => ({ ...z, tf })) : []));
    const own = structItems(S, k, ctf.sec, Ly, { narrow: narrowUi, swingOn: !!Ly.swing, htfZones: htfZ });
    const hi = Ly.htf ? htfItems(htfList, k, ctf.sec, { own: ownZ, withTl: state.chartTf === "3m" && !!Ly.tl }) : { items: [], tags: [] };
    // 大周期色带先画（在下面），本周期的线压在上面
    items.push(...hi.items, ...own.items);
    // 价格轴标签：太多会叠成一团，离现价 8 ATR 以外的不挂
    // 价格轴只挂价格（性质已经写在图里的胶囊上），相距 < 0.3 ATR 的只挂一个，离现价 8 ATR 以外不挂
    const tagged = [];
    for (const [p, c] of [...own.tags, ...hi.tags]) {
      if (Math.abs(p - pxNow) > 8 * atrNow || tagged.some((q) => Math.abs(q - p) < 0.3 * atrNow)) continue;
      tagged.push(p); axisTag(p, c, "");
    }

    // ── 旧版画法（策略价位 / 回归通道），默认关闭 ─────────────────────────────
    if (Ly.old) {
      // 15m 级支撑压力位：只在 15m 图上画。★ 级回测和随机价位差不多，不画；★★★ 用粗实线强调
      const kl = isLtf ? keyLevels(d) : { above: [], below: [] };
      const drawLv = (l, isRes) => {
        if (l.strength < 3) return;
        const strong = l.strength >= 5;
        const color = isRes ? (strong ? "rgba(239,83,80,.95)" : "rgba(239,83,80,.45)") : strong ? "rgba(38,166,154,.95)" : "rgba(38,166,154,.45)";
        const name = narrowUi
          ? `${strong ? "强" : ""}${isRes ? "压" : "撑"}${stars(l)}`
          : `${strong ? "强" : ""}${isRes ? "压力" : "支撑"}${stars(l)}${l.tags.length ? " " + l.tags.join("/") : ""}`;
        add(l.price, color, name, strong ? 0 : 1, strong ? 3 : 1);
      };
      kl.above.forEach((l) => drawLv(l, true));
      kl.below.forEach((l) => drawLv(l, false));
      // 高周期关键位（4h + 日线）。硬位（日线/周高低参与）紫色粗线，软位（纯 4h）灰紫细线
      const nLv = (!isLtf || narrowUi) ? 2 : 3;
      const hLv = Levels.htf(d.h4, d.d1, nowSec).filter((l) => Math.abs(l.price - pxNow) <= 15 * atrNow);
      [...hLv.filter((l) => l.price > pxNow).sort((a, b) => a.price - b.price).slice(0, nLv),
       ...hLv.filter((l) => l.price <= pxNow).sort((a, b) => b.price - a.price).slice(0, nLv)]
        .forEach((l) => {
          const isRes = l.price > pxNow;
          const nm = narrowUi ? `${l.hard ? "硬" : ""}${isRes ? "压" : "撑"}` : `${l.srcs.join("+")}${isRes ? "压力" : "支撑"}`;
          const color = l.hard ? "rgba(188,148,255,.98)" : "rgba(188,148,255,.62)";
          axisTag(l.price, color, nm);
          items.push({ t: "line", t0: T(snap(l.from)), p0: l.price, t1: T(futEnd), p1: l.price, color, width: l.hard ? 2.5 : 1.5 });
        });
    }

    // 回归通道 / Donchian 震荡框（旧版）
    // 4h/日线/1h 图：用该周期自己的结构；15m 图：用面板里选的日线/4h 结构（通常在屏幕外）
    const sKey = isLtf ? (CH_TF[state.chTf] ?? CH_TF["1d"]).key : ctf.key;
    const S0 = Ly.reg ? structureFor(sym, sKey) : null;
    const closeOf = (x) => Math.min(x.time + ctf.sec, nowSec); // 这根K线收盘的时刻（未收盘就是现在）
    if (S0 && S0.ch) {
      const ch = S0.ch;
      // 当前通道：只画拟合窗口 + 向右外推 FWD 根
      const times = k.filter((x) => x.time >= ch.from).map((x) => x.time);
      for (let i = 1; i <= FWD; i++) times.push(lastT + i * ctf.sec);
      const at = times.map((t) => ({ t, v: ch.lineAt(t) }));
      chMidS.setData(at.map(({ t, v }) => ({ time: T(t), value: v.mid })));
      chUpS.setData(at.map(({ t, v }) => ({ time: T(t), value: v.up })));
      chDnS.setData(at.map(({ t, v }) => ({ time: T(t), value: v.dn })));
      // 15m 图上日线/4h 通道比可见范围大一个量级，填充会把整张图染掉 —— 15m 上不画填充
      if (!isLtf) items.push({ t: "band", fill: ch.slopeUp ? "rgba(0,217,255,.07)" : "rgba(255,110,110,.07)", pts: at.map(({ t, v }) => ({ time: T(t), up: v.up, dn: v.dn })) });
      if (ch.from >= k[0].time) items.push({ t: "vline", time: T(snap(ch.from)), color: "rgba(0,217,255,.45)", label: narrowUi ? "" : `通道起点 · ${S0.label}${ch.n}根` });
      // 当时实际的通道：每根K线收盘时用当时的 n 根拟合，取右端点。这才是历史上真实能看到的位置
      const tr = k.map((x) => { const f = Levels.asOf(S0.fits, closeOf(x)); return f ? { time: T(x.time), ...Levels.evalFit(f, x.time) } : { time: T(x.time) }; });
      trUpS.setData(tr.map((p) => (p.up != null ? { time: p.time, value: p.up } : { time: p.time })));
      trDnS.setData(tr.map((p) => (p.dn != null ? { time: p.time, value: p.dn } : { time: p.time })));
    } else {
      [chMidS, chUpS, chDnS, trUpS, trDnS].forEach((x) => x.setData([]));
    }
    // 底部形态色带：每根K线当时的判定（绿=趋势↑ 红=趋势↓ 橙=震荡），无未来函数
    regimeS.setData(S0 ? k.map((x) => {
      const r = Levels.asOf(S0.rfits, closeOf(x));
      return r ? { time: T(x.time), value: 1, color: r.trending ? (r.up ? "rgba(38,166,154,.85)" : "rgba(239,83,80,.85)") : "rgba(255,170,40,.85)" } : { time: T(x.time) };
    }) : []);
    const rg = S0?.rg;
    if (rg && !rg.trending) {
      const t0 = S0.src[S0.src.length - rg.n].time;
      const span = S0.key === "d1" ? `近${rg.n}日` : `近${rg.n}根${S0.label}`;
      const label = narrowUi ? `${span}震荡` : `${span}Donchian震荡 · 宽${rg.widthPct.toFixed(1)}%`;
      items.push({ t: "rect", t0: T(snap(t0)), t1: T(futEnd), hi: rg.hi, lo: rg.lo, fill: isLtf ? null : "rgba(255,170,40,.05)", stroke: "rgba(255,170,40,.6)", dash: 1, label, la: "left" });
    }
    fillLayer.set(items);
    lineLayer.set(items);

    // 当前信号 / 持仓
    const last = d.res.signals[d.res.signals.length - 1], st = d.lastStatus;
    if (!Ly.sig) { /* 信号图层关闭 */ }
    else if (last && st && st.code !== "done" && st.code !== "expired") {
      add(last.entry, "#c9d1e0", "信号价", 0);
      if (st.code === "manage") {
        add(st.stop, "#f5a623", "移动止损", 0, 2);
      } else {
        add(last.sl, "#ef5350", "止损", 0, 2);
        add(last.tp1, "#26a69a", "TP1", 0, 2);
        if (st.code === "go") add(st.chaseLimit, "#f5a623", "最多追到", 3);
      }
    } else if (last && st?.code === "expired" && last.r == null) {
      add(last.sl, "#ef5350", "止损(持仓者)", 2);
      add(last.tp1, "#26a69a", "TP1(持仓者)", 2);
    }

    if (chartSym !== sym + "|" + state.chartTf) {
      const narrow = matchMedia("(max-width: 900px)").matches;
      const bars = Math.min(k.length, narrow ? Math.round(ctf.bars / 2) : ctf.bars);
      chart.timeScale().setVisibleLogicalRange({ from: k.length - bars, to: k.length + 8 });
      chartSym = sym + "|" + state.chartTf;
    }
    chartKey = chartKeyOf(d);
    renderOhlc();
  }

  const isShort = () => state.chartTf === "15m" || state.chartTf === "3m";

  // 结构文字
  const biasHtml = (S) => `<b class="${S.bias > 0 ? "long" : S.bias < 0 ? "short" : "wait"}">${S.biasTxt}</b>`;
  const evTxt = (e, sec = 900) => `<span class="${e.dir > 0 ? "long" : "short"}">${e.kind}${e.dir > 0 ? "↑" : "↓"}</span> <span class="muted">${sec >= 14400 ? fmtTime(e.time).slice(0, 5) : fmtTime(e.time).slice(6)}</span>`;
  // 3m 对 15m 的确认：15m 有方向时，3m 最近 20 根内出现同向 BOS/CHoCH = 确认；出现反向 CHoCH = 警告
  function confirm3(S15, S3, k3) {
    if (!S15 || !S3) return null;
    const e = S3.lastEv, fresh = e && k3.length - 1 - k3.findIndex((x) => x.time === e.time) <= 20;
    const dir = S15.bias;
    if (!dir) return { txt: S15.activeZs ? "15m 在中枢里：3m 只做区间上下沿" : "15m 方向不明，3m 信号只看不做", cls: "muted" };
    if (fresh && e.dir === dir) return { txt: `✔ 3m ${e.kind}${dir > 0 ? "↑" : "↓"} 与 15m 同向`, cls: dir > 0 ? "long" : "short" };
    if (fresh && e.dir !== dir && e.kind === "CHoCH") return { txt: `⚠ 3m 逆 15m 出现 CHoCH，等 3m 结构转回`, cls: "wait" };
    return { txt: `等 3m 出现${dir > 0 ? "向上" : "向下"}突破再确认`, cls: "muted" };
  }

  // ---------------- 面板渲染 ----------------
  const STATUS_UI = {
    go: { icon: "✅", cls: "st-go" },
    weak: { icon: "⚠️", cls: "st-weak" },
    chased: { icon: "⛔", cls: "st-chased" },
    expired: { icon: "⌛", cls: "st-muted" },
    manage: { icon: "🎯", cls: "st-manage" },
    done: { icon: "", cls: "st-muted" },
  };

  function statusBadge(sig, st, compact) {
    const ui = STATUS_UI[st.code];
    let txt = `${ui.icon} ${sideTxt(sig.side)} · ${st.label}${sig.hot && st.code === "go" ? " · 🔥过热" : ""}`;
    if (st.code === "go") txt += ` · 还剩${st.minLeft}分钟`;
    return `<div class="badge ${ui.cls}">${txt}</div>`;
  }

  function renderWatchlist() {
    let html = "", lastGroup = null;
    const order = { crypto: 0, us: 1, kr: 2, hk: 3, other: 4 };
    const syms = [...state.symbols].sort((a, b) => (order[marketOf(a)] ?? 9) - (order[marketOf(b)] ?? 9));
    for (const sym of syms) {
      const g = marketOf(sym);
      if (g !== lastGroup) { html += `<div class="group">${MARKET_NAMES[g] ?? g}</div>`; lastGroup = g; }
      const d = state.data[sym];
      const L = d?.live;
      if (!L) {
        html += `<div class="card" data-sym="${sym}"><div class="row"><span class="sym">${short(sym)}<span class="cn">${CN_NAMES[sym] ?? ""}</span></span></div><div class="status muted">${d?.error ?? "加载中…"}</div><span class="del" data-del="${sym}">✕</span></div>`;
        continue;
      }
      const k = d.ltf;
      const ref = k[Math.max(0, k.length - 97)].open;
      const chg = ((L.price - ref) / ref) * 100; // 24h
      const last = d.res.signals[d.res.signals.length - 1];
      const st = d.lastStatus;
      const sess = sessionOf(sym);
      const bar = (sc, color) => `<div class="bar"><div style="width:${sc}%;background:${color}"></div></div>`;
      const activeSig = last && st && !["done", "expired"].includes(st.code);
      const flash = (state.flashUntil[sym] ?? 0) > Date.now() ? "flash" : "";
      html += `<div class="card tone-${L.tone} ${sym === state.active ? "active" : ""} ${flash}" data-sym="${sym}">
        <span class="del" data-del="${sym}" title="移除">✕</span>
        <div class="row"><span class="sym">${short(sym)}<span class="cn">${CN_NAMES[sym] ?? ""}</span></span>
          <span class="price num">${fmtPrice(L.price)}</span></div>
        <div class="row"><span class="status ${L.tone === "flat" ? "muted" : L.tone}">${L.status}${L.htfStrong ? " ·强" : ""}</span>
          <span class="num small ${chg >= 0 ? "long" : "short"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span></div>
        <div class="tf-row">${(() => { const c = ctxNow(d); return `<span>日${arrow(c.d1?.st ?? 0)}</span><span>4h${arrow(c.h4?.st ?? 0)}</span><span>1h${arrow(c.h1)}</span>`; })()}
          ${sess ? `<span class="sess sess-${sess.cls}">${sess.txt}</span>` : ""}</div>
        <div class="bars"><span class="long">多</span>${bar(L.long.score, "var(--long)")}<span class="num">${L.long.score}</span>
          <span class="short">空</span>${bar(L.short.score, "var(--short)")}<span class="num">${L.short.score}</span></div>
        ${activeSig ? statusBadge(last, st, true) : ""}
        ${!activeSig && L.forming ? `<div class="forming">⏳ 预警：${sideTxt(L.forming.side)}（${L.forming.trigger}）正在形成，收盘才算</div>` : ""}
        ${last && !activeSig ? `<div class="last">上次：<span class="${sideCls(last.side)}">${sideTxt(last.side)}</span> ${fmtTime(last.time)} · ${last.result ?? ""}</div>` : ""}
      </div>`;
    }
    setHtml("watchlist", html);
  }

  // 内容没变就不重建 DOM（避免每秒重绘打断点击和动画）
  const htmlCache = {};
  function setHtml(id, html) {
    if (htmlCache[id] === html) return;
    if (document.activeElement?.closest?.(`#${id}`) && document.activeElement.tagName === "INPUT") return; // 正在输入时不重绘
    htmlCache[id] = html;
    $(id).innerHTML = html;
  }

  function adviceFor(sig, st, p) {
    const side = sig.side, dir = side > 0 ? "下方" : "上方";
    switch (st.code) {
      case "go":
        return `现价 ${fmtPrice(st.price)}（已走 ${st.prog.toFixed(2)}R），可以直接市价进。<br>
          最多追到 <b>${fmtPrice(st.chaseLimit)}</b>，超过就别追；入场窗口还剩 ${st.minLeft} 分钟。<br>
          <span class="muted">不建议挂低价等回踩：回测里回踩成交的多是失败单，走掉的反而是好单。</span>`;
      case "weak":
        return `价格回到信号价${dir}，回测中这种情况胜率明显下降。<br>还没进场的<b>先别进</b>；已进场的按止损 ${fmtPrice(sig.sl)} 执行，不要扛单。`;
      case "chased":
        return `价格已经走了 ${st.prog.toFixed(1)}R，现在进盈亏比太差，<b>别追</b>，等下一个信号。<br>已进场的：继续按止损 ${fmtPrice(sig.sl)} / TP1 ${fmtPrice(sig.tp1)} 执行。`;
      case "expired":
        return `入场窗口已过，未进场的不要再进。<br>已进场的：止损 ${fmtPrice(sig.sl)}，TP1 ${fmtPrice(sig.tp1)}。`;
      case "manage":
        return `TP1 已到。持仓者：已平一半，剩余仓位止损跟在 <b>${fmtPrice(st.stop)}</b>（吊灯移动止损，${p.trailAtr} 倍 ATR）。<br>未进场的不要追。`;
      default:
        return `这一单已结束：${sig.result}${sig.r != null ? `（${sig.r >= 0 ? "+" : ""}${sig.r.toFixed(2)}R，已扣费）` : ""}。等下一个信号。`;
    }
  }

  function renderSide() {
    const sym = state.active, d = state.data[sym];
    const sess = sessionOf(sym);
    const lg = (c, t) => `<span><i style="background:${c}"></i>${t}</span>`;
    const Ly = state.layers, htfs = (HTF_OF[state.chartTf] ?? []).map((t) => TFS[t].label).join("/");
    const lgParts = [];
    if (Ly.zone) lgParts.push(lg("rgba(239,83,80,.8)", "压力区") + lg("rgba(38,166,154,.8)", "支撑区"));
    if (Ly.htf && htfs) lgParts.push(lg(rgba(COL.htf[0], .9), `${htfs} 大周期区`));
    if (Ly.tl) lgParts.push('<span class="muted">趋势线：实线≥3触 虚线=候选 灰=已破</span>');
    if (Ly.zs) lgParts.push(lg(rgba(COL.zs, .9), "中枢 ZD~ZG"));
    if (Ly.ma) lgParts.push(lg("#f5c542", "EMA9") + lg("#4c8dff", "EMA21"));
    if (Ly.sig && state.chartTf === "15m") lgParts.push('<span class="muted">▲▼ 信号 · ● 转弱 · 🧱 强价位被拒</span>');
    lgParts.push('<span class="muted legend-note">结构图层只用已收盘K线 · 阈值未经收益回测，只做显示</span>');
    setHtml("legend", lgParts.join(""));
    $("chartTitle").innerHTML = `${short(sym)} <span class="muted small">${CN_NAMES[sym] ?? ""} · ${MARKET_NAMES[marketOf(sym)]}永续 · ${isShort() ? "短线 " : "长线 "}${(CHART_TF[state.chartTf] ?? CHART_TF["15m"]).label}${sess ? " · " + sess.txt : ""}</span>`;
    renderStructPanel();
    if (!d?.live) { setHtml("liveScore", `<span class="muted">${d?.error ?? "加载中…"}</span>`); return; }
    const L = d.live, p = d.res.params;

    // 最新信号 + 操作建议
    const last = d.res.signals[d.res.signals.length - 1], st = d.lastStatus;
    if (!last) setHtml("lastSignal", '<span class="muted">近期暂无信号</span>');
    else {
      const stopSrc = last.behind && Math.abs(last.sl - last.behind.price) < 1.2 * last.risk && p.srStop ? `${last.side > 0 ? "支撑" : "压力"}位外` : "结构位外";
      const ahead = last.ahead && isFinite(last.roomR) ? `${last.side > 0 ? "前方压力" : "前方支撑"} ${fmtPrice(last.ahead.price)}（${last.roomR.toFixed(1)}R）` : "";
      setHtml("lastSignal", `<div class="sig-box">
        <div class="title ${sideCls(last.side)}">${sideTxt(last.side)} · ${last.trigger} · ${last.score}分</div>
        <div class="muted small" style="margin-bottom:6px">${fmtTime(last.time)} 收盘确认</div>
        ${statusBadge(last, st, false)}
        <div class="advice">${adviceFor(last, st, p)}</div>
        <div class="levels num">
          <span class="muted">信号价</span><span>${fmtPrice(last.entry)}</span><span></span>
          <span class="short">止损</span><span>${fmtPrice(last.sl)}</span><span class="muted">${fmtPct(last.sl, last.entry)} · ${stopSrc}</span>
          <span class="long">TP1 (1R)</span><span>${fmtPrice(last.tp1)}</span><span class="muted">${fmtPct(last.tp1, last.entry)} · 平一半</span>
          <span class="long">剩余半仓</span><span>移动止损</span><span class="muted">${p.trailAtr}×ATR 跟踪</span>
        </div>
        ${(() => {
          const z = sizeFor(last);
          if (!z || st.code === "done" || st.code === "expired") return "";
          return `<div class="size-box">每笔亏 <input id="riskInput" type="number" min="1" step="1" value="${sizing.risk}" />U 的仓位：
            <b class="num">${fmtQty(z.qty, last.entry)}</b> 个 · 约 <b class="num">${z.notional.toFixed(0)}</b>U · 手续费约 ${z.fee.toFixed(2)}U
            <div class="muted small">按信号价到止损 ${fmtPct(last.sl, last.entry)} 计算；杠杆只影响保证金，${z.lev}x 时约需 ${(z.notional / z.lev).toFixed(0)}U</div></div>`;
        })()}
        ${st.code !== "done" && st.code !== "expired" ? `<button class="btn copy-btn" data-copy="${sideTxt(last.side)} ${short(sym)} 入场 ${fmtPrice(last.entry)} 止损 ${fmtPrice(last.sl)} TP1 ${fmtPrice(last.tp1)}${sizeFor(last) ? " 数量 " + fmtQty(sizeFor(last).qty, last.entry) : ""}">📋 复制下单参数</button>` : ""}
        ${ahead ? `<div class="muted small" style="margin-top:4px">${ahead}</div>` : ""}
        ${last.hot ? `<div class="warn">🔥 过热追单：信号K线主动${last.side > 0 ? "买入" : "卖出"}占比 ${(((last.flow + 1) / 2) * 100).toFixed(0)}%，回测这类信号胜率偏低，建议减半仓或放弃</div>` : ""}
        ${d.exit && d.exit.i > last.i && st.code !== "done" ? `<div class="warn">● 趋势转弱：${d.exit.reason}（${fmtTime(d.exit.time)}）</div>` : ""}
      </div>`);
    }

    // 合约资金面（加密货币）
    if (marketOf(sym) === "crypto") {
      $("flowPanel").style.display = "";
      const k = d.ltf, cur = k[k.length - 1];
      const ratio = (n) => { let b = 0, v = 0; for (let j = Math.max(0, k.length - n); j < k.length; j++) { b += k[j].takerBuy || 0; v += k[j].volume; } return v ? (b / v) * 100 : null; };
      const r1 = ratio(1), r4 = ratio(4), r16 = ratio(16);
      const rCls = (r) => (r == null ? "" : r >= 60 ? "long" : r <= 40 ? "short" : "");
      const fl = d.flow, o5 = oiChange(d, 300), o15 = oiChange(d, 900), o1 = oiChange(d, 3600), o4 = oiChange(d, 4 * 3600);
      const liveAge = fl?.liveAt ? Math.round((Date.now() - fl.liveAt) / 1000) : null;
      const pxChg = (n) => (k.length > n ? ((cur.close / k[k.length - 1 - n].close - 1) * 100) : null);
      const p1 = pxChg(4);
      let read = "";
      if (o1 != null && p1 != null) {
        if (p1 > 0.2 && o1 > 0.3) read = "价格涨 + 持仓增：新多头进场推动";
        else if (p1 > 0.2 && o1 < -0.3) read = "价格涨 + 持仓减：空头平仓推动（轧空），持续性通常较弱";
        else if (p1 < -0.2 && o1 > 0.3) read = "价格跌 + 持仓增：新空头进场推动";
        else if (p1 < -0.2 && o1 < -0.3) read = "价格跌 + 持仓减：多头止损/平仓推动";
        else read = "价格和持仓变化都不大";
      }
      const fundMin = fl ? Math.max(0, Math.round((fl.nextFunding - Date.now() / 1000) / 60)) : null;
      const fundRate = fl ? fl.funding * 100 : null;
      setHtml("flow", `<div class="ctx-grid flow-grid">
          <span class="muted">主动买入占比</span><span class="muted">当前K线</span><span class="muted">近1h</span><span class="muted">近4h</span>
          <span></span><span class="num ${rCls(r1)}">${r1?.toFixed(0) ?? "-"}%</span><span class="num ${rCls(r4)}">${r4?.toFixed(0) ?? "-"}%</span><span class="num ${rCls(r16)}">${r16?.toFixed(0) ?? "-"}%</span>
        </div>
        <div class="ctx-grid flow-grid" style="margin-top:6px">
          <span class="muted">持仓量变化</span><span class="muted">5分钟</span><span class="muted">15分钟</span><span class="muted">1小时</span>
          <span class="muted small">${liveAge == null ? "加载中" : liveAge <= 20 ? `<span class="long">● 实时</span> ${liveAge}秒前` : `<span class="wait">● ${liveAge}秒前</span>`}</span><span class="num">${pctTxt(o5)}</span><span class="num">${pctTxt(o15)}</span><span class="num">${pctTxt(o1)}</span>
        </div>
        ${oiSpark(d)}<div class="muted small" style="display:flex;justify-content:space-between"><span>持仓量 近 2 小时</span><span>4h ${pctTxt(o4)}</span></div>
        ${read ? `<div class="phase">${read}</div>` : ""}
        <div class="tf-line" style="grid-template-columns:1fr 1fr"><span>资金费率 <b class="num ${fundRate > 0.03 ? "long" : fundRate < -0.01 ? "short" : ""}">${fundRate == null ? "-" : fundRate.toFixed(4) + "%"}</b></span>
          <span class="muted">${fundMin == null ? "" : `距结算 ${Math.floor(fundMin / 60)}小时${fundMin % 60}分`}</span></div>
        <div class="muted small" style="margin-top:4px">主动买入占比 ≥60%（做空时 ≤40%）的信号K线会标「过热」：6 个月回测里这类信号每笔 -0.15R，明显差于其他信号。持仓量每 10 秒更新；它和价格的组合目前没有找到稳定规律（见 README），仅供参考。</div>`);
    } else {
      $("flowPanel").style.display = "none";
    }

    // 大周期背景
    const c = ctxNow(d), ph = phaseOf(c);
    const tfLine = (name, x) => x
      ? `<div class="tf-line"><span>${name}</span><span>Supertrend ${arrow(x.st)}</span><span>EMA20/50 ${arrow(x.stack)}</span><span>价格${x.px20 > 0 ? "在EMA20上" : "在EMA20下"}</span></div>`
      : `<div class="tf-line"><span>${name}</span><span class="muted">数据不足</span></div>`;
    const nowS = Date.now() / 1000;
    const px = d.ltf[d.ltf.length - 1].close;
    const hl = Levels.htf(d.h4, d.d1, nowS);
    const hAbove = hl.filter((l) => l.price > px).sort((a, b) => a.price - b.price).slice(0, 3);
    const hBelow = hl.filter((l) => l.price <= px).sort((a, b) => b.price - a.price).slice(0, 3);
    const dRow = (l, cls, label) => `<div class="lv-row ${l.hard ? "lv-strong" : ""}"><span class="${cls}">${label}</span><span class="num">${fmtPrice(l.price)}</span><span class="muted num">${fmtPct(l.price, px)}</span><span class="muted small">${l.srcs.join("+")}${l.hard ? " · 硬" : ""}</span></div>`;

    // 回归通道 + 震荡区间。
    // 主图在 4h/日线时，这里直接跟随主图 —— 两套独立的周期选择会让人以为
    // 面板上的斜率/r² 是主图那条通道的，其实不是。主图是 15m 时主图没有自己的
    // 通道，这时才保留独立选择。
    const follow = state.chartTf !== "15m";
    const panelTf = follow ? state.chartTf : state.chTf;
    const cfg = CH_TF[panelTf] ?? CH_TF["1d"];
    const SP = structureFor(state.active, cfg.key); // 和图上画的是同一份数据
    const ch = SP?.ch, rg = SP?.rg;
    const tfBtn = (k) => `<button class="btn tf-btn${panelTf === k ? " on" : ""}" data-chtf="${k}">${CH_TF[k].label}</button>`;
    let chTxt = follow
      ? `<div class="sub-h">趋势通道 / 震荡区间 <span class="muted small">跟随主图（${cfg.label}）</span></div>`
      : `<div class="sub-h">趋势通道 / 震荡区间 ${tfBtn("1d")}${tfBtn("4h")}</div>`;
    if (ch && rg) {
      const pos = ch.lineAt(nowS);
      // 现价在通道里的相对位置：0 = 下沿，1 = 上沿
      const posPct = (px - pos.dn) / (pos.up - pos.dn) * 100;
      const fit = ch.r2 >= 0.5 ? "贴合" : ch.r2 >= 0.2 ? "一般" : "很差";
      chTxt +=
        `<div class="tf-line"><span>${cfg.label}通道</span>` +
        `<span>斜率 <b class="${ch.pctPerDay >= 0 ? "long" : "short"}">${ch.pctPerDay >= 0 ? "+" : ""}${ch.pctPerDay.toFixed(2)}%/日</b></span>` +
        `<span class="muted">r²=${ch.r2.toFixed(2)}（${fit}）</span>` +
        `<span class="muted">半宽 ±${ch.bandPct.toFixed(1)}%</span></div>` +
        `<div class="tf-line"><span>现价位置</span><span>${posPct.toFixed(0)}% ` +
        `<span class="muted">(0=下沿 100=上沿)</span></span>` +
        `<span class="muted">上沿 ${fmtPrice(pos.up)} / 下沿 ${fmtPrice(pos.dn)}</span></div>` +
        `<div class="tf-line"><span>${cfg.label}形态</span>` +
        `<span><b class="${rg.trending ? (rg.up ? "long" : "short") : "wait"}">${rg.trending ? (rg.up ? "趋势↑" : "趋势↓") : "震荡"}</b></span>` +
        `<span class="muted">效率比 ${rg.er.toFixed(2)}</span>` +
        `<span class="muted">${rg.trending ? `近${rg.n}根 · 已持续${SP.streak}根` : `近${rg.n}根 ${fmtPrice(rg.lo)}~${fmtPrice(rg.hi)}（宽 ${rg.widthPct.toFixed(1)}%）· 已${SP.streak}根`}</span></div>` +
        // 可靠性：事后看（线是用这些点拟合的，必然高）vs 当时实际（只用当时数据，下一根还在带内的比例）
        `<div class="tf-line"><span>可靠性</span>` +
        `<span>当时 <b class="${SP.oos1 >= 0.85 ? "long" : SP.oos1 >= 0.75 ? "wait" : "short"}">${(SP.oos1 * 100).toFixed(0)}%</b></span>` +
        `<span class="muted">事后看 ${(SP.inSample * 100).toFixed(0)}%</span>` +
        `<span class="muted small">下一根收盘落在通道内（${SP.oosN} 次）</span></div>` +
        `<div class="muted small" style="margin-top:4px">通道是对 log 收盘价做最小二乘回归（${cfg.label} ${ch.n} 根），不是手连的趋势线：结果唯一、可复现。` +
        `<b>图上亮青色的是"现在"的通道</b>，它是用这 ${ch.n} 根拟合出来的，所以历史K线看起来"刚好在轨道里反弹"——那是事后画线，当时并不存在。` +
        `<b>灰色点线是"当时"的通道</b>（每根K线收盘时只用当时数据拟合），历史上真实能看到的是它。` +
        `「可靠性」两个数的差距就是事后画线的错觉有多大。底部色带是每根K线当时的形态判定（绿=趋势↑ 红=趋势↓ 橙=震荡）。` +
        `<b>效率比</b>=净位移/路径总长，越接近 1 越单边。<b>这些阈值都没经过回测验证，不参与信号判定。</b>` +
        `${follow ? "" : "<br>当前主图是 15m，通道半宽 ±" + ch.bandPct.toFixed(0) + "% 远超 15m 的可见区间 —— 点图表左上角的「4h」或「日线」看完整通道。"}</div>`;
    } else {
      chTxt += '<span class="muted small">数据不足</span>';
    }

    setHtml("bigPicture",
      tfLine("日线", c.d1) + tfLine("4h", c.h4) +
      `<div class="tf-line"><span>1h</span><span>趋势 ${arrow(c.h1)}</span><span class="muted">（信号方向过滤用的就是它）</span></div>` +
      (ph ? `<div class="phase ${ph.cls}">${ph.txt}</div>` : "") +
      chTxt +
      `<div class="sub-h">高周期关键位（4h 摆动点 + 日线摆动点 + 周高低）</div>` +
      ([...hAbove].reverse().map((l) => dRow(l, "short", "压力")).join("") +
        hBelow.map((l) => dRow(l, "long", "支撑")).join("") || '<span class="muted small">数据不足</span>') +
      `<div class="muted small" style="margin-top:4px">"硬"= 日线或周高低参与过的位，粗紫线；纯 4h 堆出来的是软位，细线。比原版只看 15m/1h 位更不容易被插针扫掉，但<b>回测显示把前方有压力当成不开仓的理由会让每笔从 -0.06R 恶化到 -0.29R</b>——趋势里价格本来就在不断破位。所以这里只做展示和止损参考，不参与方向判定。</div>`);

    // 关键价位
    const kl = keyLevels(d, 3);
    const testTxt = (l) => (l.test === 0 ? "" : l.test === 1 ? "正在测试" : `已磨 ${l.test} 根`);
    const lvRow = (l, cls, label) => `<div class="lv-row ${l.strength >= 5 ? "lv-strong" : l.strength < 3 ? "lv-weak" : ""}"><span class="${cls}">${l.strength >= 5 ? "强" : ""}${label} ${stars(l)}</span><span class="num">${fmtPrice(l.price)}</span><span class="muted num">${fmtPct(l.price, kl.price)}</span><span class="muted small">${[l.tags.join("/"), testTxt(l)].filter(Boolean).join(" · ")}</span></div>`;
    const lastRej = (d.rejections ?? []).slice(-1)[0];
    const rejTxt = lastRej && d.ltf.length - 1 - lastRej.i <= 8
      ? `<div class="warn" style="background:#3a2c10;color:#f5c542">🧱 ${fmtTime(lastRej.time)} 在强${lastRej.isRes ? "压力" : "支撑"} ${fmtPrice(lastRej.level.price)} 被拒${lastRej.first ? "（首次测试）" : ""}——${lastRej.isRes ? "涨不动" : "跌不动"}</div>` : "";
    setHtml("keyLevels",
      [...kl.above].reverse().map((l) => lvRow(l, "short", "压力")).join("") +
      `<div class="lv-row lv-now"><span>现价</span><span class="num">${fmtPrice(kl.price)}</span><span></span><span></span></div>` +
      kl.below.map((l) => lvRow(l, "long", "支撑")).join("") +
      rejTxt +
      `<div class="muted small" style="margin-top:4px">回测（16 个品种 90 天，碰到后 3 小时内被突破的概率）：随机价位约 39%，★ 级约 48%（不比随机好，图上不画），<b>★★★ 约 33%，第一次碰到约 26%</b>，第一次碰到且长影线收回（🧱）约 10%。之前已经磨过的约 40%；K线一旦收盘越过，价位基本失效。</div>`);

    // 实时共振
    const col = (side, sc) => `<div class="score-col"><div class="head ${sideCls(side)}"><span>${sideTxt(side)}</span><span class="num">${sc.score}/100</span></div>
      ${sc.items.map((it) => `<div class="check ${it.ok ? "ok" : ""}"><span>${it.label}</span><span class="num">+${it.pts}</span></div>`).join("")}</div>`;
    setHtml("liveScore", `<div class="score-cols">${col(1, L.long)}${col(-1, L.short)}</div>
      <div class="muted small" style="margin-top:6px">阈值 ${state.params.scoreThreshold} 分；还需满足 ADX≥${p.minAdx}、1h Supertrend 同向，并出现回踩确认或放量突破，K线收盘才算信号</div>`);

    // 指标条：数值必须和主图周期一致。高周期时用 chartStats（renderChart 里现算的），
    // 并且去掉「手续费/止损」—— 那一项是 15m 策略的止损宽度口径，在日线图上没有意义
    const S = chartStats;
    const arrowTxt = (v) => (v > 0 ? '<span class="long">向上</span>' : v < 0 ? '<span class="short">向下</span>' : '<span class="muted">震荡</span>');
    const rows = S
      ? [
          [`${S.tf}周期`, '<span class="muted">以下均为该周期</span>'],
          ["Supertrend", arrowTxt(S.stDir)],
          ["RSI", isFinite(S.rsi) ? S.rsi.toFixed(1) : "-"],
          ["ADX", isFinite(S.adx) ? S.adx.toFixed(1) : "-"],
          ["MACD柱", `<span class="${S.macdHist >= 0 ? "long" : "short"}">${fmtPrice(S.macdHist)}</span>`],
          ["量比", isFinite(S.volRatio) ? `${S.volRatio.toFixed(2)}x` : "-"],
          ["ATR", `${fmtPrice(S.atr)} (${S.atrPct.toFixed(2)}%)`],
        ]
      : [
          ["1h趋势", arrowTxt(L.trend)],
          ["RSI", L.rsi.toFixed(1)],
          ["ADX", L.adx.toFixed(1)],
          ["MACD柱", `<span class="${L.macdHist >= 0 ? "long" : "short"}">${fmtPrice(L.macdHist)}</span>`],
          ["量比", `${L.volRatio.toFixed(2)}x`],
          ["ATR", `${fmtPrice(L.atr)} (${L.atrPct.toFixed(2)}%)`],
          ["手续费/止损", `${((p.feePct / 100) / (L.atrPct / 100) / 1.2).toFixed(2)}R`],
        ];
    setHtml("indicatorBar", rows.map(([k, v]) => `<span class="muted">${k}<b class="num" style="color:var(--text)">${v}</b></span>`).join(""));

    // 大周期分组统计：本机累计的全部品种已平仓信号
    const all = Object.values(journal);
    const grp = (f) => {
      const a = all.filter(f);
      if (!a.length) return `<span class="muted">-</span><span></span><span></span>`;
      const w = a.filter((x) => x.r > 0).length, R = a.reduce((s2, x) => s2 + x.r, 0) / a.length;
      return `<span class="num">${a.length}</span><span class="num">${((w / a.length) * 100).toFixed(0)}%</span><span class="num ${R > 0 ? "long" : "short"}">${R >= 0 ? "+" : ""}${R.toFixed(2)}R</span>`;
    };
    const since = all.length ? fmtTime(Math.min(...all.map((x) => x.t))).slice(0, 5) : "-";
    setHtml("ctxStats", `<div class="ctx-grid">
        <span class="muted">分组</span><span class="muted">笔数</span><span class="muted">胜率</span><span class="muted">每笔</span>
        <span>日线 同向</span>${grp((x) => x.d1 === "同向")}
        <span>日线 逆向</span>${grp((x) => x.d1 === "逆向")}
        <span>4h 同向</span>${grp((x) => x.h4 === "同向")}
        <span>4h 逆向</span>${grp((x) => x.h4 === "逆向")}
        <span>MACD柱已拐头</span>${grp((x) => x.mt === "是")}
        <span>MACD柱未拐头</span>${grp((x) => x.mt === "否")}
        <span>加密·过热信号</span>${grp((x) => x.crypto && x.hot === 1)}
        <span>加密·非过热</span>${grp((x) => x.crypto && x.hot === 0)}
        <span>回踩确认</span>${grp((x) => x.tg === "回踩确认")}
        <span>放量突破/跌破</span>${grp((x) => x.tg && x.tg !== "回踩确认")}
        <span>全部</span>${grp(() => true)}
      </div>
      <div class="bt-note">全部品种、本机自 ${since} 起累计（已扣费）。6 个月回测里「MACD柱已拐头」每笔略好、「4h 同向」略差，但差距都在统计误差内。每组积累到 200 笔以上、差距仍然稳定，再考虑改规则。</div>`);

    const bt = d.res.bt, pct = (x) => (isNaN(x) ? "-" : (x * 100).toFixed(0) + "%");
    $("btRange").textContent = `（近 ${Math.round((d.ltf.length * 15) / 60 / 24)} 天 · ${bt.total} 笔）`;
    setHtml("backtest", `<div class="stats">
        <div class="stat"><div class="v ${bt.winRate >= 0.55 ? "long" : bt.winRate < 0.45 ? "short" : ""}">${pct(bt.winRate)}</div><div class="k">胜率</div></div>
        <div class="stat"><div class="v ${bt.avgR > 0 ? "long" : "short"}">${isNaN(bt.avgR) ? "-" : bt.avgR.toFixed(2) + "R"}</div><div class="k">每笔(扣费后)</div></div>
        <div class="stat"><div class="v">${pct(bt.tp2Rate)}</div><div class="k">移动止盈获利</div></div>
        <div class="stat"><div class="v">${bt.closed}</div><div class="k">已平仓</div></div>
        <div class="stat"><div class="v">${isNaN(bt.avgFeeR) ? "-" : bt.avgFeeR.toFixed(2) + "R"}</div><div class="k">每笔手续费</div></div>
        <div class="stat"><div class="v ${bt.totalR >= 0 ? "long" : "short"}">${bt.totalR.toFixed(1)}R</div><div class="k">累计</div></div>
      </div>
      <div class="bt-note">规则：信号收盘价入场；TP1(1R) 平一半、止损移保本，剩余半仓 ${p.trailAtr}×ATR 移动止损；同根K线同时碰到止损和止盈按止损算。手续费占止损 >${p.maxFeeR}R 的信号不发${p.market !== "crypto" ? "，股票周末不发" : ""}。已扣手续费 ${p.feePct}%，未计滑点和资金费率。${bt.open ? `另有 ${bt.open} 笔持仓中。` : ""}</div>`);
  }

  // 价格结构面板：五个周期一览 + 当前主图周期的细节 + 多周期共振提示
  function renderStructPanel() {
    const sym = state.active, d = state.data[sym];
    if (!d?.ltf?.length) { setHtml("structPanel", '<span class="muted small">加载中…</span>'); return; }
    const isS = isShort(), main = state.chartTf;
    const order = ["1d", "4h", "1h", "15m", "3m"];
    const group = isS ? ["15m", "3m"] : ["1h", "4h", "1d"];
    const St = Object.fromEntries(order.map((tf) => [tf, structOf(sym, tf)]));
    const zsTxt = (S) => !S?.zs.length ? '<span class="muted">-</span>'
      : S.zsPos === "inside" ? '<span class="wait">中枢内</span>' : S.zsPos === "above" ? '<span class="long">中枢上方</span>' : '<span class="short">中枢下方</span>';
    const wvTxt = (S) => !S?.wave ? '<span class="muted">-</span>'
      : `<span class="${S.wave.dir > 0 ? "long" : "short"}">${S.wave.kind === "abc" ? "ABC" : S.wave.nW + "浪"}${S.wave.dir > 0 ? "↑" : "↓"}</span>`;
    let html = `<div class="st-row head"><span>周期</span><span>结构</span><span>最近突破</span><span>中枢</span><span>波浪</span></div>`;
    for (const tf of order) {
      const S = St[tf];
      html += `<div class="st-row ${tf === main ? "cur" : group.includes(tf) ? "" : "dim"}"><span>${TFS[tf].label}</span>` +
        (S ? `<span>${biasHtml(S)}</span><span>${S.lastEv ? evTxt(S.lastEv, S.barSec) : '<span class="muted">-</span>'}</span><span>${zsTxt(S)}</span><span>${wvTxt(S)}</span>`
          : '<span class="muted">数据不足</span><span></span><span></span><span></span>') + "</div>";
    }
    // 共振
    let res = null;
    if (isS) {
      const cf = confirm3(St["15m"], St["3m"], d.m3 ?? []);
      const h1 = St["1h"]?.bias;
      if (cf) res = { cls: cf.cls, txt: `${cf.txt}${h1 && St["15m"]?.bias && h1 !== St["15m"].bias ? "；但 1h 结构反向，按回调/反弹对待" : ""}` };
    } else {
      const b = ["1d", "4h", "1h"].map((t) => St[t]?.bias ?? 0);
      if (b[0] && b[0] === b[1] && b[1] === b[2]) res = { cls: b[0] > 0 ? "long" : "short", txt: `日线/4h/1h 结构同向${b[0] > 0 ? "向上" : "向下"}` };
      else if (b[0] && b[1] === b[0] && b[2] === -b[0]) res = { cls: "wait", txt: `日线/4h ${b[0] > 0 ? "向上" : "向下"}，1h 反向：大级别里的回调，等 1h 结构转回` };
      else if (b[0] && b[1] === -b[0]) res = { cls: "wait", txt: `4h 与日线反向：日线级别的${b[0] > 0 ? "回调" : "反弹"}，或者趋势在转` };
      else res = { cls: "muted", txt: "长线结构不一致 / 有周期在中枢里震荡" };
    }
    if (res) html += `<div class="resonance ${res.cls}">${res.txt}</div>`;
    // 当前主图周期的细节
    const S = St[main];
    if (S) {
      const px = d[TFS[main].key]?.[d[TFS[main].key].length - 1]?.close ?? S.close, nowS = Date.now() / 1000;
      const zl = (z, cls, nm) => `<span class="${cls}">${nm} <b class="num">${fmtPrice(z.price)}</b></span> <span class="muted num">${fmtPct(z.price, px)} ${fmtTouch(z)}</span>`;
      const rows = [];
      const zz = S.zones;
      rows.push(["压力", zz.above.length ? zz.above.map((z) => zl(z, "short", "")).join(" · ") : '<span class="muted">上方没有近的结构位</span>']);
      rows.push(["支撑", zz.below.length ? zz.below.map((z) => zl(z, "long", "")).join(" · ") : '<span class="muted">下方没有近的结构位</span>']);
      const tlv = (L, nm, cls) => L ? `<span class="${cls}">${nm} <b class="num">${fmtPrice(Structure.lineAt(L, nowS))}</b></span> <span class="muted">${L.touches}触${L.strong ? "" : "·候选"}</span>` : "";
      const tls = [tlv(S.tl.up, "上升", "long"), tlv(S.tl.down, "下降", "short")].filter(Boolean);
      const brk = [S.tl.upBroken && "上升线刚被跌破", S.tl.downBroken && "下降线刚被突破"].filter(Boolean);
      rows.push(["趋势线", (tls.join(" · ") || '<span class="muted">无有效趋势线</span>') + (brk.length ? ` <span class="wait">${brk.join("，")}</span>` : "")]);
      if (S.channel) rows.push(["通道", S.channel.base ? `${S.channel.kind} · 现价在 <b>${Math.round(S.channel.pos * 100)}%</b> <span class="muted">(0=下沿 100=上沿)</span>` : `<span class="wait">${S.channel.kind}</span> <span class="muted">两条趋势线同时有效</span>`]);
      const z = S.zs[S.zs.length - 1];
      if (z) rows.push(["中枢", `<b class="num">${fmtPrice(z.zd)} ~ ${fmtPrice(z.zg)}</b> <span class="muted">${z.n}笔 · 波动 ${fmtPrice(z.dd)}~${fmtPrice(z.gg)}${S.activeZs ? " · 仍在延伸" : ""}</span>`]);
      if (S.wave) {
        const w = S.wave, n = w.next;
        rows.push(["波浪", `${w.kind === "abc" ? `5浪后 ABC 调整（${w.labels[w.labels.length - 1]}）` : `${w.dir > 0 ? "上升" : "下跌"}推动 第${w.nW}浪`} <span class="muted">吻合度 ${(w.score * 100).toFixed(0)}%</span>` +
          (n ? `<br><span class="muted">${n.txt}${n.target ? ` · 参考 ${fmtPrice(n.target)}` : ""}${n.limit ? ` · ${n.limitTxt} ${fmtPrice(n.limit)}` : ""}</span>` : "")]);
      }
      html += `<div class="sub-h">${TFS[main].label} 细节 <span class="muted small">ATR ${fmtPrice(S.atrNow)} · 每笔约 ${S.avgLegBars.toFixed(0)} 根</span></div>` +
        `<div class="st-detail">${rows.map(([a, b]) => `<div class="row"><span class="muted">${a}</span><span>${b}</span></div>`).join("")}</div>`;
    }
    html += `<div class="muted small" style="margin-top:6px">摆动点 = ATR ZigZag（反向走出约 2.2×ATR 才确认），所有图层都从同一套摆动点算出；
      结构 = 最近两个高点/低点排列（HH+HL 上升、LH+LL 下降），在中枢里时判震荡。波浪只是"最符合铁律的一种数法"，不是预测。
      <b>这些都没经过收益回测，不参与信号和止损。</b></div>`;
    setHtml("structPanel", html);
  }

  function renderLayerBar() {
    const chips = LAYERS.map((L, i) => (i === 8 ? '<span class="sep"></span>' : "") +
      `<button class="chip${state.layers[L.id] ? " on" : ""}" data-layer="${L.id}" title="${L.tip}"><i style="background:${L.color}"></i>${L.name}</button>`).join("");
    const presets = Object.keys(LAYER_PRESETS).map((k) => `<button class="chip preset" data-preset="${k}">${k}</button>`).join("");
    $("layerBar").innerHTML = chips + '<span class="sep"></span>' + presets;
  }
  function layersChanged() {
    store.save("layers", state.layers);
    renderLayerBar();
    chartKey = "";
    htmlCache.legend = null;
    renderSide();
    renderChart();
  }

  function renderFeed() {
    $("feed").innerHTML = state.feed.length
      ? state.feed.map((f) => `<div class="item" data-sym="${f.sym}"><span class="muted num">${fmtTime(f.t)}</span> <b>${short(f.sym)}</b> ${f.html}</div>`).join("")
      : '<span class="muted">打开页面后出现的新信号、TP1、止损等事件会记录在这里</span>';
  }

  function renderAll() {
    renderWatchlist();
    renderSide();
    renderChart();
  }

  function selectSymbol(sym) {
    state.active = sym;
    hoverIdx = -1;
    renderAll();
    if (matchMedia("(max-width: 900px)").matches) $("chartSection").scrollIntoView({ behavior: "smooth" });
  }

  // ---------------- 交互 ----------------
  function bindUi() {
    $("watchlist").addEventListener("click", (e) => {
      const del = e.target.dataset.del;
      if (del) { removeSymbol(del); e.stopPropagation(); return; }
      const card = e.target.closest(".card");
      if (card) selectSymbol(card.dataset.sym);
    });
    $("feed").addEventListener("click", (e) => { const it = e.target.closest(".item"); if (it) selectSymbol(it.dataset.sym); });

    // 主图周期切换（15m / 4h / 日线）
    $("chartTf").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ctf]");
      if (!b || !CHART_TF[b.dataset.ctf] || state.chartTf === b.dataset.ctf) return;
      state.chartTf = b.dataset.ctf;
      store.save("chartTf", state.chartTf);
      syncChartTfBtns();
      htmlCache.chartTitle = null;
      chartKey = "";
      renderSide();
      renderChart();
    });

    // 图层开关 / 预设
    $("layerBar").addEventListener("click", (e) => {
      const b = e.target.closest("[data-layer],[data-preset]");
      if (!b) return;
      if (b.dataset.layer) state.layers[b.dataset.layer] = state.layers[b.dataset.layer] ? 0 : 1;
      else state.layers = Object.fromEntries(LAYERS.map((L) => [L.id, LAYER_PRESETS[b.dataset.preset][L.id] ? 1 : 0]));
      layersChanged();
    });

    // 趋势通道 / 震荡区间的周期切换（日线 / 4h）
    $("bigPicture").addEventListener("click", (e) => {
      const b = e.target.closest("[data-chtf]");
      if (!b || !CH_TF[b.dataset.chtf]) return;
      state.chTf = b.dataset.chtf;
      store.save("chTf", state.chTf);
      htmlCache.bigPicture = null; // setHtml 有缓存，强制重画
      renderSide();
      renderChart();
    });

    const th = $("threshold");
    th.value = state.params.scoreThreshold;
    $("thresholdVal").textContent = th.value;
    th.oninput = () => { $("thresholdVal").textContent = th.value; };
    th.onchange = () => { state.params.scoreThreshold = +th.value; paramsChanged(); };
    $("feePct").value = state.params.feePct;
    $("feePct").onchange = (e) => { const v = parseFloat(e.target.value); if (v >= 0) { state.params.feePct = v; paramsChanged(); } };
    $("strictHtf").checked = state.params.strictHtf;
    $("strictHtf").onchange = (e) => { state.params.strictHtf = e.target.checked; paramsChanged(); };

    $("soundBtn").onclick = () => {
      state.sound = !state.sound;
      if (state.sound) {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();
        beep("long");
      }
      $("soundBtn").textContent = state.sound ? "🔔 声音已开启" : "🔇 点击开启声音";
      $("soundBtn").classList.toggle("on", state.sound);
    };

    bindPushUi();
    // 信号框里的仓位输入和复制按钮（内容每秒重绘，用事件委托）
    $("lastSignal").addEventListener("change", (e) => {
      if (e.target.id !== "riskInput") return;
      const v = parseFloat(e.target.value);
      if (v > 0) { sizing.risk = v; store.save("sizing", sizing); htmlCache.lastSignal = null; renderSide(); }
    });
    $("lastSignal").addEventListener("click", async (e) => {
      const b = e.target.closest(".copy-btn");
      if (!b) return;
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "✅ 已复制"; }
      catch { prompt("复制下面的内容", b.dataset.copy); }
    });
    $("menuBtn").onclick = () => document.querySelector(".controls").classList.toggle("open");

    $("addForm").onsubmit = async (e) => {
      e.preventDefault();
      const sym = $("addInput").value.trim().toUpperCase().split(/\s/)[0];
      if (!sym || state.symbols.includes(sym)) { $("addInput").value = ""; return; }
      try {
        await fetchKlines(sym, LTF, 1);
      } catch {
        alert(`找不到合约 ${sym}，请确认是币安U本位永续合约代码（如 SOLUSDT、NVDAUSDT）`);
        return;
      }
      state.symbols.push(sym);
      store.save("symbols", state.symbols);
      store.save("symbolsVer", SYMBOLS_VER);
      $("addInput").value = "";
      await loadSymbol(sym).catch(() => {});
      connectWs();
      selectSymbol(sym);
    };
  }

  function bindPushUi() {
    const m = $("pushModal");
    const fill = () => {
      const c = Push.config;
      $("pTok").value = c.token; $("pChat").value = c.chatId; $("pEnabled").checked = c.enabled;
      $("pUrl").value = c.pageUrl || (location.protocol.startsWith("http") ? location.href.replace(/#.*$/, "") : "");
      document.querySelectorAll("[data-ev]").forEach((el) => (el.checked = !!c.events[el.dataset.ev]));
      updatePushBtn();
    };
    const collect = () => {
      const events = {};
      document.querySelectorAll("[data-ev]").forEach((el) => (events[el.dataset.ev] = el.checked));
      return { token: $("pTok").value.trim(), chatId: $("pChat").value.trim(), enabled: $("pEnabled").checked, pageUrl: $("pUrl").value.trim(), events };
    };
    const msg = (t, ok) => { $("pMsg").textContent = t; $("pMsg").className = ok ? "long" : "short"; };
    $("pushBtn").onclick = () => { fill(); msg("", true); m.classList.add("open"); };
    $("pClose").onclick = () => m.classList.remove("open");
    m.onclick = (e) => { if (e.target === m) m.classList.remove("open"); };
    $("pDetect").onclick = async () => {
      try { msg("获取中…", true); const r = await Push.detectChatId($("pTok").value.trim()); $("pChat").value = r.id; msg(`已获取：${r.name} (${r.id})`, true); }
      catch (e) { msg(e.message, false); }
    };
    $("pTest").onclick = async () => {
      try { msg("发送中…", true); await Push.test($("pTok").value.trim(), $("pChat").value.trim()); msg("发送成功，看看手机", true); }
      catch (e) { msg(`发送失败：${e.message}（家里电脑需要能访问 Telegram）`, false); }
    };
    $("pSave").onclick = () => { Push.save(collect()); updatePushBtn(); msg("已保存", true); setTimeout(() => m.classList.remove("open"), 600); };
    fill();
  }
  function updatePushBtn() {
    const on = Push.ready();
    $("pushBtn").textContent = on ? "📱 推送中" : "📱 手机推送";
    $("pushBtn").classList.toggle("on", on);
  }

  function removeSymbol(sym) {
    if (state.symbols.length <= 1) return;
    state.symbols = state.symbols.filter((s) => s !== sym);
    delete state.data[sym];
    store.save("symbols", state.symbols);
    store.save("symbolsVer", SYMBOLS_VER);
    if (state.active === sym) state.active = state.symbols[0];
    connectWs();
    renderAll();
  }

  function paramsChanged() {
    store.save("params", { scoreThreshold: state.params.scoreThreshold, strictHtf: state.params.strictHtf, feePct: state.params.feePct });
    state.symbols.forEach((s) => state.data[s]?.ltf?.length && recompute(s));
    renderAll();
  }

  // ---------------- 启动 ----------------
  async function main() {
    initChart();
    bindUi();
    syncChartTfBtns();
    renderLayerBar();
    renderFeed();
    renderAll();
    const want = decodeURIComponent(location.hash.slice(1)).toUpperCase();
    if (want && state.symbols.includes(want)) state.active = want;
    window.addEventListener("hashchange", () => {
      const s2 = decodeURIComponent(location.hash.slice(1)).toUpperCase();
      if (state.symbols.includes(s2)) selectSymbol(s2);
    });
    await loadMeta();
    renderAll();
    await Promise.all(state.symbols.map((s) => loadSymbol(s).catch((err) => {
      state.data[s] = { ltf: [], htf: [], error: `加载失败：${err.message}` };
    })));
    renderAll();
    connectWs();
    const refreshFlow = () => Promise.allSettled(state.symbols.map(loadFlow));
    await refreshFlow();
    setInterval(refreshFlow, 60000);
    // 实时持仓：当前查看的品种每 10 秒，其它加密品种每 30 秒
    let liveTick = 0;
    setInterval(() => {
      liveTick++;
      for (const s of state.symbols) if (s === state.active || liveTick % 3 === 0) loadLiveOi(s);
    }, 10000);
    state.symbols.forEach(loadLiveOi);
    Push.send("health", "✅ 盯盘助手已启动", `正在监控 ${state.symbols.length} 个品种：${state.symbols.map(short).join("、")}`, null);
    // 每秒刷新：实时价格、信号状态
    const isMobile = matchMedia("(max-width: 900px)").matches;
    const otherEvery = isMobile ? 6000 : 2000; // 非当前品种的重算间隔（K线收盘时仍会立即计算）
    let lastTick = Date.now();
    setInterval(() => {
      // 电脑睡眠检测：定时器停了很久说明机器睡过
      const gap = Date.now() - lastTick;
      lastTick = Date.now();
      if (gap > 3 * 60000) {
        const mins = Math.round(gap / 60000);
        notify({ kind: "exit", event: "health", sym: state.active, title: "电脑刚从睡眠中恢复", body: `约 ${mins} 分钟没有盯盘，期间的信号可能漏掉了。请在系统设置里把「睡眠」改为「从不」。`, feed: `<b class="wait">睡眠恢复</b> 中断 ${mins} 分钟` });
      }
      for (const s of state.symbols) {
        const dd = state.data[s];
        if (dd?.dirty && (s === state.active || Date.now() - dd.computedAt > otherEvery)) recompute(s);
      }
      renderWatchlist();
      renderSide();
      const d = state.data[state.active];
      if (!d?.res) return;
      if (chartKeyOf(d) !== chartKey) renderChart();
      else {
        // 只更新最后一根，避免整图重绘。必须按当前主图周期取 —— 原来固定用 15m，
        // 切到日线图后每秒都会把一根 15m 时间戳的K线塞进日线图里
        const arr = d[(CHART_TF[state.chartTf] ?? CHART_TF["15m"]).key] ?? d.ltf;
        const x = arr[arr.length - 1], T = x.time + TZ;
        candle.update({ time: T, open: x.open, high: x.high, low: x.low, close: x.close });
        renderOhlc();
        vol.update({ time: T, value: x.volume, color: x.close >= x.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)" });
      }
    }, 1000);
  }

  main();
})();
