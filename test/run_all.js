// 依次跑 test/ 下所有 *_test.js，任何一个失败则退出码非 0
import { readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
const dir = path.dirname(fileURLToPath(import.meta.url));
let bad = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('_test.js')).sort()) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  const last = (r.stdout || '').trim().split('\n').pop();
  console.log(`${r.status === 0 ? '✓' : '✗'} ${f.padEnd(24)} ${last}`);
  if (r.status !== 0) { bad++; console.log(r.stdout.split('\n').filter((l) => l.includes('✗')).slice(0, 10).join('\n'), r.stderr); }
}
process.exit(bad ? 1 : 0);
