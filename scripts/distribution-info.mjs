import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sourceMetadataFile = '.graycode-source.json';
export const projectLicense = 'AGPL-3.0-only with GrayCode Cubism exception 1.0';

export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function webUrl(value, name) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(`${name} 必须是不含认证信息的 HTTP(S) 地址。`);
  return url.href.replace(/\/$/, '');
}

function sourceRepository(root, env) {
  if (env.GRAYCODE_SOURCE_REPOSITORY) return webUrl(env.GRAYCODE_SOURCE_REPOSITORY, 'GRAYCODE_SOURCE_REPOSITORY');
  try {
    let remote = git(root, ['remote', 'get-url', 'origin']);
    if (/^git@[^:]+:/.test(remote)) remote = remote.replace(/^git@([^:]+):/, 'https://$1/');
    const url = new URL(remote);
    if (url.protocol === 'ssh:') url.protocol = 'https:';
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    url.pathname = url.pathname.replace(/\.git$/, '');
    return webUrl(url.href, 'origin');
  } catch { return undefined; }
}

/** 源码包没有 .git；按归档内的 Git blob 校验值识别其后发生的修改。 */
function archiveModified(root, files) {
  if (!files || !Object.keys(files).length) return true;
  for (const [relative, entry] of Object.entries(files)) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('源码清单包含越界路径。');
    try {
      const bytes = entry.mode === '120000' ? Buffer.from(readlinkSync(file)) : readFileSync(file);
      const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (hash !== entry.hash) return true;
    } catch { return true; }
  }
  const generated = new Set(['node_modules', 'dist', '.git', '.tmp', 'release', 'coverage', '.cache', '.venv', '__pycache__', '.pytest_cache']);
  const addedFiles = directory => readdirSync(directory, { withFileTypes: true }).some(entry => {
    if (entry.isDirectory()) return !generated.has(entry.name) && addedFiles(path.join(directory, entry.name));
    const relative = path.relative(root, path.join(directory, entry.name)).replaceAll('\\', '/');
    return relative !== sourceMetadataFile && !Object.hasOwn(files, relative);
  });
  if (addedFiles(root)) return true;
  return false;
}

export function readDistributionInfo(root = repositoryRoot, env = process.env) {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  let buildCommit, buildDirty = true, repositoryUrl = sourceRepository(root, env), archived;
  const metadataPath = path.join(root, sourceMetadataFile);
  // 先看归档身份，避免源码包放在另一个 Git 仓库内时误认外层仓库。
  if (existsSync(metadataPath) && !existsSync(path.join(root, '.git'))) {
    const saved = JSON.parse(readFileSync(metadataPath, 'utf8'));
    archived = saved;
    buildCommit = saved.buildCommit;
    buildDirty = archiveModified(root, saved.files);
    repositoryUrl = env.GRAYCODE_SOURCE_REPOSITORY ? repositoryUrl : saved.repositoryUrl;
  } else {
    try {
      if (path.resolve(git(root, ['rev-parse', '--show-toplevel'])) === path.resolve(root)) {
        buildCommit = git(root, ['rev-parse', 'HEAD']);
        buildDirty = !!git(root, ['status', '--porcelain', '--untracked-files=normal']);
      }
    } catch { /* 没有来源身份的目录仍可开发构建，但不冒充某个已发布版本。 */ }
  }
  if (buildCommit && !/^[a-f0-9]{40,64}$/.test(buildCommit)) throw new Error('源码提交标识无效。');
  let sourceUrl, licenseUrl;
  if (!buildDirty && archived) { sourceUrl = archived.sourceUrl; licenseUrl = archived.licenseUrl; }
  if (!buildDirty && buildCommit && repositoryUrl && new URL(repositoryUrl).hostname === 'github.com') {
    sourceUrl ??= `${repositoryUrl}/archive/${buildCommit}.zip`;
    licenseUrl ??= `${repositoryUrl}/blob/${buildCommit}/LICENSING.md`;
  }
  if (env.GRAYCODE_SOURCE_URL) sourceUrl = webUrl(env.GRAYCODE_SOURCE_URL, 'GRAYCODE_SOURCE_URL');
  if (env.GRAYCODE_LICENSE_URL) licenseUrl = webUrl(env.GRAYCODE_LICENSE_URL, 'GRAYCODE_LICENSE_URL');
  return { version, license: projectLicense, buildCommit, buildDirty, repositoryUrl, sourceUrl, licenseUrl };
}

export function requireDistributionSource(info) {
  if (info.buildDirty || !info.buildCommit) throw new Error('公开打包需要已提交的干净源码，请先提交改动。开发调试可以直接运行 build:desktop。');
  if (!info.sourceUrl || !info.licenseUrl) throw new Error('无法确定源码或许可地址，请配置 GRAYCODE_SOURCE_URL 和 GRAYCODE_LICENSE_URL。');
}
