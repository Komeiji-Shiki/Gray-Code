import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('桌面包保留依赖方使用的嵌套版本、传递依赖和工作区本地依赖', async () => {
  const root = await mkdtemp(path.resolve('.tmp/desktop-dependencies-'));
  const manifest = async (relative: string, value: object) => {
    const directory = path.join(root, relative);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify(value));
  };
  try {
    await manifest('.', {});
    await manifest('node_modules/alpha', { name: 'alpha', dependencies: { shared: '1', leaf: '1' }, optionalDependencies: { absent: '1' }, devDependencies: { development: '1' } });
    await manifest('node_modules/beta', { name: 'beta', dependencies: { shared: '2' } });
    await manifest('node_modules/alpha/node_modules/shared', { name: 'shared', version: '1.0.0', exports: './index.js' });
    await manifest('node_modules/shared', { name: 'shared', version: '2.0.0', dependencies: { leaf: '1' } });
    await manifest('node_modules/leaf', { name: 'leaf', version: '1.0.0' });
    await manifest('packages/workspace', { name: 'workspace', dependencies: { local: '1' } });
    await manifest('packages/workspace/node_modules/local', { name: 'local', version: '1.0.0' });
    await symlink(path.join(root, 'packages/workspace'), path.join(root, 'node_modules/workspace'), 'junction');
    const module = pathToFileURL(path.resolve('scripts/desktop-runtime-dependencies.mjs')).href;
    const script = `import { collectRuntimeDependencies } from ${JSON.stringify(module)};
      console.log(JSON.stringify([...collectRuntimeDependencies(process.argv[1], ['alpha', 'beta', 'workspace']).values()]));`;
    const entries = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, root], { encoding: 'utf8', windowsHide: true }));
    const versions = Object.fromEntries(entries.map((entry: { relative: string; version: string }) => [entry.relative.replaceAll('\\', '/'), entry.version]));
    expect(versions).toEqual({
      'node_modules/alpha': '0.0.0', 'node_modules/beta': '0.0.0', 'node_modules/workspace': '0.0.0',
      'node_modules/alpha/node_modules/shared': '1.0.0', 'node_modules/shared': '2.0.0',
      'node_modules/leaf': '1.0.0', 'node_modules/workspace/node_modules/local': '1.0.0',
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('安装器参数把含空格文本和路径绑定到对应选项', () => {
  const module = pathToFileURL(path.resolve('scripts/desktop-installer-arguments.mjs')).href;
  const script = `import { createDesktopInstallerArguments } from ${JSON.stringify(module)};
    console.log(JSON.stringify(createDesktopInstallerArguments({ version: '2.0.0-pre.2', source: 'C:/Gray Code/app',
      output: 'C:/Gray Code/release', icon: 'C:/Gray Code/icon.ico' })));`;
  const args = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', windowsHide: true }));
  expect(args).toContain('--packAuthors=GrayCode contributors');
  expect(args).toContain('--packDir=C:/Gray Code/app');
  expect(args).toContain('--outputDir=C:/Gray Code/release');
  expect(args).toContain('--icon=C:/Gray Code/icon.ico');
  expect(args).not.toContain('GrayCode contributors');
});
