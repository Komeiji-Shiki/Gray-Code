/**
 * patch-dist.mjs
 *
 * Post-process frontend/dist for the standalone Electron app:
 *  - copy theme.css + overlay.js into dist
 *  - inject codicons stylesheet, theme, overlay, and sound assets into index.html
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

let html = fs.readFileSync(indexHtml, 'utf-8');

const headInject = [
  '<link href="../../resources/codicons/codicon.css" rel="stylesheet">',
  '<link href="./theme.css" rel="stylesheet">',
  `<script>window.__GRAYCODE_BUILTIN_SOUND_ASSETS = ${soundAssets};</script>`
].join('\n    ');

if (!html.includes('codicon.css')) {
  html = html.replace('</head>', `    ${headInject}\n  </head>`);
}

if (!html.includes('overlay.js')) {
  html = html.replace('<script type="module"', '    <script src="./overlay.js"></script>\n    <script type="module"');
}

fs.writeFileSync(indexHtml, html, 'utf-8');
console.log('[patch-dist] patched', indexHtml);
