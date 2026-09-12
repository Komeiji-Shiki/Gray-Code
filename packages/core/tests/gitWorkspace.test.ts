import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

const execute = promisify(execFile);
async function setup() {
  const f = await fixture(); await f.store.close();
  const project = path.join(f.root, '仓库'); await mkdir(project);
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  // 隔离样例位于仓库忽略目录中，禁止 Git 继续发现真实开发仓库。
  process.env.GIT_CEILING_DIRECTORIES = f.root;
  const git = async (...args: string[]) => (await execute('git', args, { cwd: project, windowsHide: true })).stdout;
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const router = new ApplicationRouter(app), client = { actorId: 'owner', clientId: 'git-editor' };
  const rpc = (method: string, params: Record<string, unknown> = {}, session = client) => router.call(session, method, { workspaceId: 'project', ...params }) as Promise<any>;
  const settings = app.settings.snapshot(); settings.settings.workspaces.push({ id: 'project', name: 'Git 工程', directory: project, deviceId: 'local' });
  await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
  const initialize = async () => {
    await rpc('git.init', { branch: 'main' });
    await git('config', 'user.name', 'GrayCode Fixture'); await git('config', 'user.email', 'fixture@invalid.example');
    await git('config', 'core.autocrlf', 'false');
  };
  const close = async () => { try { await app.close(); await f.cleanup(); }
    finally { if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling; } };
  return { f, project, git, app, router, client, rpc, initialize, close };
}

test('Git 初始暂存可撤销，MM 文件分别查看两份差异，提交只使用暂存区', async () => {
  const t = await setup();
  try {
    expect((await t.rpc('git.status')).repository).toBe(false); await t.initialize();
    const file = path.join(t.project, '中文.ts'); await writeFile(file, 'export const value = 1;\n');
    expect(await t.rpc('git.diff', { path: '中文.ts' })).toContain('+export const value = 1;');
    await t.rpc('git.stage', { path: '中文.ts', staged: true });
    await writeFile(file, 'export const value = 2;\n');
    await t.rpc('git.stage', { path: '中文.ts', staged: false });
    expect(await readFile(file, 'utf8')).toContain('= 2');
    expect((await t.rpc('git.status')).entries[0].index).toBe('?');
    await t.rpc('git.stage', { path: '中文.ts', staged: true }); await t.rpc('git.commit', { message: '创建初始文件' });
    await writeFile(file, 'export const value = 3;\n'); await t.rpc('git.stage', { path: '中文.ts', staged: true });
    await writeFile(file, 'export const value = 4;\n');
    expect((await t.rpc('git.status')).entries[0]).toMatchObject({ index: 'M', worktree: 'M' });
    expect(await t.rpc('git.diff', { path: '中文.ts', staged: true })).toContain('+export const value = 3;');
    expect(await t.rpc('git.diff', { path: '中文.ts', staged: false })).toContain('+export const value = 4;');
    await t.rpc('git.commit', { message: '只提交已暂存版本' });
    expect(await t.git('show', 'HEAD:中文.ts')).toContain('= 3'); expect(await readFile(file, 'utf8')).toContain('= 4');
    await t.git('mv', '中文.ts', '改名.ts');
    await t.rpc('git.stage', { path: '改名.ts', staged: false });
    expect(await t.git('diff', '--cached', '--name-only')).toBe('');
  } finally { await t.close(); }
});

test('切换分支保护其他窗口草稿并刷新干净文档，子目录不能操作父仓库', async () => {
  const t = await setup();
  try {
    await t.initialize(); await writeFile(path.join(t.project, 'main.ts'), 'export const value = 1;\n');
    await t.git('add', '.'); await t.git('commit', '-m', '初始');
    await t.rpc('git.switch', { branch: 'feature/change', create: true });
    await writeFile(path.join(t.project, 'main.ts'), 'export const value = 2;\n');
    await writeFile(path.join(t.project, 'new.ts'), 'export const added = true;\n');
    await t.git('add', '.'); await t.git('commit', '-m', '另一分支'); await t.rpc('git.switch', { branch: 'main' });
    await t.rpc('documents.open', { path: 'main.ts' });
    const phone = { ...t.client, clientId: 'phone' }; let document = await t.rpc('documents.open', { path: 'main.ts' }, phone);
    document = await t.rpc('documents.update', { path: 'main.ts', version: document.version, text: '尚未保存的输入' }, phone);
    await expect(t.rpc('git.switch', { branch: 'feature/change' })).rejects.toThrow('未保存');
    expect((await t.rpc('git.status')).branch).toBe('main');
    await t.rpc('documents.close', { path: 'main.ts', discard: true }, phone);
    const events: any[] = []; const stop = t.app.subscribe(event => { if (event.type === 'document.reset' || event.type === 'workspace.git.changed') events.push(event); });
    await t.rpc('git.switch', { branch: 'feature/change' });
    expect((await t.rpc('documents.open', { path: 'main.ts' })).text).toContain('= 2');
    expect(events.some(event => event.type === 'document.reset')).toBe(true); expect(events.some(event => event.type === 'workspace.git.changed')).toBe(true); stop();
    const nested = path.join(t.project, 'nested'); await mkdir(nested);
    const workspace = await t.rpc('workspaces.add', { directory: nested, name: '子目录' });
    await expect(t.rpc('git.status', { workspaceId: workspace.id })).rejects.toThrow('仓库根目录');
    await expect(t.rpc('git.stage', { workspaceId: workspace.id, path: '../main.ts', staged: true })).rejects.toThrow('仓库根目录');
  } finally { await t.close(); }
});

