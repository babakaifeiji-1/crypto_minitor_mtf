// 数据层单测：限频、重试/429、K线合并、增量同步、往前翻页、打包
// 运行：node test/data_test.js
import { counter } from './_csv.js';
import { RateLimiter, createApi, mergeBars, upsertBar, syncKlines, loadOlder, klineWeight, pathWeight, packBars, unpackBars } from '../js/data.js';
const T = counter();

// 假时钟：sleep 直接推进时间
const clock = () => { const c = { t: 1_000_000 }; c.now = () => c.t; c.sleep = async (ms) => { c.t += ms; }; return c; };
// 假币安：一串 15m K线，支持 startTime/endTime/limit，记录请求
function fakeBinance(n = 5000, sec = 900, t0 = 1_700_000_000) {
  const all = Array.from({ length: n }, (_, i) => [(t0 + i * sec) * 1000, '1', '2', '0.5', String(1 + i), '10', 0, '0', 0, '4', '0', '0']);
  const srv = { all, reqs: [], fail: [] };
  srv.fetch = async (url) => {
    srv.reqs.push(url);
    const f = srv.fail.shift();
    if (f === 'net') throw new Error('network');
    if (f) return { ok: false, status: f, headers: { get: (h) => (h === 'retry-after' && f === 429 ? '2' : null) }, json: async () => ({ msg: 'x' }) };
    const q = Object.fromEntries(new URL(url, 'http://x').searchParams);
    const lim = +q.limit;
    if (lim > 1500) return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({ msg: 'Invalid limit' }) };
    let s = srv.all;
    if (q.startTime) { s = s.filter((r) => r[0] >= +q.startTime); if (q.endTime) s = s.filter((r) => r[0] <= +q.endTime); s = s.slice(0, lim); }
    else if (q.endTime) { s = s.filter((r) => r[0] <= +q.endTime); s = s.slice(-lim); }
    else s = s.slice(-lim);
    return { ok: true, status: 200, json: async () => s };
  };
  return srv;
}

console.log('1. 权重与限频');
T.ok([1, 100, 101, 500, 501, 1000, 1001, 1500].map(klineWeight).join() === '1,1,2,2,5,5,10,10', 'klines 权重档位');
T.ok(pathWeight('/fapi/v1/ticker/24hr') === 40 && pathWeight('/fapi/v1/ticker/24hr?symbol=BTCUSDT') === 1, 'ticker 权重');
T.ok(pathWeight('/fapi/v1/klines?symbol=X&interval=1m&limit=1500') === 10, 'pathWeight 读 limit');
{
  const c = clock(), L = new RateLimiter({ budget: 30, now: c.now, sleep: c.sleep });
  const t0 = c.t;
  for (let i = 0; i < 9; i++) await L.acquire(10); // 90 权重，预算 30/分钟 → 至少等 2 个窗口
  T.ok(c.t - t0 >= 120000, `超预算要等窗口过期，实际等了 ${c.t - t0}ms`);
  T.ok(L.used() <= 30, `任何时刻窗口内 ≤ 预算，实际 ${L.used()}`);
  const L2 = new RateLimiter({ budget: 5, now: c.now, sleep: c.sleep });
  const t1 = c.t; await L2.acquire(10);
  T.ok(c.t === t1, '单笔超预算也要放行（窗口为空时）');
  L2.pause(5000); const t2 = c.t; await L2.acquire(1);
  T.ok(c.t - t2 >= 5000, 'pause 生效');
}

console.log('2. 重试 / 429 / 4xx');
{
  const c = clock(), srv = fakeBinance(100);
  let throttled = null;
  const api = createApi({ base: '', fetchFn: srv.fetch, limiter: new RateLimiter({ now: c.now, sleep: c.sleep }), sleep: c.sleep, onThrottle: (s, ms) => (throttled = [s, ms]) });
  srv.fail = ['net', 503];
  const k = await api.klines('BTCUSDT', '15m', { limit: 10 });
  T.ok(k.length === 10 && srv.reqs.length === 3, `网络错误 + 503 后重试成功，请求 ${srv.reqs.length} 次`);
  T.ok(k[0].takerBuy === 4 && k[9].close === 100, 'parseKline 字段');
  srv.fail = [429]; const t0 = c.t;
  await api.klines('BTCUSDT', '15m', { limit: 5 });
  T.ok(throttled?.[0] === 429 && throttled[1] === 2000 && c.t - t0 >= 2000, `429 按 Retry-After 暂停：${throttled} 等了 ${c.t - t0}`);
  srv.fail = [418]; const t1 = c.t;
  await api.klines('BTCUSDT', '15m', { limit: 5 });
  T.ok(c.t - t1 >= 120000, '418 默认暂停 120s');
  srv.fail = [400]; let err = null; const n0 = srv.reqs.length;
  try { await api.get('/fapi/v1/klines?symbol=NOPE&interval=15m&limit=1'); } catch (e) { err = e; }
  T.ok(err?.status === 400 && srv.reqs.length === n0 + 1, '4xx 不重试直接抛');
  srv.fail = ['net', 'net', 'net', 'net', 'net']; err = null;
  try { await api.klines('BTCUSDT', '15m', { limit: 5 }); } catch (e) { err = e; }
  T.ok(err && /network/.test(err.message), '重试用完抛最后一个错误');
  T.ok((await api.klines('BTCUSDT', '15m', { limit: 9999 })).length === 100, 'limit 自动夹到 1500');
}

