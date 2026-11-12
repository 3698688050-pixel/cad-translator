// Runs after npm install: acad-ts writes non-ASCII as '?' until the GBK patch is applied.
// Never fails the install — the server only prints a warning if the patch is missing.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, 'scripts', 'patch-acadts.py');

for (const py of ['python', 'python3', 'py']) {
  const r = spawnSync(py, [script, root], { stdio: 'inherit' });
  if (r.error?.code === 'ENOENT') continue;
  process.exit(0);
}
console.log('跳过 GBK 补丁：没找到 python。导出 DWG 前请手动运行 python scripts/patch-acadts.py .');
