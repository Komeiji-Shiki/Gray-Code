import path from 'node:path';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { ActorIdentity, WorkspaceDefinition } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { FileReadAccess } from '../../../apps/server/src/workspace/readAccess';
import { NodeFileHost } from '../../../apps/server/src/workspace/fileHost';

let root: string, actual: string, linked: string, outside: string;
beforeEach(async () => {
  const temporary = path.resolve('.tmp'); await mkdir(temporary, { recursive: true });
  root = await mkdtemp(path.join(temporary, 'read-access-'));
  actual = path.join(root, 'actual'); linked = path.join(root, 'linked'); outside = path.join(root, 'outside');
  await Promise.all([mkdir(actual), mkdir(outside)]);
  await Promise.all([writeFile(path.join(actual, 'inside.txt'), '工作区正文'), writeFile(path.join(outside, 'secret.txt'), '外部正文')]);
  await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(outside, path.join(actual, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
});
afterEach(async () => {
  if (path.dirname(root) !== path.resolve('.tmp') || !path.basename(root).startsWith('read-access-')) throw new Error('Unsafe fixture cleanup path.');
  await rm(root, { recursive: true, force: true });
});

test.each(['owner', 'member'] as const)('通过目录联接登记的工作区允许 %s 读取，实际越界仍拒绝', async role => {
  const actor: ActorIdentity = { id: role, displayName: role, role, effects: ['workspace_read'], workspaceIds: ['project'] };
  const workspace: WorkspaceDefinition = { id: 'project', name: '工程', directory: linked, deviceId: 'local' };
  const app = { actor: () => actor,
    product: { runtimeSettings: () => ({ getReadFileConfig: () => ({ outsideWorkspaceAccess: 'deny' }) }) },
  } as unknown as PlatformApplication;
  const context: ToolContext = { runId: 'read', actorId: role, actor, workspace, signal: new AbortController().signal,
    requestApproval: jest.fn(async () => true), progress() {}, askUser: async () => { throw new Error('unused'); } };
  const access = new FileReadAccess(app, context), host = new NodeFileHost(app, context, access);
  const canonical = await realpath(path.join(actual, 'inside.txt'));
  expect(await access.resolve('inside.txt')).toBe(canonical);
  expect(await access.resolve(canonical)).toBe(canonical);
  expect(await access.resolve(pathToFileURL(path.join(linked, 'inside.txt')).href)).toBe(canonical);
  expect(Buffer.from(await host.readFile(host.resolveUriWithInfo('inside.txt').uri!)).toString()).toBe('工作区正文');
  // 根目录的逻辑别名与真实路径都有效，但其中指向外部的链接不能沿用根目录授权。
  await expect(access.resolve('escape/secret.txt')).rejects.toThrow('工作区外');
  await expect(access.resolve(path.join(outside, 'missing.txt'))).rejects.toThrow('工作区外');
  expect(context.requestApproval).not.toHaveBeenCalled();
  workspace.roots = [{ name: 'linked', directory: linked }, { name: 'other', directory: outside }];
  const multi = new FileReadAccess(app, context);
  expect(await readFile(await multi.resolve('@linked/inside.txt'), 'utf8')).toBe('工作区正文');
});
