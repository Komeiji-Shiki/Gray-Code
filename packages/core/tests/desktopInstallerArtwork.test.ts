import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TEMP_DIR_REMOVE_OPTIONS } from './fixtures';

test('实际生成安装器 PNG，并将图片路径传给 Velopack', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'graycode-artwork-'));
  const output = path.join(directory, 'installer.png');
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createDesktopInstallerArtwork } from './scripts/desktop-installer-artwork.mjs';
      import { createDesktopInstallerArguments } from './scripts/desktop-installer-arguments.mjs';
      import assert from 'node:assert/strict';
      await createDesktopInstallerArtwork({ version: '2.0.0-pre.4', icon: 'resources/icon.svg', output: ${JSON.stringify(output)} });
      const args = createDesktopInstallerArguments({version:'2.0.0',source:'source',output:'out',icon:'icon',splashImage:${JSON.stringify(output)}});
      assert(args.includes('--splashImage=' + ${JSON.stringify(output)}));
      assert(!createDesktopInstallerArguments({version:'2.0.0',source:'source',output:'out',icon:'icon'}).some(arg=>arg.startsWith('--splashImage')));
    `], { cwd: path.resolve(__dirname, '../../..') });
    const png = await readFile(output); expect(png.subarray(1,4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(680); expect(png.readUInt32BE(20)).toBe(360);
  } finally { await rm(directory, TEMP_DIR_REMOVE_OPTIONS); }
});