test('工作树创建与打开使用真实目录，移除保护项目绑定、未保存内容和忽略文件', async () => {
  const t = await setup();
  try {
    await t.initialize(); await writeFile(path.join(t.project, 'main.ts'), 'export const value = 1;\n');
    await writeFile(path.join(t.project, '.gitignore'), '.env\n'); await t.git('add', '.'); await t.git('commit', '-m', '初始');
    const target = path.join(t.f.root, '独立工作树');
    const created = await t.rpc('git.worktree.create', { input: { path: target, branch: 'feature/worktree', createBranch: true } });
    expect(created).toMatchObject({ directory: target.replaceAll('\\', '/'), branch: 'feature/worktree', main: false });
    expect(await readFile(path.join(target, 'main.ts'), 'utf8')).toContain('= 1');
    const registered = await t.rpc('workspaces.add', { directory: target, name: '工作树项目' });
    expect((await t.rpc('git.status', { workspaceId: registered.id })).branch).toBe('feature/worktree');
    await expect(t.rpc('git.worktree.remove', { path: target })).rejects.toThrow('仍用作项目目录');
    const draft = await t.rpc('documents.open', { workspaceId: registered.id, path: 'main.ts' });
    await t.rpc('documents.update', { workspaceId: registered.id, path: 'main.ts', version: draft.version, text: '草稿' });
    const settings = t.app.settings.snapshot(); settings.settings.workspaces = settings.settings.workspaces.filter(item => item.id !== registered.id);
    await t.app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
    await expect(t.rpc('git.worktree.remove', { path: target })).rejects.toThrow('未保存');
    const remaining = t.app.files.clientDocuments(t.client.clientId, registered.id)[0];
    await t.rpc('documents.close', { workspaceId: registered.id, path: remaining.path, discard: true });
    await writeFile(path.join(target, '.env'), 'fixture-only');
    await expect(t.rpc('git.worktree.remove', { path: target })).rejects.toThrow('忽略');
    expect(await readFile(path.join(target, '.env'), 'utf8')).toBe('fixture-only'); await unlink(path.join(target, '.env'));
    await t.rpc('git.worktree.remove', { path: target }); await expect(access(target)).rejects.toThrow();
    expect((await t.rpc('git.status')).worktrees).toHaveLength(1);
    expect((await t.rpc('git.status')).branches.some((branch: any) => branch.name === 'feature/worktree')).toBe(true);
  } finally { await t.close(); }
});

test('真实合并冲突可识别，解决并暂存后才允许提交', async () => {
  const t = await setup();
  try {
    await t.initialize(); const file = path.join(t.project, 'main.txt'); await writeFile(file, 'original\n');
    await t.git('add', '.'); await t.git('commit', '-m', '初始');
    await t.rpc('documents.open', { path: 'main.txt' });
    await t.rpc('git.switch', { branch: 'feature/conflict', create: true }); await writeFile(file, 'feature\n'); await t.git('commit', '-am', '分支');
    await t.rpc('git.switch', { branch: 'main' }); await writeFile(file, 'main\n'); await t.git('commit', '-am', '主分支');
    await expect(t.git('merge', 'feature/conflict')).rejects.toThrow();
    expect((await t.rpc('git.status')).entries).toEqual([expect.objectContaining({ path: 'main.txt', conflict: true })]);
    expect((await t.rpc('documents.open', { path: 'main.txt' })).text).toContain('<<<<<<<');
    await expect(t.rpc('git.commit', { message: '尚未解决' })).rejects.toThrow('解决冲突');
    await writeFile(file, 'resolved\n'); await t.rpc('git.stage', { path: 'main.txt', staged: true }); await t.rpc('git.commit', { message: '解决冲突' });
    expect((await t.git('rev-list', '--parents', '-n', '1', 'HEAD')).trim().split(' ')).toHaveLength(3);
  } finally { await t.close(); }
});
