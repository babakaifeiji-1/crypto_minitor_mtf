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
    chTf: store.load("chTf", "1d"), // 回归通道 / 震荡区间的周期档位："1d" 或 "4h"
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
    const [ltf, htf, h4, d1] = await Promise.all([
      fetchKlines(sym, LTF, 1500), fetchKlines(sym, HTF, 500), fetchKlines(sym, "4h", 300), fetchKlines(sym, "1d", 200),
    ]);
    const prev = state.data[sym];
    state.data[sym] = {
      ltf, htf, h4, d1, res: null, live: null, dirty: true, computedAt: 0,
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
    const streams = state.symbols.flatMap((s) => [LTF, HTF, "4h", "1d"].map((iv) => `${s.toLowerCase()}@kline_${iv}`)).join("/");
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
      const arr = { [LTF]: d.ltf, [HTF]: d.htf, "4h": d.h4, "1d": d.d1 }[k.i];
      if (arr) upsertCandle(arr, c);
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
  let chart, candle, vol, ema9S, ema21S, stUpS, stDnS, priceLines = [];
  // 高周期回归通道（中轴 + 上下沿）。日线/4h 上拟合，投影到 15m 图
  let chMidS, chUpS, chDnS;
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
    // 鼠标悬停 / 手指点按某根K线时显示它的高低点和涨跌幅
    chart.subscribeCrosshairMove((param) => {
      const d = state.data[state.active];
      if (!d?.ltf?.length) return;
      hoverIdx = param.time != null ? d.ltf.findIndex((x) => x.time + TZ === param.time) : -1;
      renderOhlc();
    });
    vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.18 } });
    const lineOpt = { lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
    ema9S = chart.addLineSeries({ ...lineOpt, color: "#f5c542" });
    ema21S = chart.addLineSeries({ ...lineOpt, color: "#4c8dff" });
    stUpS = chart.addLineSeries({ ...lineOpt, color: "#26a69a", lineWidth: 2, lineStyle: 2 });
    stDnS = chart.addLineSeries({ ...lineOpt, color: "#ef5350", lineWidth: 2, lineStyle: 2 });
    // 回归通道：淡青色。中轴虚线、上下沿点线，刻意做得比 EMA/Supertrend 弱，
    // 避免把这个"仅供参考、未经回测"的东西画得比真正驱动信号的指标还显眼。
    //
    // autoscaleInfoProvider 返回 null = 不参与价格轴自动缩放。**这一条是必须的**：
    // 日线通道半宽 ±11%，而 15m 图可见区间只有 2~3%。不排除的话价格轴会被拉到
    // 覆盖整个通道（实测 74000~98000），K 线被压成一条线，图就废了。
    // 代价是价格离通道远时看不到这三条线 —— 但那正是它不重要的时候；
    // 价格真的贴近通道边缘时线会自己出现，而具体数值面板里一直有。
    const chOpt = { ...lineOpt, color: "rgba(120,200,220,.55)", autoscaleInfoProvider: () => null };
    chMidS = chart.addLineSeries({ ...chOpt, lineWidth: 1, lineStyle: 2 });
    chUpS = chart.addLineSeries({ ...chOpt, lineWidth: 1, lineStyle: 1 });
    chDnS = chart.addLineSeries({ ...chOpt, lineWidth: 1, lineStyle: 1 });
  }

  // 通道周期档位：日线 60 根（约两个月）/ 4h 180 根（约一个月）
  // 15m 图上看日线通道是"大结构"，4h 通道是"中结构"，都比 15m 自己连趋势线有意义
  const CH_TF = {
    "1d": { label: "日线", n: 60, key: "d1" },
    "4h": { label: "4h", n: 180, key: "h4" },
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
    return `${state.active}|${d.ltf.length}|${d.res.signals.length}|${last?.result}|${last?.trailSl}|${d.lastStatus?.code}`;
  };

  // K线信息条：开高低收、涨跌幅（相对上一根收盘）、振幅（最高最低差 / 上一根收盘）
  let hoverIdx = -1;
  function renderOhlc() {
    const d = state.data[state.active];
    if (!d?.ltf?.length) return;
    const k = d.ltf, i = hoverIdx >= 0 && hoverIdx < k.length ? hoverIdx : k.length - 1;
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
      <span><span class="k">振幅</span>${amp.toFixed(2)}%</span>
      <span><span class="k">量</span>${vol}</span>`);
  }

  function renderChart() {
    const sym = state.active, d = state.data[sym];
    if (!d?.res) return;
    const k = d.ltf, ind = d.res.ind, T = (t) => t + TZ;
    const prec = decimals(k[k.length - 1].close);
    candle.applyOptions({ priceFormat: { type: "price", precision: prec, minMove: 10 ** -prec } });
    candle.setData(k.map((x) => ({ time: T(x.time), open: x.open, high: x.high, low: x.low, close: x.close })));
    vol.setData(k.map((x) => ({ time: T(x.time), value: x.volume, color: x.close >= x.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)" })));
    const line = (arr) => k.map((x, i) => (isNaN(arr[i]) ? { time: T(x.time) } : { time: T(x.time), value: arr[i] }));
    ema9S.setData(line(ind.ema9));
    ema21S.setData(line(ind.ema21));
    stUpS.setData(k.map((x, i) => (ind.st.dir[i] === 1 ? { time: T(x.time), value: ind.st.line[i] } : { time: T(x.time) })));
    stDnS.setData(k.map((x, i) => (ind.st.dir[i] === -1 ? { time: T(x.time), value: ind.st.line[i] } : { time: T(x.time) })));

    const markers = d.res.signals.map((s) => ({
      time: T(s.time),
      position: s.side > 0 ? "belowBar" : "aboveBar",
      color: s.side > 0 ? "#26a69a" : "#ef5350",
      shape: s.side > 0 ? "arrowUp" : "arrowDown",
      text: `${s.side > 0 ? "多" : "空"}${s.score}`,
    }));
    if (d.exit) markers.push({ time: T(d.exit.time), position: d.exit.side > 0 ? "aboveBar" : "belowBar", color: "#f5a623", shape: "circle", text: "弱" });
    for (const ev of d.rejections ?? []) markers.push({
      time: T(ev.time), position: ev.isRes ? "aboveBar" : "belowBar", color: "#f5a623",
      shape: "square", size: ev.first ? 1 : 0.6, text: ev.first ? "🧱" : "",
    });
    markers.sort((a, b) => a.time - b.time);
    candle.setMarkers(markers);

    priceLines.forEach((pl) => candle.removePriceLine(pl));
    priceLines = [];
    const add = (price, color, title, style = 2, width = 1) =>
      priceLines.push(candle.createPriceLine({ price, color, title, lineWidth: width, lineStyle: style, axisLabelVisible: true }));

    // 支撑压力位
    const kl = keyLevels(d);
    // ★ 级回测和随机价位差不多，不画；★★★ 用粗实线强调
    const drawLv = (l, isRes) => {
      if (l.strength < 3) return;
      const strong = l.strength >= 5;
      const color = isRes ? (strong ? "rgba(239,83,80,.95)" : "rgba(239,83,80,.45)") : strong ? "rgba(38,166,154,.95)" : "rgba(38,166,154,.45)";
      const name = `${strong ? "强" : ""}${isRes ? "压力" : "支撑"}${stars(l)}${l.tags.length ? " " + l.tags.join("/") : ""}`;
      add(l.price, color, name, strong ? 0 : 1, strong ? 3 : 1);
    };
    kl.above.forEach((l) => drawLv(l, true));
    kl.below.forEach((l) => drawLv(l, false));

    // 高周期关键位（4h + 日线）。硬位（日线/周高低参与）紫色粗线，软位（纯 4h）灰紫细线
    const pxNow = k[k.length - 1].close, atrNow = ind.atr[ind.atr.length - 1];
    const nowSec = Date.now() / 1000;
    const hLv = Levels.htf(d.h4, d.d1, nowSec).filter((l) => Math.abs(l.price - pxNow) <= 15 * atrNow);
    const pick = (arr, n) => arr.slice(0, n);
    [...pick(hLv.filter((l) => l.price > pxNow).sort((a, b) => a.price - b.price), 3),
     ...pick(hLv.filter((l) => l.price <= pxNow).sort((a, b) => b.price - a.price), 3)]
      .forEach((l) => {
        const isRes = l.price > pxNow;
        add(l.price,
          l.hard ? "rgba(179,136,255,.8)" : "rgba(179,136,255,.4)",
          `${l.srcs.join("+")}${isRes ? "压力" : "支撑"}`,
          0, l.hard ? 2 : 1);
      });

    // 高周期回归通道，投影到 15m 时间轴上
    const chCfg = CH_TF[state.chTf] ?? CH_TF["1d"];
    const chSrc = (d[chCfg.key] ?? []).filter((x) => x.time + (chCfg.key === "d1" ? 86400 : 4 * 3600) <= nowSec);
    const ch = Levels.channel(chSrc, chCfg.n);
    if (ch) {
      // 只画在拟合窗口内的部分，不外推 —— 外推的通道会给人虚假的"目标位"暗示
      const proj = (f) => k.map((x) => (x.time >= ch.from ? { time: T(x.time), value: f(ch.lineAt(x.time)) } : { time: T(x.time) }));
      chMidS.setData(proj((v) => v.mid));
      chUpS.setData(proj((v) => v.up));
      chDnS.setData(proj((v) => v.dn));
    } else {
      chMidS.setData([]); chUpS.setData([]); chDnS.setData([]);
    }

    // 震荡区间：只在判定为震荡时画上下沿（趋势里画区间会误导）。
    // 另外只画离现价 6 ATR 以内的那一条 —— 日线区间常宽到 ±20%，两条都画会把
    // 价格轴拉开好几倍（和通道同一个问题），而且远端那条对当下没有参考价值。
    // 完整区间数值在右侧面板里一直显示。
    const rg = Levels.regime(chSrc, chCfg.key === "d1" ? 30 : 90);
    if (rg && !rg.trending) {
      if (Math.abs(rg.hi - pxNow) <= 6 * atrNow) add(rg.hi, "rgba(245,166,35,.6)", `${chCfg.label}震荡上沿`, 3, 1);
      if (Math.abs(rg.lo - pxNow) <= 6 * atrNow) add(rg.lo, "rgba(245,166,35,.6)", `${chCfg.label}震荡下沿`, 3, 1);
    }

    // 当前信号 / 持仓
    const last = d.res.signals[d.res.signals.length - 1], st = d.lastStatus;
    if (last && st && st.code !== "done" && st.code !== "expired") {
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

    if (chartSym !== sym) {
      const bars = matchMedia("(max-width: 900px)").matches ? 80 : 160;
      chart.timeScale().setVisibleLogicalRange({ from: k.length - bars, to: k.length + 8 });
      chartSym = sym;
    }
    chartKey = chartKeyOf(d);
    renderOhlc();
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
    $("chartTitle").innerHTML = `${short(sym)} <span class="muted small">${CN_NAMES[sym] ?? ""} · ${MARKET_NAMES[marketOf(sym)]}永续 · 15m${sess ? " · " + sess.txt : ""}</span>`;
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

    // 回归通道 + 震荡区间（当前选中的周期档位）
    const cfg = CH_TF[state.chTf] ?? CH_TF["1d"];
    const src = (d[cfg.key] ?? []).filter((x) => x.time + (cfg.key === "d1" ? 86400 : 4 * 3600) <= nowS);
    const ch = Levels.channel(src, cfg.n);
    const rg = Levels.regime(src, cfg.key === "d1" ? 30 : 90);
    const tfBtn = (k) => `<button class="btn tf-btn${state.chTf === k ? " on" : ""}" data-chtf="${k}">${CH_TF[k].label}</button>`;
    let chTxt = `<div class="sub-h">趋势通道 / 震荡区间 ${tfBtn("1d")}${tfBtn("4h")}</div>`;
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
        `<span class="muted">${rg.trending ? "" : `区间 ${fmtPrice(rg.lo)}~${fmtPrice(rg.hi)}（宽 ${rg.widthPct.toFixed(1)}%）`}</span></div>` +
        `<div class="muted small" style="margin-top:4px">通道是对 log 收盘价做最小二乘回归（${cfg.label} ${ch.n} 根），不是手连的趋势线：给定周期和窗口，结果唯一、可复现、能回测。r² 低说明"趋势"这个描述本身就不贴合当前走势，这时候通道只当波动范围看。<b>效率比</b>=净位移/路径总长，越接近 1 越单边。<b>这些阈值都没经过回测验证，不参与信号判定。</b></div>`;
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

    setHtml("indicatorBar", [
      ["1h趋势", L.trend > 0 ? '<span class="long">向上</span>' : L.trend < 0 ? '<span class="short">向下</span>' : '<span class="muted">震荡</span>'],
      ["RSI", L.rsi.toFixed(1)],
      ["ADX", L.adx.toFixed(1)],
      ["MACD柱", `<span class="${L.macdHist >= 0 ? "long" : "short"}">${fmtPrice(L.macdHist)}</span>`],
      ["量比", `${L.volRatio.toFixed(2)}x`],
      ["ATR", `${fmtPrice(L.atr)} (${L.atrPct.toFixed(2)}%)`],
      ["手续费/止损", `${((p.feePct / 100) / (L.atrPct / 100) / 1.2).toFixed(2)}R`],
    ].map(([k, v]) => `<span class="muted">${k}<b class="num" style="color:var(--text)">${v}</b></span>`).join(""));

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
        // 只更新最后一根，避免整图重绘
        const x = d.ltf[d.ltf.length - 1], T = x.time + TZ;
        candle.update({ time: T, open: x.open, high: x.high, low: x.low, close: x.close });
        renderOhlc();
        vol.update({ time: T, value: x.volume, color: x.close >= x.open ? "rgba(38,166,154,.35)" : "rgba(239,83,80,.35)" });
      }
    }, 1000);
  }

  main();
})();
