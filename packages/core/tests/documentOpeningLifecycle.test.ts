import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DocumentState, WorkspaceDefinition } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture } from './fixtures';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('文件打开与工作区生命周期的真实读盘竞态', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let app: PlatformApplication;
  let workspace: WorkspaceDefinition;
  const file = 'folder/a.txt';
  const client = 'opening-client';

  beforeEach(async () => {
    f = await fixture();
    await f.store.close();
    app = await PlatformApplication.open({ dataDirectory: f.data });
    workspace = { id: 'opening-project', name: '文档竞态', directory: f.source, deviceId: 'local' };
    const settings = app.settings.snapshot();
    settings.settings.workspaces.push(workspace);
    await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    await fs.mkdir(path.join(f.source, 'folder'));
    await fs.writeFile(path.join(f.source, file), '读取开始时的正文');
    await fs.writeFile(path.join(f.source, 'b.txt'), '另一个文件');
  });
  afterEach(async () => { jest.restoreAllMocks(); await app.close(); await f.cleanup(); });

  async function holdRead() {
    const target = await fs.realpath(path.join(f.source, file));
    const entered = gate(), waiting = gate();
    const nativeOpen = fs.open;
    let held = false;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await nativeOpen(...args);
      if (args[0] === target && !held) {
        held = true;
        const close = handle.close.bind(handle);
        jest.spyOn(handle, 'close').mockImplementationOnce(async () => {
          // Windows 的目录移动和原子替换需要读句柄先关闭；延迟的是读盘结果的返回。
          await close();
          entered.release();
          await waiting.promise;
        });
      }
      return handle;
    });
    return { entered: entered.promise, release: waiting.release };
  }

  test.each(['move', 'move-directory', 'remove', 'partial-remove', 'client-close', 'document-close', 'rebind', 'write', 'git-refresh', 'refresh-close'])
  ('慢读取期间发生 %s 后不登记旧文档', async action => {
    const reload = action === 'refresh-close';
    if (reload) {
      await app.files.openDocument(workspace, file, client);
      await fs.writeFile(path.join(f.source, file), '供刷新读取的新正文');
    }
    const held = await holdRead();
    const opening = app.files.openDocument(workspace, file, client, reload);
    try {
      await held.entered;
      if (action === 'move' || action === 'move-directory') {
        const source = action === 'move' ? file : 'folder';
        const target = action === 'move' ? 'folder/moved.txt' : 'moved-folder';
        const entry = await app.fileActions.inspect('owner', workspace.id, source);
        await app.fileActions.move('owner', workspace.id, source, target, entry.version);
      } else if (action === 'partial-remove') {
        await fs.writeFile(path.join(f.source, 'folder/remaining.txt'), '尚未删除的文件');
        const entry = await app.fileActions.inspect('owner', workspace.id, 'folder');
        jest.spyOn(fs, 'rm').mockImplementationOnce(async () => {
          await fs.unlink(path.join(f.source, file));
          throw Object.assign(new Error('fixture partial remove'), { code: 'EACCES' });
        });
        await expect(app.fileActions.remove('owner', workspace.id, 'folder', entry.version, true)).rejects.toThrow('删除未完成');
        expect(await fs.readFile(path.join(f.source, 'folder/remaining.txt'), 'utf8')).toBe('尚未删除的文件');
      } else if (action === 'remove') {
        const entry = await app.fileActions.inspect('owner', workspace.id, file);
        await app.fileActions.remove('owner', workspace.id, file, entry.version);
      } else if (action === 'client-close') {
        await app.files.clientClosed(client);
        app.files.clientConnected(client);
      } else if (action === 'document-close' || action === 'refresh-close') {
        await app.files.closeDocument(workspace, file, client);
      } else if (action === 'rebind') {
        const replacement = path.join(f.root, 'replacement');
        await fs.mkdir(replacement);
        const draft = await app.product.draft();
        draft.app.workspaces.find(item => item.id === workspace.id)!.directory = replacement;
        await app.product.save(draft);
      } else if (action === 'write') {
        const before = await app.files.read(workspace, file);
        await app.files.write(workspace, file, '事务写入的新正文', before.hash);
      } else {
        await fs.writeFile(path.join(f.source, file), '外部操作的新正文');
        await app.files.reloadCleanDocuments(workspace.directory);
      }
      held.release();
      if (action === 'git-refresh') {
        expect(await opening).toMatchObject({ path: file, text: '外部操作的新正文', dirty: false });
      } else {
        await expect(opening).rejects.toThrow('DOCUMENT_CONFLICT');
        expect(app.files.clientDocuments(client, workspace.id)).toEqual([]);
      }
    } finally { held.release(); await opening.catch(() => undefined); }
  });

  test.each<{ path: string; kind: 'file' | 'directory' }>([
    { path: 'created-directory', kind: 'directory' },
    { path: 'created-directory/child', kind: 'directory' },
    { path: 'created-directory/child.txt', kind: 'file' },
  ])('尚未返回的不存在路径在创建 $path 后不能成为编辑文档', async ({ path: createdPath, kind }) => {
    const entered = gate(), waiting = gate();
    const target = path.join(await fs.realpath(f.source), 'created-directory');
    const nativeOpen = fs.open;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      try { return await nativeOpen(...args); }
      catch (error) {
        if (args[0] === target) { entered.release(); await waiting.promise; }
        throw error;
      }
    });
    const opening = app.files.openDocument(workspace, 'created-directory', client);
    try {
      await entered.promise;
      await app.fileActions.create('owner', workspace.id, createdPath, kind);
      expect((await fs.stat(target)).isDirectory()).toBe(true);
      waiting.release();
      await expect(opening).rejects.toThrow('DOCUMENT_CONFLICT');
      expect(app.files.clientDocuments(client, workspace.id)).toEqual([]);
    } finally { waiting.release(); await opening.catch(() => undefined); }
  });

  test('Git状态只发现其他文件变化时，仍正常登记正在打开的文件', async () => {
    await promisify(execFile)('git', ['init', '--initial-branch=main', f.source], { windowsHide: true });
    const held = await holdRead();
    const opening = app.files.openDocument(workspace, file, client);
    try {
      await held.entered;
      const before = await app.files.read(workspace, 'b.txt');
      await app.files.write(workspace, 'b.txt', '其他文件的新内容', before.hash);
      expect((await app.git.status(workspace)).repository).toBe(true);
      held.release();
      expect(await opening).toMatchObject({ path: file, text: '读取开始时的正文', dirty: false });
    } finally { held.release(); await opening.catch(() => undefined); }
  });

  test('两个刷新交错完成时，较早的读取不能覆盖较新的待打开正文', async () => {
    const target = await fs.realpath(path.join(f.source, file));
    const firstRead = gate(), firstRefresh = gate(), releaseRead = gate(), releaseRefresh = gate();
    const nativeOpen = fs.open;
    let reads = 0;
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await nativeOpen(...args);
      if (args[0] === target && reads < 2) {
        const index = reads++;
        const close = handle.close.bind(handle);
        jest.spyOn(handle, 'close').mockImplementationOnce(async () => {
          await close();
          (index ? firstRefresh : firstRead).release();
          await (index ? releaseRefresh : releaseRead).promise;
        });
      }
      return handle;
    });
    const opening = app.files.openDocument(workspace, file, client);
    let earlier: Promise<void> | undefined;
    try {
      await firstRead.promise;
      await fs.writeFile(target, '第一次刷新读到的正文');
      earlier = app.files.reloadCleanDocuments(workspace.directory);
      await Promise.race([firstRefresh.promise, earlier.then(() => { throw new Error('刷新没有读取在途文档'); })]);
      await fs.writeFile(target, '第二次刷新读到的正文');
      await app.files.reloadCleanDocuments(workspace.directory);
      releaseRefresh.release();
      await earlier;
      releaseRead.release();
      expect(await opening).toMatchObject({ text: '第二次刷新读到的正文', dirty: false });
    } finally {
      releaseRead.release();
      releaseRefresh.release();
      await Promise.allSettled([opening, ...(earlier ? [earlier] : [])]);
    }
  });

  test('尚在路径队列的另一客户端以稍后实际读到的正文为准', async () => {
    const held = await holdRead();
    const first = app.files.openDocument(workspace, file, client);
    let second: Promise<DocumentState> | undefined;
    try {
      await held.entered;
      const resolved = gate();
      const resolve = app.files.resolve.bind(app.files);
      jest.spyOn(app.files, 'resolve').mockImplementationOnce(async (...args) => {
        const absolute = await resolve(...args);
        resolved.release();
        return absolute;
      });
      second = app.files.openDocument(workspace, file, 'second-client');
      await resolved.promise;
      await Promise.resolve();
      await fs.writeFile(path.join(f.source, file), '排队期间的刷新正文');
      await app.files.reloadCleanDocuments(workspace.directory);
      await fs.writeFile(path.join(f.source, file), '真正开始读取时的最新正文');
      held.release();
      expect(await second).toMatchObject({ clientId: 'second-client', text: '真正开始读取时的最新正文' });
    } finally {
      held.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });

  test('真实路径解析尚未返回时，别名目标移动也会使旧打开失效', async () => {
    await fs.symlink(path.join(f.source, 'folder'), path.join(f.source, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const entered = gate(), waiting = gate();
    const resolve = app.files.resolve.bind(app.files);
    jest.spyOn(app.files, 'resolve').mockImplementationOnce(async (...args) => {
      const absolute = await resolve(...args);
      entered.release();
      await waiting.promise;
      return absolute;
    });
    const opening = app.files.openDocument(workspace, 'alias/a.txt', client);
    try {
      await entered.promise;
      const entry = await app.fileActions.inspect('owner', workspace.id, file);
      await app.fileActions.move('owner', workspace.id, file, 'folder/moved.txt', entry.version);
      waiting.release();
      await expect(opening).rejects.toThrow('DOCUMENT_CONFLICT');
      expect(app.files.clientDocuments(client, workspace.id)).toEqual([]);
    } finally { waiting.release(); await opening.catch(() => undefined); }
  });

  test('慢读取不阻塞另一个文件的打开和写入，也不受其无关变更影响', async () => {
    const held = await holdRead();
    const opening = app.files.openDocument(workspace, file, client);
    let other: Promise<DocumentState> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await held.entered;
      other = (async () => {
        const document = await app.files.openDocument(workspace, 'b.txt', client);
        await app.files.write(workspace, 'b.txt', '另一个文件的新正文', document.baseHash);
        return document;
      })();
      const completed = await Promise.race([other, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('慢读取阻塞了其他文件')), 1500);
      })]);
      expect(completed.path).toBe('b.txt');
      held.release();
      expect(await opening).toMatchObject({ path: file, text: '读取开始时的正文', dirty: false });
    } finally {
      clearTimeout(timer);
      held.release();
      await Promise.allSettled([opening, ...(other ? [other] : [])]);
    }
  });
});
