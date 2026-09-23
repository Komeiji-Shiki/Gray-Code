import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createDesktopInstallerArguments } from './desktop-installer-arguments.mjs';
import { assertCleanDesktopPackage } from './desktop-profile-guard.mjs';
import { verifyDistributionAssets } from './distribution-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, process.env.GRAYCODE_DESKTOP_OUT || 'release/desktop', 'GrayCode-win32-x64');
assertCleanDesktopPackage(source);
verifyDistributionAssets(path.join(source, 'resources/app'));
const output = path.resolve(root, process.env.GRAYCODE_INSTALLER_OUT || 'release/desktop-installer');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const packaged = JSON.parse(await readFile(path.join(source, 'resources/app/package.json'), 'utf8'));
const build = JSON.parse(await readFile(path.join(source, 'resources/app/apps/desktop/dist/build-info.json'), 'utf8'));
const vpkVersion = JSON.parse(await readFile(path.join(root, 'node_modules/velopack/package.json'), 'utf8')).version;
if (process.platform !== 'win32') throw new Error('Windows 安装器请在 Windows 构建机运行。');
if (packaged.version !== pkg.version) throw new Error('桌面包与源码版本不一致，请先重新打包桌面程序。');
const args = createDesktopInstallerArguments({
  version: pkg.version, source, output, icon: path.join(root, 'resources/icon.ico'),
});
// 支持任务目录中的同版本工具；常规构建使用仓库固定的 dotnet tool manifest。
const executable = process.env.GRAYCODE_VPK || 'dotnet';
execFileSync(executable, process.env.GRAYCODE_VPK ? args : ['tool', 'run', 'vpk', '--', ...args], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
const assets = [];
for (const name of (await readdir(output)).sort()) {
  if (!/\.(exe|nupkg|json)$/.test(name) || name === 'desktop-release.json') continue;
  const file = path.join(output, name);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  assets.push({ name, bytes: (await stat(file)).size, sha256: hash.digest('hex') });
}
await writeFile(path.join(output, 'desktop-release.json'), JSON.stringify({ format: 1, version: pkg.version,
  platform: 'win32', arch: 'x64', ...build, vpkVersion, assets }, null, 2));
console.log(`Windows installer: ${output}`);