console.log('3. 合并 / upsert');
{
  const b = (ts, v = 0) => ts.map((t) => ({ time: t, close: v }));
  T.ok(mergeBars(b([1, 2, 3]), b([3, 4], 9)).map((x) => x.time + ':' + x.close).join() === '1:0,2:0,3:9,4:9', '尾部追加，重叠以新为准');
  T.ok(mergeBars(b([5, 6]), b([1, 2])).map((x) => x.time).join() === '1,2,5,6', '前插');
  T.ok(mergeBars(b([1, 3, 5]), b([2, 3, 4], 1)).map((x) => x.time + ':' + x.close).join() === '1:0,2:1,3:1,4:1,5:0', '交叉合并');
  T.ok(mergeBars([], b([2, 2, 1])).map((x) => x.time).join() === '2', '去重 + 丢掉乱序');
  const base = b([1, 2]);
  T.ok(mergeBars(base, b([3])) !== base && base.length === 2, '不改入参');
  const a = b([0, 900]);
  T.ok(upsertBar(a, { time: 900, close: 5 }, 900) === 'same' && a[1].close === 5, 'upsert 同一根覆盖');
  T.ok(upsertBar(a, { time: 1800 }, 900) === 'new' && upsertBar(a, { time: 3600 }, 900) === 'gap' && upsertBar(a, { time: 0 }, 900) === 'old', 'upsert new/gap/old');
}

console.log('4. 增量同步 / 往前翻页');
{
  const c = clock(), srv = fakeBinance(5000);
  const api = createApi({ base: '', fetchFn: srv.fetch, limiter: new RateLimiter({ now: c.now, sleep: c.sleep }), sleep: c.sleep });
  const lastMs = srv.all[srv.all.length - 1][0], nowMs = lastMs + 60000;
  // 无缓存：拉最新 1500
  let bars = await syncKlines(api, 'BTCUSDT', '15m', { win: 1500, nowMs });
  T.ok(bars.length === 1500 && bars[1499].time * 1000 === lastMs && srv.reqs.length === 1, `冷启动 1 次请求 1500 根，实际 ${srv.reqs.length} 次 ${bars.length} 根`);
  // 计算窗口比单页大：往前翻页补
  srv.reqs = [];
  bars = await syncKlines(api, 'BTCUSDT', '15m', { win: 2000, nowMs });
  T.ok(bars.length === 2000 && srv.reqs.length === 2 && /endTime=/.test(srv.reqs[1]), `win 2000 → 两次请求（第二次带 endTime）`);
  // 有缓存且只差几根：只请求一次，limit 很小（权重 1）
  const cached = bars.slice(0, -10).map((x) => ({ ...x }));
  cached[cached.length - 1].close = -1; // 缓存的最后一根可能是当时未收盘的，必须被覆盖
  srv.reqs = [];
  const b2 = await syncKlines(api, 'BTCUSDT', '15m', { win: 1500, cached, nowMs });
  T.ok(srv.reqs.length === 1 && /limit=1[0-9]&startTime=/.test(srv.reqs[0]), `增量只补尾部，小 limit：${srv.reqs[0]}`);
  T.ok(b2.length === cached.length + 10 && b2[b2.length - 1].time * 1000 === lastMs, '补齐到最新');
  T.ok(b2[cached.length - 1].close !== -1, '缓存最后一根被最新数据覆盖');
  T.ok(b2.every((x, i) => i === 0 || x.time === b2[i - 1].time + 900), '同步后连续无缺口');
  // 缓存太旧（超过 maxPages 页）→ 丢掉重拉
  srv.reqs = [];
  const old = srv.all.slice(0, 100).map((r) => ({ time: r[0] / 1000, close: 0 }));
  const b3 = await syncKlines(api, 'BTCUSDT', '15m', { win: 1500, cached: old, nowMs, maxPages: 2 });
  T.ok(b3.length === 1500 && b3[0].time > old[99].time, '缓存太旧时整体重拉，不留缺口');
  // 中间段缓存，差 2 页：分页往后补
  srv.reqs = [];
  const mid = srv.all.slice(0, 2500).map((r) => ({ time: r[0] / 1000, close: 0 }));
  const b4 = await syncKlines(api, 'BTCUSDT', '15m', { win: 1500, cached: mid, nowMs, maxPages: 4 });
  T.ok(b4.length === 5000 && srv.reqs.length === 2, `差 2500 根 → 2 页补齐，实际 ${srv.reqs.length} 页 ${b4.length} 根`);
  // 往前翻页直到上市第一根
  let cur = bars.slice(-1500), pages = 0, added;
  do { ({ bars: cur, added } = await loadOlder(api, 'BTCUSDT', '15m', cur)); pages++; } while (added > 0 && pages < 10);
  T.ok(cur.length === 5000 && cur[0].time * 1000 === srv.all[0][0], `往前翻到第一根：${cur.length} 根 ${pages} 页`);
  T.ok(cur.every((x, i) => i === 0 || x.time === cur[i - 1].time + 900), '往前翻页后连续无缺口');
}

console.log('5. 打包');
{
  const bars = [{ time: 1, open: 2, high: 3, low: 1.5, close: 2.5, volume: 9, takerBuy: 4 }, { time: 2, open: 2.5, high: 3, low: 2, close: 2.1, volume: 1, takerBuy: 0 }];
  const back = unpackBars(packBars(bars));
  T.ok(JSON.stringify(back) === JSON.stringify(bars), 'pack/unpack 往返');
  T.ok(unpackBars(null) === null && unpackBars({ v: 0 }) === null, '坏记录返回 null');
}
T.done();
