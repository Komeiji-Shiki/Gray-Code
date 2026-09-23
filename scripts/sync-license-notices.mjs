import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = ['frontend', 'apps/client', 'apps/server', 'apps/desktop', 'packages/core', 'packages/contracts'];
// 工作区组件在桌面包中独立放置，随包携带完整正文，避免只留下失效的相对链接。
const text = 'GrayCode component licensing\n\nGNU AGPL version 3 only, with the GrayCode Cubism combination exception below.\n'
  + 'Historical MIT material through commit 9fe9efa909f9afd7240d05b349908050a188baa1 retains its original permissions.\n'
  + 'The historical MIT notice below does not offer MIT for all later GrayCode code. Third-party component notices take precedence for their respective material.\n\n'
  + ['LICENSE', 'LICENSES/GrayCode-Cubism-exception.txt', 'LICENSES/MIT-legacy.txt']
    .map(file => `${readFileSync(path.join(root, file), 'utf8').trimEnd()}\n`).join('\n');
let failed = false;
for (const directory of packages) {
  const file = path.join(root, directory, 'LICENSE');
  if (process.argv.includes('--check')) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) { console.error(`工作区许可未同步：${directory}/LICENSE`); failed = true; }
  } else writeFileSync(file, text);
}
if (failed) process.exitCode = 1;
