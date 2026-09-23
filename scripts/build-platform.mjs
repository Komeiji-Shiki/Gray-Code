import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildComputerHost } from './build-computer-host.mjs';
import { readDistributionInfo } from './distribution-info.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const common = {
  absWorkingDir: root, bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', sourcemap: true, logLevel: 'warning',
  define: { __GRAYCODE_DISTRIBUTION__: JSON.stringify(readDistributionInfo(root)) },
};
await build({ ...common, entryPoints: ['packages/contracts/src/index.ts'], outfile: 'packages/contracts/dist/index.cjs' });
for (const [entry, output] of [
  ['packages/core/src/index.ts', 'packages/core/dist/index.cjs'],
  ['packages/core/src/storage/worker.ts', 'packages/core/dist/storage.worker.cjs'],
  ['packages/core/src/storage/longMemory/vector.worker.ts', 'packages/core/dist/long-memory-vector.worker.cjs'],
  ['packages/core/src/characters/worker.ts', 'packages/core/dist/characters.worker.cjs'],
  ['apps/server/src/main.ts', 'apps/server/dist/main.cjs'],
  ['apps/server/src/application.ts', 'apps/server/dist/application.cjs'],
  ['apps/server/src/transport/router.ts', 'apps/server/dist/router.cjs'],
  ['apps/server/src/workspace/terminalHost.ts', 'apps/server/dist/terminalHost.cjs'],
]) {
  const result = await build({
    ...common, entryPoints: [entry], outfile: output, metafile: true,
    external: ['sharp', 'jsonc-parser', 'better-sqlite3', 'node-pty', 'discord.js', '@graycode/contracts', '@graycode/core', 'typescript-language-server', 'typescript',
      'pyright', 'vscode-langservers-extracted', 'yaml-language-server', 'bash-language-server', '@vue/language-server', '@vue/typescript-plugin', 'svelte-language-server'],
  });
  const forbidden = entry.startsWith('packages/core/')
    ? Object.keys(result.metafile.inputs).filter(file => /^(backend|webview|frontend)\//.test(file)) : [];
  const hostImports = Object.values(result.metafile.inputs).flatMap(input => input.imports)
    .filter(input => input.path === 'vscode' || input.path === 'electron');
  if (forbidden.length || hostImports.length) {
    throw new Error(`Platform core crossed a host boundary: ${[...forbidden, ...hostImports.map(input => input.path)].join(', ')}`);
  }
}
// 试用包仅编译可执行产物，不额外执行类型检查。
if (!process.argv.includes('--package-only')) {
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'packages/core/tsconfig.json'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'apps/server/tsconfig.json'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
}
buildComputerHost();
console.log('Platform core, storage worker and CLI built without VS Code/Electron dependencies.');
