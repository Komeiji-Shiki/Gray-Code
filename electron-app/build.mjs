/**
 * build.mjs - bundle the Electron main + preload with esbuild.
 *
 * 三包拆分（启动提速）：
 * - dist/main.js            主进程壳（main/native/protocol/logger）——启动路径只解析这个
 * - dist/host/BackendHost.js 后端宿主（内联 backend + webview 路由，~1.2MB）——createBackend 懒加载
 * - dist/vscode-shim.js     vscode shim 独立共享包——主进程壳与 BackendHost 共用同一实例
 * - dist/preload.js         渲染层 preload（sandbox 下必须 CJS）
 *
 * BackendHost 包内的 `vscode` 导入经 alias 改写为 '../vscode-shim.js'（external），
 * 运行时会从 dist/host/ 解析到 dist/vscode-shim.js；主进程壳经 './vscode-shim.js'
 * 从 dist/ 解析到同一文件——两边拿到同一个模块实例，避免 shim 状态（windowFocused/
 * memento 存储）双份漂移。
 */

import { build } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, 'src');
const distDir = path.resolve(__dirname, 'dist');

// --dev / --watch：开发模式保留 sourcemap 与未压缩代码（可读栈 + 源码映射）；
// 默认（发布）压缩并关闭 sourcemap
const isDev = process.argv.includes('--dev') || process.argv.includes('--watch');
const isWatch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info',
  legalComments: 'none',
  minify: !isDev,
  sourcemap: isDev,
  define: { 'process.env.NODE_ENV': isDev ? '"development"' : '"production"' }
};

/** 主进程壳：BackendHost 与 vscode-shim 拆出为运行时外部依赖（各自独立打包） */
const mainBuild = {
  ...common,
  entryPoints: [path.join(srcDir, 'main.ts')],
  outfile: path.join(distDir, 'main.js'),
  alias: { vscode: './vscode-shim.js' },
  external: [...common.external, './vscode-shim.js', './host/BackendHost.js']
};

/** 后端宿主：vscode → 共享 shim 包（从 dist/host/ 向上解析到 dist/vscode-shim.js） */
const hostBuild = {
  ...common,
  entryPoints: [path.join(srcDir, 'host', 'BackendHost.ts')],
  outfile: path.join(distDir, 'host', 'BackendHost.js'),
  alias: { vscode: '../vscode-shim.js' },
  external: [...common.external, '../vscode-shim.js']
};

/** vscode shim 独立包：主进程壳与后端宿主共用的唯一实例 */
const shimBuild = {
  ...common,
  entryPoints: [path.join(srcDir, 'vscode-shim.ts')],
  outfile: path.join(distDir, 'vscode-shim.js')
};

const preloadBuild = {
  ...common,
  entryPoints: [path.join(srcDir, 'preload.ts')],
  outfile: path.join(distDir, 'preload.js')
};

async function buildOnce() {
  await Promise.all([
    build(mainBuild),
    build(hostBuild),
    build(shimBuild),
    build(preloadBuild)
  ]);
}

if (isWatch) {
  const contexts = [mainBuild, hostBuild, shimBuild, preloadBuild].map((options) =>
    build({
      ...options,
      entryPoints: options.entryPoints,
      plugins: [
        {
          name: 'rebuild-logger',
          setup(build) {
            build.onEnd((result) => {
              if (result.errors.length > 0) {
                console.error(`[esbuild] ${options.outfile} rebuild failed with ${result.errors.length} error(s)`);
              } else {
                console.log(`[esbuild] ${options.outfile} rebuild done`);
              }
            });
          }
        }
      ]
    })
  );
  const ctxs = await Promise.all(contexts);
  await Promise.all(ctxs.map((ctx) => ctx.watch()));
  console.log('[esbuild] watching for changes... (Ctrl+C to stop)');
} else {
  await buildOnce();
  console.log('[build] done');
}
