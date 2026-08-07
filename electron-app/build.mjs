/**
 * build.mjs - bundle the Electron main + preload with esbuild.
 *
 * The backend (backend/ + webview/) imports `vscode`; we alias it to our shim
 * so the whole backend runs unmodified in the main process.
 */

import { build } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vscodeAlias = path.resolve(__dirname, 'src', 'vscode-shim.ts');

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
  alias: { vscode: vscodeAlias },
  logLevel: 'info',
  legalComments: 'none',
  minify: !isDev,
  sourcemap: isDev,
  define: { 'process.env.NODE_ENV': isDev ? '"development"' : '"production"' }
};

async function buildOnce() {
  await build({
    ...common,
    entryPoints: [path.resolve(__dirname, 'src', 'main.ts')],
    outfile: path.resolve(__dirname, 'dist', 'main.js')
  });

  await build({
    ...common,
    entryPoints: [path.resolve(__dirname, 'src', 'preload.ts')],
    outfile: path.resolve(__dirname, 'dist', 'preload.js')
  });
}

if (isWatch) {
  const ctx = await (await import('esbuild')).context({
    ...common,
    entryPoints: [
      path.resolve(__dirname, 'src', 'main.ts'),
      path.resolve(__dirname, 'src', 'preload.ts')
    ],
    outdir: path.resolve(__dirname, 'dist'),
    entryNames: '[name]',
    plugins: [
      {
        name: 'rebuild-logger',
        setup(build) {
          build.onEnd((result) => {
            if (result.errors.length > 0) {
              console.error(`[esbuild] rebuild failed with ${result.errors.length} error(s)`);
            } else {
              console.log('[esbuild] rebuild done');
            }
          });
        }
      }
    ]
  });
  await ctx.watch();
  console.log('[esbuild] watching for changes... (Ctrl+C to stop)');
} else {
  await buildOnce();
  console.log('[build] done');
}
