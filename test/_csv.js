// 测试共用：读 quant/data/csv 下的币安K线（月文件），按时间去重
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CSV = process.env.QUANT_CSV || path.join(__dirname, '..', '..', 'quant', 'data', 'csv');
export const hasCsv = () => fs.existsSync(CSV);
export function loadCsv(sym, tf, months) {
  if (!hasCsv()) return [];
  const files = fs.readdirSync(CSV).filter((f) => f.startsWith(`${sym}-${tf}-`) && f.endsWith('.csv')).sort().slice(-months);
  const out = [];
  for (const f of files) for (const line of fs.readFileSync(path.join(CSV, f), 'utf8').trim().split('\n')) {
    const c = line.split(',');
    if (!(+c[0] > 0) || !(+c[2] > 0)) continue;
    out.push({ time: Math.floor(+c[0] / 1000), open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5], takerBuy: +c[9] });
  }
  out.sort((a, b) => a.time - b.time);
  return out.filter((x, i) => i === 0 || x.time > out[i - 1].time);
}
export function counter() {
  const t = { pass: 0, fail: 0 };
  t.ok = (cond, msg) => { if (cond) t.pass++; else { t.fail++; if (t.fail <= 30) console.log('  ✗ ' + msg); } };
  t.done = () => {
    console.log('\n' + '='.repeat(70));
    console.log(t.fail ? `失败 ${t.fail} 项 / 通过 ${t.pass} 项` : `全部通过 (${t.pass} 项断言)`);
    process.exit(t.fail ? 1 : 0);
  };
  return t;
}
