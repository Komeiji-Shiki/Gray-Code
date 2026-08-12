/**
 * patch-dist.mjs
 *
 * Post-process frontend/dist for the standalone Electron app:
 *  - copy theme.css + overlay.js into dist
 *  - inject codicons stylesheet, theme, overlay, and sound assets into index.html
 *  - inject a strict Content-Security-Policy meta (production hardening)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'frontend', 'dist');
const indexHtml = path.join(distDir, 'index.html');

if (!fs.existsSync(indexHtml)) {
  console.error('[patch-dist] frontend/dist/index.html not found - run the frontend build first.');
  process.exit(1);
}

fs.copyFileSync(path.join(__dirname, 'renderer', 'theme.css'), path.join(distDir, 'theme.css'));
fs.copyFileSync(path.join(__dirname, 'renderer', 'overlay.js'), path.join(distDir, 'overlay.js'));

const soundAssets = JSON.stringify({
  warning: { url: 'graycode://local/resources/sound/warning.mp3', name: 'warning.mp3' },
  error: { url: 'graycode://local/resources/sound/error.mp3', name: 'error.mp3' },
  taskComplete: { url: 'graycode://local/resources/sound/taskComplete.mp3', name: 'taskComplete.mp3' },
  taskError: { url: 'graycode://local/resources/sound/taskError.mp3', name: 'taskError.mp3' }
});

// 内联引导脚本改为外部文件：配合严格 CSP（script-src 'self'）时内联脚本会被拦截
fs.writeFileSync(
  path.join(distDir, 'sound-assets.js'),
  `window.__GRAYCODE_BUILTIN_SOUND_ASSETS = ${soundAssets};\n`,
  'utf-8'
);

// 首帧启动画面时间戳 + 关闭开关标记（外部文件，CSP script-src 'self' 兼容）：
// - __GC_BOOT_TS：在 <head> 最早执行，记录 Vue 应用挂载前的动画起点；
//   Splash.vue 挂载后据此以负延迟无缝续播 boot-splash.html 的动画（--gc-boot-offset）。
// - gc-splash-disabled 标记：用户关闭启动画面（appearance.splashEnabled=false）时由
//   settingsStore 写入 localStorage；此处读到即在 <html> 上加 gc-no-splash 类。
//   注意：读取改在宏任务（setTimeout 0）中执行——首帧同步访问 localStorage 在渲染进程
//   挂起时可能阻塞首帧绘制（同步存储 IPC 挂起，try/catch 拦不住），异步化后即使存储
//   通路故障也不阻塞首帧（代价：splashEnabled=false 时可能闪现一帧静态画面，可接受）。
fs.writeFileSync(
  path.join(distDir, 'boot-splash.js'),
  [
    'window.__GC_BOOT_TS = Date.now();',
    'try {',
    '  setTimeout(function () {',
    '    try {',
    "      if (localStorage.getItem('gc-splash-disabled') === '1') {",
    "        document.documentElement.classList.add('gc-no-splash');",
    '      }',
    '    } catch (e) {}',
    '  }, 0);',
    '} catch (e) {}',
    ''
  ].join('\n'),
  'utf-8'
);

// 首帧启动画面（纯静态 HTML+CSS，无 JS 依赖）：注入 <body> 开头，
// 窗口第一帧即显示 Splash.vue 同款动画，免去「纯色背景等待 JS 解析挂载」的空窗。
const bootSplashHtml = fs.readFileSync(path.join(__dirname, 'renderer', 'boot-splash.html'), 'utf-8');

let html = fs.readFileSync(indexHtml, 'utf-8');

if (html.includes('<!-- graycode-patch-dist -->')) {
  console.log('[patch-dist] already patched, skipping');
  process.exit(0);
}

const headInject = [
  '<link href="../../resources/codicons/codicon.css" rel="stylesheet">',
  '<link href="./theme.css" rel="stylesheet">',
  '<script src="./sound-assets.js"></script>',
  '<script src="./boot-splash.js"></script>'
].join('\n    ');

// 严格 CSP：脚本仅允许同源（graycode://local），样式允许内联（Vue 动态注入 style 标签需要），
// 图片/媒体允许同源与 data:/blob:（附件渲染），连接仅同源。
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'"
].join('; ');

if (!html.includes('codicon.css')) {
  html = html.replace('</head>', `    ${headInject}\n  </head>`);
}

if (!html.includes('overlay.js')) {
  html = html.replace('<script type="module"', '    <script src="./overlay.js"></script>\n    <script type="module"');
}

// 若已存在旧的内联 sound assets 脚本则移除（升级场景）
html = html.replace(/<script>window\.__GRAYCODE_BUILTIN_SOUND_ASSETS[^<]*<\/script>/g, '');

if (!html.includes('Content-Security-Policy')) {
  html = html.replace('</head>', `    <meta http-equiv="Content-Security-Policy" content="${CSP}">\n  </head>`);
}

// 首帧启动画面注入 <body> 开头（id="gc-boot"，Vue 挂载后由 Splash.vue 移除）
if (!html.includes('id="gc-boot"')) {
  html = html.replace(/<body[^>]*>/i, (match) => `${match}\n${bootSplashHtml}`);
}

html += '\n<!-- graycode-patch-dist -->';

fs.writeFileSync(indexHtml, html, 'utf-8');
console.log('[patch-dist] patched', indexHtml);
