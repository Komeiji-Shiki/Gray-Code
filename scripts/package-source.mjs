import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, readDistributionInfo, repositoryRoot, requireDistributionSource, sourceMetadataFile } from './distribution-info.mjs';

const checksum = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceDirectory = root => path.join(root, 'release', 'source');

export function createSourcePackage(root = repositoryRoot, env = process.env) {
  const info = readDistributionInfo(root, env); requireDistributionSource(info);
  if (!/^[\w.+-]+$/.test(info.version)) throw new Error('源码包版本号无效。');
  const files = {};
  for (const entry of git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match || match[3] !== '0' || match[1] === '160000') throw new Error('源码包包含未解决的索引或子模块，需先补齐其源码。');
    files[match[4]] = { mode: match[1], hash: match[2] };
  }
  const output = sourceDirectory(root); mkdirSync(output, { recursive: true });
  const fileName = `GrayCode-${info.version}-${info.buildCommit.slice(0, 12)}-source.tar.gz`;
  const archive = path.join(output, fileName);
  const temporary = mkdtempSync(path.join(output, '.source-metadata-'));
  const metadata = path.join(temporary, sourceMetadataFile);
  try {
    writeFileSync(metadata, JSON.stringify({ ...info, files }, null, 2));
    git(root, ['archive', '--format=tar.gz', '--prefix=GrayCode-source/', `--add-file=${metadata}`,
      `--mtime=${git(root, ['show', '-s', '--format=%cI', 'HEAD'])}`, `--output=${archive}`, 'HEAD']);
  } finally { if (existsSync(metadata)) unlinkSync(metadata); rmdirSync(temporary); }
  const manifest = { ...info, fileName, sha256: checksum(archive) };
  writeFileSync(path.join(output, 'source-package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(`${archive}.sha256`, `${manifest.sha256}  ${fileName}\n`);
  return manifest;
}

/** 成品所附源码必须匹配本次构建，不能沿用上一次版本的归档。 */
export function verifySourcePackage(root = repositoryRoot, env = process.env) {
  const info = readDistributionInfo(root, env); requireDistributionSource(info);
  const output = sourceDirectory(root);
  const manifest = JSON.parse(readFileSync(path.join(output, 'source-package.json'), 'utf8'));
  if (typeof manifest.fileName !== 'string' || path.basename(manifest.fileName) !== manifest.fileName) throw new Error('源码归档路径无效。');
  if (manifest.buildCommit !== info.buildCommit || manifest.version !== info.version || manifest.sourceUrl !== info.sourceUrl || manifest.licenseUrl !== info.licenseUrl)
    throw new Error('源码归档与当前提交或分发地址不一致，请重新运行 package:source。');
  const archive = path.join(output, manifest.fileName);
  if (checksum(archive) !== manifest.sha256) throw new Error('源码归档校验失败，请重新运行 package:source。');
  return { manifest, archive };
}

export function copySourcePackage(destination, root = repositoryRoot, env = process.env) {
  const { manifest, archive } = verifySourcePackage(root, env);
  mkdirSync(destination, { recursive: true });
  copyFileSync(archive, path.join(destination, manifest.fileName));
  copyFileSync(`${archive}.sha256`, path.join(destination, `${manifest.fileName}.sha256`));
  copyFileSync(path.join(sourceDirectory(root), 'source-package.json'), path.join(destination, 'source-package.json'));
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = createSourcePackage();
  console.log(`Source package: release/source/${result.fileName}\nSHA-256: ${result.sha256}`);
}
