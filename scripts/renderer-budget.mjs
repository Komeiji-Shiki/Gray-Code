import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reports = [];
// Monaco 上限沿用审计前的实际单块体积，拆分不能靠提高 Vite 警告阈值达标。
for (const [name, directory, largestLimit] of [['shell', 'apps/client/dist', 4_034_590], ['chat', 'apps/client/dist/chat', 1_400_000]]) {
  const base = path.join(root, directory);
  const manifest = JSON.parse(await readFile(path.join(base, '.vite/manifest.json'), 'utf8'));
  const sizes = new Map();
  for (const file of await readdir(path.join(base, 'assets'))) if (file.endsWith('.js')) {
    const contents = await readFile(path.join(base, 'assets', file));
    sizes.set(`assets/${file}`, { file, bytes: contents.length, gzip: gzipSync(contents).length });
  }
  const entries = Object.entries(manifest).filter(([, item]) => item.isEntry).map(([id, item]) => {
    const visited = new Set(), files = new Set();
    function collect(key) {
      if (visited.has(key)) return; visited.add(key);
      const chunk = manifest[key]; if (!chunk) throw new Error(`Missing manifest chunk ${key}`);
      if (chunk.file.endsWith('.js')) files.add(chunk.file);
      for (const dependency of chunk.imports ?? []) collect(dependency);
    }
    collect(id);
    return { entry: item.src ?? id, initialJsBytes: [...files].reduce((sum, file) => sum + (sizes.get(file)?.bytes ?? 0), 0),
      initialJsGzip: [...files].reduce((sum, file) => sum + (sizes.get(file)?.gzip ?? 0), 0), staticFiles: [...files] };
  });
  const dynamicViews = Object.entries(manifest).filter(([id, item]) => item.isDynamicEntry && /(?:App|CodeEditor|TerminalPanel|SubAgentMonitor|ChannelSettings|PromptSettings)\.vue$/.test(id)).map(([id, item]) => {
    const files = new Set(); const visited = new Set();
    const collect = key => { if (visited.has(key)) return; visited.add(key); const chunk = manifest[key]; if (!chunk) throw new Error(`Missing manifest chunk ${key}`);
      if (chunk.file.endsWith('.js')) files.add(chunk.file); for (const dependency of chunk.imports ?? []) collect(dependency); };
    collect(id);
    return { view: item.src ?? id, jsBytesIncludingStaticDependencies: [...files].reduce((sum, file) => sum + sizes.get(file).bytes, 0), files: [...files] };
  });
  const workers = [...sizes.values()].filter(item => /\.worker-/.test(item.file)).sort((a, b) => b.bytes - a.bytes);
  const largest = [...sizes.values()].filter(item => !/\.worker-/.test(item.file)).sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  const workerLimit = 7_100_000;
  reports.push({ name, largestLimit, workerLimit, entries, dynamicViews, largest, workers });
  if (largest[0].bytes > largestLimit) throw new Error(`${name} renderer chunk exceeds reviewed budget: ${largest[0].file} ${largest[0].bytes} > ${largestLimit}`);
  if (workers[0]?.bytes > workerLimit) throw new Error(`${name} worker exceeds reviewed budget: ${workers[0].file}`);
}
await mkdir(path.join(root, '.tmp'), { recursive: true });
await writeFile(path.join(root, '.tmp/renderer-budget.json'), JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
for (const report of reports) console.log(`${report.name}: largest ${report.largest[0].bytes} bytes; ${report.entries.map(entry => `${entry.entry} initial ${entry.initialJsBytes} bytes`).join(', ')}`);
