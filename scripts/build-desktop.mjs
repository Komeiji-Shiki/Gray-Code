import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildComputerHost } from './build-computer-host.mjs';
const require = createRequire(import.meta.url);
const buildInfo = { buildTime: new Date().toISOString() };
try {
  const gitOptions = { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
  buildInfo.buildCommit = execFileSync('git', ['rev-parse', 'HEAD'], gitOptions).trim();
  buildInfo.buildDirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], gitOptions).trim();
} catch { /* 源码压缩包没有 Git 信息，保留实际构建时间。 */ }
for (const name of ['main', 'preload']) {
  await build({ entryPoints: [`apps/desktop/src/${name}.ts`], outfile: `apps/desktop/dist/${name}.cjs`,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true,
    define: { __GRAYCODE_DESKTOP_BUILD__: JSON.stringify(buildInfo) },
    external: ['sharp', 'jsonc-parser', 'electron', 'node-pty', 'better-sqlite3', 'discord.js', '@graycode/core', '@graycode/contracts', 'typescript', 'typescript-language-server'] });
}
// 原生终端放入独立宿主，进程退出时一并回收其读取线程。
await build({ entryPoints: ['apps/server/src/workspace/terminalHost.ts'], outfile: 'apps/desktop/dist/terminalHost.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['node-pty'] });
// 试用包仅编译可执行产物，不额外执行类型检查。
if (!process.argv.includes('--package-only')) {
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'apps/desktop/tsconfig.json'], { stdio: 'inherit', windowsHide: true });
}
buildComputerHost('apps/desktop/dist/computer-host');
console.log('Desktop main process and isolated preload built.');
