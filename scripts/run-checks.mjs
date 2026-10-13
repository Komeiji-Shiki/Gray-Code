/**
 * 全量检查编排：`npm run ci` 与 `npm run typecheck:all` 的入口。
 *
 * 检查项与原先串行脚本一一对应，只改变调度：类型检查、构建与独立小项并行，
 * 同时运行的任务数不超过核心数；测试仍按原顺序串行，平台集成测试在最后单独运行。
 * after 只约束先后顺序，前序失败不跳过后续任务，一次运行报告全部失败。
 * 每个任务的输出先缓存，结束时只打印失败任务的输出；全部跑完后统一给出耗时与结果。
 *
 * 用法：node scripts/run-checks.mjs [ci|typecheck]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootRequire = createRequire(path.join(root, 'package.json'));
const frontendRequire = createRequire(path.join(root, 'frontend', 'package.json'));
const cores = os.availableParallelism();

const node = (script, args, cwd = root) => ({ command: process.execPath, args: [script, ...args], cwd });
const tsc = (...args) => node(rootRequire.resolve('typescript/bin/tsc'), args);
const jest = config => node(rootRequire.resolve('jest/bin/jest'), ['--config', config]);
// vitest 的 exports 不公开入口文件，按包目录定位 package.json 声明的 bin。
const vitest = path.join(path.dirname(frontendRequire.resolve('vitest/package.json')), 'vitest.mjs');

// 只检查不输出的程序记录增量信息，未变化的文件复用上次结果；干净检出时与完整检查相同。
const buildInfo = name => ['--incremental', '--tsBuildInfoFile', path.join(root, 'node_modules', '.cache', 'graycode-checks', `${name}.tsbuildinfo`)];
// core 的声明文件是其他程序解析 @graycode/core 类型的来源，类型检查都排在它之后。
// 它会输出声明文件，不记录增量信息，避免产物被清理后因信息未变而不再生成。
const afterCore = ['tsc core'];
const typecheck = [
  { name: 'tsc core', run: tsc('-p', 'packages/core/tsconfig.json') },
  { name: 'tsc server', after: afterCore, run: tsc('-p', 'apps/server/tsconfig.json', ...buildInfo('server')) },
  { name: 'tsc core tests', after: afterCore, run: tsc('-p', 'packages/core/tests/tsconfig.json', ...buildInfo('core-tests')) },
  // 根配置不含 DOM 库，负责 backend 与 shared 的宿主边界，不能并入测试配置。
  { name: 'tsc root', after: afterCore, run: tsc('-p', 'tsconfig.json', '--noEmit', ...buildInfo('root')) },
  { name: 'tsc tests', after: afterCore, run: tsc('-p', 'tsconfig.test.json', '--noEmit', ...buildInfo('tests')) },
  { name: 'tsc desktop', after: afterCore, run: tsc('-p', 'apps/desktop/tsconfig.json', '--noEmit', ...buildInfo('desktop')) },
  { name: 'vue-tsc client', after: afterCore,
    run: node(rootRequire.resolve('vue-tsc/bin/vue-tsc.js'), ['--noEmit', ...buildInfo('client')], path.join(root, 'apps', 'client')) },
  { name: 'vue-tsc frontend', after: afterCore,
    run: node(frontendRequire.resolve('vue-tsc/bin/vue-tsc.js'), ['--noEmit', ...buildInfo('frontend')], path.join(root, 'frontend')) },
];
// 测试 worker 都按一半核心启动，部分用例按耗时设超时；与类型检查或另一套测试重叠时会被拖慢，按原顺序串行。
const afterTypecheck = typecheck.map(task => task.name);
const ci = [
  ...typecheck,
  { name: 'jest backend', after: afterTypecheck, run: jest('jest.backend.config.js') },
  { name: 'vitest frontend', after: ['jest backend'], run: node(vitest, ['run'], path.join(root, 'frontend')) },
  // 上面的类型检查已覆盖 core 与 server，构建只编译平台产物。
  { name: 'build platform', run: node('scripts/build-platform.mjs', ['--package-only']) },
  { name: 'fast-tavern ts', run: { command: 'npm run test:fast-tavern-ts', args: [], cwd: root, shell: true } },
  { name: 'fast-tavern py', run: node('scripts/run-fast-tavern-py.mjs', []) },
  { name: 'i18n check', run: node('scripts/i18n-sync.mjs', ['--check']) },
  // 独占任务在其余任务（含平台构建）全部结束后才启动。
  { name: 'jest platform', exclusive: true, run: jest('jest.platform.config.cjs') },
];

const plans = { ci, typecheck };
const planName = process.argv[2] ?? 'ci';
const plan = plans[planName];
if (!plan) {
  console.error(`未知的检查组：${planName}，可用：${Object.keys(plans).join('、')}`);
  process.exit(2);
}

const seconds = start => ((performance.now() - start) / 1000).toFixed(1);
const results = new Map();
const running = new Set();
const started = performance.now();

function launch(task) {
  const start = performance.now();
  running.add(task.name);
  console.log(`→ ${task.name}`);
  return new Promise(resolve => {
    const chunks = [];
    let settled = false;
    const child = spawn(task.run.command, task.run.args, { cwd: task.run.cwd, shell: task.run.shell ?? false, windowsHide: true });
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => chunks.push(chunk));
    // 启动失败时 Node 会先发 error，随后仍可能发 close；每个任务只结算一次。
    const done = (passed, extra = '') => {
      if (settled) return;
      settled = true;
      running.delete(task.name);
      const time = seconds(start);
      results.set(task.name, { passed, time });
      if (passed) console.log(`✓ ${task.name}（${time}s）`);
      else console.log(`\n✗ ${task.name}（${time}s）\n${(Buffer.concat(chunks).toString() + extra).trimEnd()}\n`);
      resolve();
    };
    child.on('error', error => done(false, `\n${error.message}`));
    child.on('close', code => done(code === 0));
  });
}

await new Promise(resolveAll => {
  const pending = [...plan];
  const schedule = () => {
    for (let index = 0; index < pending.length; index++) {
      const task = pending[index];
      if (task.after?.some(name => !results.has(name))) continue;
      // 独占任务等其他任务全部启动并结束后才运行，因此它运行期间不会再有新任务。
      if (task.exclusive) {
        if (running.size || pending.some(other => other !== task && !other.exclusive)) continue;
      } else if (running.size >= cores) continue;
      pending.splice(index--, 1);
      void launch(task).then(schedule);
    }
    if (!pending.length && !running.size) resolveAll();
  };
  schedule();
});

const failed = [...results.values()].filter(result => !result.passed).length;
console.log(`\n检查组 ${planName}：${results.size - failed}/${results.size} 通过，总耗时 ${seconds(started)}s`);
for (const { name } of plan) {
  const result = results.get(name);
  console.log(`  ${result.passed ? '✓' : '✗'} ${name.padEnd(18)} ${result.time}s`);
}
process.exit(failed ? 1 : 0);
