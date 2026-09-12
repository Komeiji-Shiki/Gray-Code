import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 打包机直连官方 Electron 下载源不稳定，改走可达镜像；与 @electron/get 的 mirror 变量同口径。
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';
const { packager } = await import('@electron/packager');
const outputDirectory = process.env.GRAYCODE_DESKTOP_OUT
  ? path.resolve(root, process.env.GRAYCODE_DESKTOP_OUT)
  : path.join(root, 'release', 'desktop');

// 先确认目标程序未运行，避免 packager 删除到一半才遇到被占用的 DLL 或目录。
if (process.platform === 'win32') {
  const executable = path.join(outputDirectory, 'GrayCode-win32-x64', 'GrayCode.exe');
  if (require('node:fs').existsSync(executable)) {
    require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$running = Get-Process -Name GrayCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:GRAYCODE_PACKAGE_TARGET }; if ($running) { Write-Error '目标 GrayCode 正在运行，请退出后重试，或指定新的 GRAYCODE_DESKTOP_OUT。'; exit 1 }"],
      { windowsHide: true, stdio: 'inherit', env: { ...process.env, GRAYCODE_PACKAGE_TARGET: executable } });
  }
}

/**
 * 桌面运行时真正的生产依赖（main.cjs bundle 的 external + 其传递闭包）。
 * electron 由运行库自身提供，不进包。
 */
const RUNTIME_ROOTS = ['jsonc-parser', 'node-pty', 'better-sqlite3', 'discord.js', '@graycode/core', '@graycode/contracts', 'typescript', 'typescript-language-server',
  'pyright', 'vscode-langservers-extracted', 'yaml-language-server', 'bash-language-server', '@vue/language-server', '@vue/typescript-plugin', 'svelte-language-server'];
/** 工作区包只需 package.json（定位）+ dist（bundle 外部引用的编译产物）。 */
const WORKSPACE_SLIM = new Set(['@graycode/core', '@graycode/contracts', '@graycode/desktop', '@graycode/server', '@graycode/client']);

function realDir(pkg) {
  return require('node:fs').realpathSync(path.join(root, 'node_modules', pkg));
}

function collectClosure() {
  const fs = require('node:fs');
  const seen = new Map(); // name -> { version, dir }
  const queue = [...RUNTIME_ROOTS];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    let dir;
    try { dir = realDir(name); }
    catch {
      throw new Error(`桌面运行时依赖未安装：${name}。请先执行 npm install。`);
    }
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
    catch { console.log(`WARN: no manifest for ${name} at ${dir}`); continue; }
    seen.set(name, { version: manifest.version ?? '0.0.0', dir });
    const next = { ...(manifest.dependencies ?? {}) };
    for (const [dep, optional] of Object.entries(manifest.optionalDependencies ?? {})) {
      try { realDir(dep); next[dep] = optional; } catch { /* 缺失的可选依赖跳过 */ }
    }
    for (const dep of Object.keys(next)) if (!seen.has(dep)) queue.push(dep);
  }
  return seen;
}

function copyPackage(fs, name, dir, dest) {
  const slim = WORKSPACE_SLIM.has(name);
  fs.cpSync(dir, dest, {
    dereference: true, recursive: true, force: true,
    filter: (src) => {
      if (slim) {
        const rel = path.relative(dir, src).replace(/\\/g, '/');
        if (rel === '') return true;
        // 工作区包只留 package.json + dist。
        if (rel === 'package.json' || rel === 'dist' || rel.startsWith('dist/')) return true;
        return false;
      }
      const base = path.basename(src);
      if (base.endsWith('.pdb')) return false; // 调试符号不进包
      // 原生模块只留 win32-x64 预编译（本机即目标机）。
      if (src.includes(`${path.sep}prebuilds${path.sep}`)) {
        const rel = path.relative(dir, src).replace(/\\/g, '/');
        if (name === 'better-sqlite3') return rel === 'prebuilds' || rel === 'prebuilds/win32-x64.node';
        if (name === 'node-pty') return rel === 'prebuilds' || rel.startsWith('prebuilds/win32-x64');
      }
      return true;
    },
  });
}

const out = await packager({
  dir: '.',
  out: outputDirectory,
  overwrite: true,
  platform: 'win32',
  arch: 'x64',
  electronVersion: require('electron/package.json').version,
  appVersion: require(path.join(root, 'package.json')).version,
  name: 'GrayCode',
  executableName: 'GrayCode',
  icon: 'resources/icon.ico',
  asar: false,
  // 根 package.json 的 dependencies 与桌面运行时无关（prune 会误杀子包的生产依赖），
  // 关闭自动剪裁，改由 afterCopy 按子包 manifests 重建最小生产依赖。
  prune: false,
  afterCopy: [({ buildPath }) => import('node:fs/promises').then(async (fsp) => {
    const fs = require('node:fs');
    // 1. 仓库根 package.json 的 main 指向 VSCode 扩展入口；暂存包改写为桌面入口。
    const file = `${buildPath}/package.json`;
    const pkg = JSON.parse(await fsp.readFile(file, 'utf8'));
    pkg.main = 'apps/desktop/dist/main.cjs';
    await fsp.writeFile(file, JSON.stringify(pkg, null, 2));
    // 2. 托盘图标：main.ts 按 __dirname 上溯到 resources/icon.png。
    await fsp.mkdir(`${buildPath}/resources`, { recursive: true });
    await fsp.copyFile(path.join(root, 'resources', 'icon.png'), `${buildPath}/resources/icon.png`);
    // 3. 重建最小生产 node_modules（复制期已整体排除，见 ignore）。
    const closure = collectClosure();
    let bytes = 0;
    for (const [name, { dir }] of closure) {
      const dest = path.join(buildPath, 'node_modules', ...name.split('/'));
      copyPackage(fs, name, dir, dest);
    }
    for (const [name] of closure) {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile()) bytes += fs.statSync(full).size;
        }
      };
      walk(path.join(buildPath, 'node_modules', ...name.split('/')));
    }
    console.log(`Staged ${closure.size} runtime packages (${(bytes / 1048576).toFixed(1)} MiB): ${[...closure.keys()].join(', ')}`);
  })],
  derefSymlinks: false,
  // 发布包仅包含可执行产物；源码、个人配置和历史调试脚本不进入应用。
  ignore: file => {
    const relative = String(file).replaceAll('\\', '/').replace(/^\//, '');
    if (!relative) return false;
    if (relative.endsWith('.map')) return true;
    const included = ['package.json', 'apps/desktop/dist', 'apps/client/dist'];
    return !included.some(item => relative === item || relative.startsWith(`${item}/`) || item.startsWith(`${relative}/`));
  },
});
const packagedRoot = Array.isArray(out) ? out[0] : out;
const packagedApp = path.join(packagedRoot, 'resources', 'app');
const requiredFiles = [
  'node_modules/jsonc-parser/lib/umd/impl/format.js',
  'apps/desktop/dist/main.cjs',
  'node_modules/@graycode/core/package.json',
  'node_modules/@graycode/core/dist/index.cjs',
  'node_modules/@graycode/contracts/dist/index.cjs',
];
const missing = requiredFiles.filter(file => !require('node:fs').existsSync(path.join(packagedApp, ...file.split('/'))));
if (missing.length) {
  throw new Error(`桌面包缺少运行时文件：${missing.join(', ')}`);
}
console.log('Packaged:', JSON.stringify(out));
