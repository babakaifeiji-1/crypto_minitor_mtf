// 数据层：限频 + 重试的 REST 客户端、K线合并、IndexedDB 缓存、增量同步 / 往前翻页。
// 和界面无关，Node 下可测（test/data_test.js）。
//
// 币安合约 REST 限制（2026-11 实测）：IP 每分钟权重 2400；klines 权重按 limit 计
//   1–100 → 1，≤500 → 2，≤1000 → 5，≤1500 → 10，>1500 报 -1130。
// 浏览器跨域拿不到 x-mbx-used-weight 响应头，所以限频器自己记账。预算默认只用一半（1200）：
// 同一台机器上可能还开着原版看板，共用同一个 IP 的额度。

export const TF_SEC = { "3m": 180, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
export const MAX_LIMIT = 1500;

export const klineWeight = (limit) => (limit <= 100 ? 1 : limit <= 500 ? 2 : limit <= 1000 ? 5 : 10);
// 其它接口的权重（只列用到的）
export function pathWeight(path) {
  if (path.startsWith("/fapi/v1/klines")) {
    const m = path.match(/[?&]limit=(\d+)/);
    return klineWeight(m ? +m[1] : 500);
  }
  if (path.startsWith("/fapi/v1/ticker/24hr")) return /[?&]symbol=/.test(path) ? 1 : 40;
  return 1;
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 滑动窗口限频：最近 windowMs 内已用权重 + 本次 ≤ budget 才放行，否则等最早那笔过期
export class RateLimiter {
  constructor({ budget = 1200, windowMs = 60000, now = () => Date.now(), sleep = realSleep } = {}) {
    Object.assign(this, { budget, windowMs, now, sleep });
    this.log = []; // [时间, 权重]
    this.pausedUntil = 0;
  }
  _prune(t) { while (this.log.length && this.log[0][0] <= t - this.windowMs) this.log.shift(); }
  used() { const t = this.now(); this._prune(t); return this.log.reduce((a, x) => a + x[1], 0); }
  async acquire(w = 1) {
    for (;;) {
      const t = this.now();
      if (t < this.pausedUntil) { await this.sleep(this.pausedUntil - t); continue; }
      this._prune(t);
      const used = this.log.reduce((a, x) => a + x[1], 0);
      // 窗口里一笔都没有时总要放行，否则单笔超过预算会永远卡住
      if (used + w <= this.budget || !this.log.length) { this.log.push([t, w]); return; }
      await this.sleep(Math.max(5, this.log[0][0] + this.windowMs - t + 5));
    }
  }
  // 被 429/418 时整体暂停
  pause(ms) { this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms); }
}

export const parseKline = (x) => ({ time: x[0] / 1000, open: +x[1], high: +x[2], low: +x[3], close: +x[4], volume: +x[5], takerBuy: +x[9] });

// REST 客户端：限频、网络错误/5xx 指数退避重试、429/418 按 Retry-After（拿不到就 30s/120s）暂停
export function createApi({ base, fetchFn = (u) => fetch(u), limiter = new RateLimiter(), retries = 4, sleep = realSleep, onThrottle } = {}) {
  const backoff = (a) => Math.min(30000, 500 * 2 ** a);
  async function get(path, weight = pathWeight(path)) {
    let lastErr = null;
    for (let a = 0; a <= retries; a++) {
      await limiter.acquire(weight);
      let r;
      try { r = await fetchFn(base + path); }
      catch (e) { lastErr = e; await sleep(backoff(a)); continue; }
      if (r.status === 429 || r.status === 418) {
        const ra = +(r.headers?.get?.("retry-after") ?? 0);
        const ms = ra > 0 ? ra * 1000 : r.status === 418 ? 120000 : 30000;
        limiter.pause(ms);
        onThrottle?.(r.status, ms);
        lastErr = Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
        continue;
      }
      if (r.status >= 500) { lastErr = Object.assign(new Error(`HTTP ${r.status}`), { status: r.status }); await sleep(backoff(a)); continue; }
      if (!r.ok) {
        // 4xx（参数错 / 合约不存在）重试没用，直接抛
        let msg = `HTTP ${r.status}`;
        try { const j = await r.json(); if (j?.msg) msg += ` ${j.msg}`; } catch { /* 无 body */ }
        throw Object.assign(new Error(msg), { status: r.status });
      }
      return r.json();
    }
    throw lastErr ?? new Error("请求失败");
  }
  async function klines(sym, interval, { limit = 500, startTime, endTime } = {}) {
    limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
    let q = `/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${interval}&limit=${limit}`;
    if (startTime != null) q += `&startTime=${Math.floor(startTime)}`;
    if (endTime != null) q += `&endTime=${Math.floor(endTime)}`;
    const arr = await get(q, klineWeight(limit));
    return arr.map(parseKline);
  }
  return { get, klines, limiter };
}

// 两段按时间升序的K线合并去重；时间相同时 add 覆盖 base。返回新数组，不改入参
export function mergeBars(base, add) {
  if (!add?.length) return base ? base.slice() : [];
  if (!base?.length) return dedupSorted(add);
  if (add[0].time > base[base.length - 1].time) return base.concat(dedupSorted(add));
  if (add[add.length - 1].time < base[0].time) return dedupSorted(add).concat(base);
  const out = [];
  let i = 0, j = 0;
  while (i < base.length || j < add.length) {
    const b = base[i], a = add[j];
    let x;
    if (!a || (b && b.time < a.time)) { x = b; i++; }
    else if (!b || a.time < b.time) { x = a; j++; }
    else { x = a; i++; j++; }
    if (out.length && out[out.length - 1].time === x.time) out[out.length - 1] = x;
    else out.push(x);
  }
  return out;
}
function dedupSorted(a) {
  const out = [];
  for (const x of a) {
    if (out.length && out[out.length - 1].time === x.time) out[out.length - 1] = x;
    else if (!out.length || x.time > out[out.length - 1].time) out.push(x);
  }
  return out;
}

// WS 推来的一根：同一根原地覆盖，新的一根追加。返回 "same" | "new" | "gap"（跳过了K线，需要补）| "old"
export function upsertBar(arr, c, sec) {
  const last = arr[arr.length - 1];
  if (last && last.time === c.time) { arr[arr.length - 1] = c; return "same"; }
  if (!last || c.time > last.time) {
    const gap = last && c.time > last.time + sec;
    arr.push(c);
    return gap ? "gap" : "new";
  }
  return "old";
}

// 增量同步：有缓存就从缓存最后一根往后补（最多 maxPages 页，太久没开就整体重拉），
// 然后保证至少 win 根（不够就往前翻页）。返回合并后的完整数组
export async function syncKlines(api, sym, interval, { win, cached = null, nowMs = Date.now(), maxPages = 4 } = {}) {
  const sec = TF_SEC[interval];
  let bars = cached?.length ? cached : [];
  if (bars.length) {
    let from = bars[bars.length - 1].time * 1000, pages = 0, ok = true;
    for (;;) {
      const missing = Math.ceil((nowMs - from) / (sec * 1000)) + 1;
      if (missing > maxPages * MAX_LIMIT) { ok = false; break; }
      const lim = Math.min(MAX_LIMIT, Math.max(2, missing));
      const got = await api.klines(sym, interval, { limit: lim, startTime: from });
      bars = mergeBars(bars, got);
      if (got.length < lim || ++pages >= maxPages) break;
      from = got[got.length - 1].time * 1000;
    }
    if (!ok) bars = [];
  }
  if (!bars.length) bars = await api.klines(sym, interval, { limit: Math.min(win, MAX_LIMIT) });
  while (bars.length && bars.length < win) {
    const got = await api.klines(sym, interval, { limit: Math.min(MAX_LIMIT, win - bars.length), endTime: bars[0].time * 1000 - 1 });
    if (!got.length) break;
    bars = mergeBars(got, bars);
  }
  return bars;
}

// 往前翻一页（拖到图表最左边时调用）。返回 { bars, added }；added = 0 表示已经到上市第一根
export async function loadOlder(api, sym, interval, bars, limit = MAX_LIMIT) {
  if (!bars.length) return { bars, added: 0 };
  const got = await api.klines(sym, interval, { limit, endTime: bars[0].time * 1000 - 1 });
  const merged = mergeBars(got, bars);
  return { bars: merged, added: merged.length - bars.length };
}

// ── IndexedDB 缓存 ──────────────────────────────────────────────────────────
// 每个 sym|interval 一条记录，列式 Float64Array（结构化克隆快、体积小）。只存最近 keep 根。
// 浏览器不支持 / 隐私模式打不开时退化为不缓存，不影响功能。
const COLS = ["time", "open", "high", "low", "close", "volume", "takerBuy"];
export function packBars(bars) {
  const n = bars.length, buf = new Float64Array(n * COLS.length);
  for (let i = 0; i < n; i++) for (let c = 0; c < COLS.length; c++) buf[i * COLS.length + c] = bars[i][COLS[c]] ?? 0;
  return { v: 1, n, buf };
}
export function unpackBars(rec) {
  if (!rec || rec.v !== 1) return null;
  const out = new Array(rec.n), m = COLS.length, b = rec.buf;
  for (let i = 0; i < rec.n; i++) out[i] = { time: b[i * m], open: b[i * m + 1], high: b[i * m + 2], low: b[i * m + 3], close: b[i * m + 4], volume: b[i * m + 5], takerBuy: b[i * m + 6] };
  return out;
}
export class KlineCache {
  constructor(name = "mtf_klines", keep = 10000, idb = globalThis.indexedDB) {
    this.keep = keep;
    this.db = !idb ? Promise.resolve(null) : new Promise((resolve) => {
      try {
        const req = idb.open(name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore("k");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  async _tx(mode, fn) {
    const db = await this.db;
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const st = db.transaction("k", mode).objectStore("k");
        const req = fn(st);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  async get(key) { return unpackBars(await this._tx("readonly", (s) => s.get(key))); }
  async put(key, bars) { return this._tx("readwrite", (s) => s.put(packBars(bars.slice(-this.keep)), key)); }
  async del(key) { return this._tx("readwrite", (s) => s.delete(key)); }
}
