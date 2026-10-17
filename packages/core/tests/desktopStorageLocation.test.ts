import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DesktopStorageLocation } from '../../../apps/desktop/src/storageLocation';
import * as directoryCapture from '../../../apps/server/src/migration/directoryCapture';
import { TEMP_DIR_REMOVE_OPTIONS } from './fixtures';

let directory: string;
let source: string;
let userData: string;

beforeEach(async () => {
  const temporaryRoot = path.resolve('.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  directory = await mkdtemp(path.join(temporaryRoot, 'desktop-storage-location-'));
  source = path.join(directory, 'source');
  userData = path.join(directory, 'profile');
  await mkdir(source);
  await writeFile(path.join(source, 'history.json'), '原数据');
});

afterEach(async () => {
  jest.restoreAllMocks();
  if (path.dirname(directory) !== path.resolve('.tmp') || !path.basename(directory).startsWith('desktop-storage-location-')) {
    throw new Error('临时迁移夹具目录无效。');
  }
  await rm(directory, TEMP_DIR_REMOVE_OPTIONS);
});

test('目标祖先经目录联接进入当前数据目录时拒绝迁移', async () => {
  const alias = path.join(directory, 'alias');
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const location = new DesktopStorageLocation(userData, source);
  const target = path.join(alias, 'nested', 'destination');

  await expect(location.validate(target)).resolves.toMatchObject({ valid: false });
  await expect(location.schedule(target)).resolves.toMatchObject({ success: false });
  expect(location.getConfig().config.pendingMigration).toBeUndefined();
  expect(await readFile(path.join(source, 'history.json'), 'utf8')).toBe('原数据');
});

test('位于独立目录联接下的新目录仍可正常迁移并保留原数据', async () => {
  const parent = path.join(directory, 'other');
  const alias = path.join(directory, 'alias');
  await mkdir(parent);
  await symlink(parent, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const target = path.join(alias, 'destination');
  const location = new DesktopStorageLocation(userData, source);

  await expect(location.schedule(target)).resolves.toMatchObject({ success: true });
  const restarted = new DesktopStorageLocation(userData, source);
  await expect(restarted.startup()).resolves.toBe(target);
  expect(await readFile(path.join(target, 'history.json'), 'utf8')).toBe('原数据');
  expect(await readFile(path.join(source, 'history.json'), 'utf8')).toBe('原数据');
});

test('重启处理已有迁移记录时，先拒绝实际嵌套路径再清理暂存目录', async () => {
  const alias = path.join(directory, 'alias');
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const staging = path.join(alias, '.graycode-move-11111111-1111-4111-8111-111111111111');
  await mkdir(staging);
  await writeFile(path.join(staging, 'preserved.txt'), '校验之前不能删除');
  await mkdir(userData);
  await writeFile(path.join(userData, 'storage-location.json'), JSON.stringify({
    version: 1,
    currentPath: source,
    pendingMigration: {
      sourcePath: source,
      targetPath: path.join(alias, 'destination'),
      stagingPath: staging,
      createdAt: 1,
    },
  }));
  // 若边界失效立即终止复制，失败用例本身不能递归扩张夹具目录。
  const capture = jest.spyOn(directoryCapture, 'captureDirectory').mockRejectedValue(new Error('不应开始复制'));

  await expect(new DesktopStorageLocation(userData, source).startup()).rejects.toThrow('待迁移路径无效');
  expect(capture).not.toHaveBeenCalled();
  expect(await readFile(path.join(staging, 'preserved.txt'), 'utf8')).toBe('校验之前不能删除');
});
