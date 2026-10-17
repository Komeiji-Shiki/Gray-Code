/**
 * 平台用例的增量入口。
 *
 * 平台测试经构建产物导入 core，Jest 的静态依赖图看不到 `packages/core/src` 等源码改动，
 * `--onlyChanged` 会因此选不中相关用例。除测试外的平台改动直接运行完整套件；
 * 只有测试文件自身变化时才使用 Jest 的增量选择。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jest = createRequire(path.join(root, 'package.json')).resolve('jest/bin/jest');
const changed = [
  ...execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' }).split('\n'),
  ...execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n'),
].filter(Boolean);
const platformSource = changed.filter(file => /^(apps\/server|packages\/(core|contracts)|shared|backend)\//.test(file)
  && !file.startsWith('packages/core/tests/'));

const args = [jest, '--config', 'jest.platform.config.cjs'];
if (platformSource.length) {
  console.log(`[test:platform:changed] 检测到 ${platformSource.length} 个平台源码改动，运行完整平台用例。`);
} else {
  args.push('--onlyChanged', '--passWithNoTests');
}
const result = spawnSync(process.execPath, [...args, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
