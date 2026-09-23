import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { distributionSourceNotice } from '../../../shared/distribution';
import { parseBotAction } from '../../../apps/server/src/bots/sessions';

const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(path.resolve(`scripts/${name}.mjs`)).href);
function node(root: string, code: string) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', windowsHide: true });
}
function git(root: string, args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('真实源码归档可核对版本、排除忽略文件，并检测修改与包内篡改', async () => {
  const temporary = path.resolve('.tmp'); await mkdir(temporary, { recursive: true });
  const fixture = await mkdtemp(path.join(temporary, 'source-distribution-'));
  const root = path.join(fixture, 'repo'); await mkdir(root);
  try {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'license-fixture', version: '1.2.3' }));
    await writeFile(path.join(root, '.gitignore'), 'ignored/\nrelease/\n');
    await writeFile(path.join(root, 'app.ts'), 'export const answer = 42;\n');
    for (const file of ['LICENSE', 'LICENSING.md', 'THIRD_PARTY_NOTICES.md', 'LICENSES/MIT-legacy.txt',
      'LICENSES/GrayCode-Cubism-exception.txt', 'fast-tavern-main/LICENSE', 'apps/client/src/pets/vendor/LICENSE',
      'apps/client/src/pets/vendor/CUBISM-LICENSE.md', 'apps/client/src/pets/vendor/provenance.json']) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), await readFile(path.resolve(file)));
    }
    await mkdir(path.join(root, 'ignored')); await writeFile(path.join(root, 'ignored/private.txt'), 'fixture-only-private-data');
    git(root, ['init', '-q']); git(root, ['config', 'core.autocrlf', 'false']);
    git(root, ['remote', 'add', 'origin', 'https://github.com/fixture/derived-project.git']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    const commit = git(root, ['rev-parse', 'HEAD']);
    const manifest = JSON.parse(node(root, `import { createSourcePackage } from ${moduleUrl('package-source')};
      console.log(JSON.stringify(createSourcePackage(process.cwd(), {})));`));
    expect(manifest.buildCommit).toBe(commit);
    expect(manifest.sourceUrl).toBe(`https://github.com/fixture/derived-project/archive/${commit}.zip`);
    const archive = path.join(root, 'release/source', manifest.fileName);
    expect(createHash('sha256').update(await readFile(archive)).digest('hex')).toBe(manifest.sha256);
    const extracted = path.join(fixture, 'extracted'); await mkdir(extracted);
    execFileSync('tar', ['-xzf', archive, '-C', extracted], { windowsHide: true });
    const sourceRoot = path.join(extracted, 'GrayCode-source');
    expect(await readFile(path.join(sourceRoot, 'app.ts'), 'utf8')).toContain('42');
    await expect(readFile(path.join(sourceRoot, 'ignored/private.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const info = () => JSON.parse(node(sourceRoot, `import { readDistributionInfo } from ${moduleUrl('distribution-info')};
      console.log(JSON.stringify(readDistributionInfo(process.cwd(), {})));`));
    expect(info()).toMatchObject({ buildCommit: commit, buildDirty: false, sourceUrl: manifest.sourceUrl });
    await writeFile(path.join(sourceRoot, 'new-code.ts'), 'export const modified = true;');
    expect(info()).toMatchObject({ buildDirty: true }); expect(info().sourceUrl).toBeUndefined();

    const packaged = path.join(fixture, 'packaged');
    await mkdir(path.join(packaged, 'apps/desktop/dist'), { recursive: true });
    await writeFile(path.join(packaged, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    await writeFile(path.join(packaged, 'apps/desktop/dist/build-info.json'), JSON.stringify({ buildCommit: commit, buildDirty: false }));
    node(root, `import { stageDistributionAssets, verifyDistributionAssets } from ${moduleUrl('distribution-assets')};
      stageDistributionAssets(${JSON.stringify(packaged)}, process.cwd(), {}); verifyDistributionAssets(${JSON.stringify(packaged)});`);
    expect(await readFile(path.join(packaged, 'LICENSES/MIT-legacy.txt'), 'utf8')).toContain('LimCode Team');
    await writeFile(path.join(packaged, 'resources/source', manifest.fileName), 'tampered');
    expect(() => node(root, `import { verifyDistributionAssets } from ${moduleUrl('distribution-assets')};
      verifyDistributionAssets(${JSON.stringify(packaged)});`)).toThrow('SHA-256');
    await writeFile(path.join(root, 'app.ts'), 'export const answer = 0;\n');
    expect(() => node(root, `import { createSourcePackage } from ${moduleUrl('package-source')};
      createSourcePackage(process.cwd(), {});`)).toThrow('干净源码');
  } finally {
    if (path.dirname(fixture) !== temporary || !path.basename(fixture).startsWith('source-distribution-')) throw new Error('Unsafe fixture path');
    await rm(fixture, { recursive: true, force: true });
  }
});

test('Bot 源码指令走明确动作，并展示实际部署者的对应版本链接', () => {
  expect(parseBotAction('/gray source')).toEqual({ kind: 'source' });
  const text = distributionSourceNotice({ version: '1.2.3', license: 'AGPL-3.0-only', buildDirty: false,
    sourceUrl: 'https://fork.example/source/abc.tar.gz', licenseUrl: 'https://fork.example/license/abc' });
  expect(text).toContain('对应版本源码：https://fork.example/source/abc.tar.gz');
  expect(text).toContain('许可说明：https://fork.example/license/abc');
  expect(distributionSourceNotice({ license: 'AGPL-3.0-only', buildDirty: true })).toContain('本地开发构建');
});
