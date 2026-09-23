import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { copySourcePackage } from './package-source.mjs';
import { repositoryRoot } from './distribution-info.mjs';

export const legalFiles = ['LICENSE', 'LICENSING.md', 'THIRD_PARTY_NOTICES.md',
  'LICENSES/MIT-legacy.txt', 'LICENSES/GrayCode-Cubism-exception.txt', 'fast-tavern-main/LICENSE',
  'apps/client/src/pets/vendor/LICENSE', 'apps/client/src/pets/vendor/CUBISM-LICENSE.md',
  'apps/client/src/pets/vendor/provenance.json'];

export function stageDistributionAssets(destination, root = repositoryRoot, env = process.env) {
  for (const relative of legalFiles) {
    const output = path.join(destination, relative); mkdirSync(path.dirname(output), { recursive: true });
    copyFileSync(path.join(root, relative), output);
  }
  return copySourcePackage(path.join(destination, 'resources/source'), root, env);
}

/** 安装器也检查复制后的实际归档，避免二进制与源码在分发阶段被错配。 */
export function verifyDistributionAssets(directory) {
  for (const relative of legalFiles) if (!existsSync(path.join(directory, relative))) throw new Error(`发行包缺少许可文件：${relative}`);
  const sourceDirectory = path.join(directory, 'resources/source');
  const source = JSON.parse(readFileSync(path.join(sourceDirectory, 'source-package.json'), 'utf8'));
  const build = JSON.parse(readFileSync(path.join(directory, 'apps/desktop/dist/build-info.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (build.buildDirty || !build.buildCommit || source.buildCommit !== build.buildCommit || source.version !== pkg.version)
    throw new Error('发行包的程序与源码版本不一致。');
  if (typeof source.fileName !== 'string' || path.basename(source.fileName) !== source.fileName) throw new Error('发行包源码路径无效。');
  const hash = createHash('sha256').update(readFileSync(path.join(sourceDirectory, source.fileName))).digest('hex');
  if (hash !== source.sha256) throw new Error('发行包源码 SHA-256 不一致。');
  return source;
}
