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

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  alias: { vscode: vscodeAlias },
  logLevel: 'info',
  legalComments: 'none',
  // 发布产物压缩（主进程 bundle 含整个 backend，体积数 MB）
  minify: true,
  sourcemap: false
};

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

console.log('[build] done');
