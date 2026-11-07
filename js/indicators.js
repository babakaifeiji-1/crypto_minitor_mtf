// 技术指标库：所有函数返回与输入等长的数组，预热期为 NaN
export const TA = (() => {
  const nanArr = (n) => new Array(n).fill(NaN);

  function sma(src, n) {
    const out = nanArr(src.length);
    let sum = 0;
    for (let i = 0; i < src.length; i++) {
      sum += src[i];
      if (i >= n) sum -= src[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(src, n) {
    const out = nanArr(src.length);
    const k = 2 / (n + 1);
    let prev = NaN;
    for (let i = 0; i < src.length; i++) {
      if (i < n - 1) continue;
      if (isNaN(prev)) {
        let s = 0;
        for (let j = i - n + 1; j <= i; j++) s += src[j];
        prev = s / n;
      } else {
        prev = src[i] * k + prev * (1 - k);
      }
      out[i] = prev;
    }
    return out;
  }

  // Wilder 平滑（RSI/ATR/ADX 用）；src 中的 NaN 前缀会被跳过
  function rma(src, n) {
    const out = nanArr(src.length);
    let start = 0;
    while (start < src.length && isNaN(src[start])) start++;
    let prev = NaN;
    for (let i = start; i < src.length; i++) {
      if (i < start + n - 1) continue;
      if (isNaN(prev)) {
        let s = 0;
        for (let j = i - n + 1; j <= i; j++) s += src[j];
        prev = s / n;
      } else {
        prev = (prev * (n - 1) + src[i]) / n;
      }
      out[i] = prev;
    }
    return out;
  }

  function trueRange(h, l, c) {
    return h.map((_, i) =>
      i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))
    );
  }

  const atr = (h, l, c, n = 14) => rma(trueRange(h, l, c), n);

  function rsi(c, n = 14) {
    const up = nanArr(c.length), dn = nanArr(c.length);
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      up[i] = Math.max(d, 0);
      dn[i] = Math.max(-d, 0);
    }
    const au = rma(up, n), ad = rma(dn, n);
    return au.map((u, i) => (isNaN(u) ? NaN : ad[i] === 0 ? 100 : 100 - 100 / (1 + u / ad[i])));
  }

  function macd(c, fast = 12, slow = 26, sig = 9) {
    const f = ema(c, fast), s = ema(c, slow);
    const line = f.map((v, i) => v - s[i]);
    const firstValid = line.findIndex((v) => !isNaN(v));
    const signal = nanArr(c.length);
    if (firstValid >= 0) {
      const e = ema(line.slice(firstValid), sig);
      for (let i = 0; i < e.length; i++) signal[firstValid + i] = e[i];
    }
    const hist = line.map((v, i) => v - signal[i]);
    return { line, signal, hist };
  }

  function adx(h, l, c, n = 14) {
    const len = h.length;
    const pdm = nanArr(len), mdm = nanArr(len);
    for (let i = 1; i < len; i++) {
      const upMove = h[i] - h[i - 1], downMove = l[i - 1] - l[i];
      pdm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
      mdm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    }
    const tr = trueRange(h, l, c);
    tr[0] = NaN;
    const str = rma(tr, n), spdm = rma(pdm, n), smdm = rma(mdm, n);
    const pdi = str.map((t, i) => (100 * spdm[i]) / t);
    const mdi = str.map((t, i) => (100 * smdm[i]) / t);
    const dx = pdi.map((p, i) => {
      const s = p + mdi[i];
      return isNaN(s) ? NaN : s === 0 ? 0 : (100 * Math.abs(p - mdi[i])) / s;
    });
    return { adx: rma(dx, n), pdi, mdi };
  }

  // Supertrend：dir = 1 多头 / -1 空头，line 为当前生效的止损轨
  function supertrend(h, l, c, n = 10, mult = 3) {
    const a = atr(h, l, c, n);
    const len = c.length;
    const line = nanArr(len), dir = new Array(len).fill(0);
    let upper = NaN, lower = NaN, d = 1;
    for (let i = 0; i < len; i++) {
      if (isNaN(a[i])) continue;
      const mid = (h[i] + l[i]) / 2;
      const bu = mid + mult * a[i], bl = mid - mult * a[i];
      const pc = c[i - 1];
      upper = isNaN(upper) || bu < upper || pc > upper ? bu : upper;
      lower = isNaN(lower) || bl > lower || pc < lower ? bl : lower;
      if (d === 1 && c[i] < lower) d = -1;
      else if (d === -1 && c[i] > upper) d = 1;
      dir[i] = d;
      line[i] = d === 1 ? lower : upper;
    }
    return { line, dir };
  }

  function highest(src, n, i) {
    let m = -Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, src[j]);
    return m;
  }
  function lowest(src, n, i) {
    let m = Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, src[j]);
    return m;
  }

  return { sma, ema, rma, atr, rsi, macd, adx, supertrend, highest, lowest };
})();
export default TA;
