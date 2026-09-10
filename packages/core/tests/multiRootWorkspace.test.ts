import path from 'node:path';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { DocumentState, FileEntryInfo, ModelInput, PlatformMessage, RunRecord } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { FileReadAccess } from '../../../apps/server/src/workspace/readAccess';
import { NodeFileHost } from '../../../apps/server/src/workspace/fileHost';
import { PlatformPromptService } from '../../../apps/server/src/prompt/service';
import { fixture, metadata, message } from './fixtures';

describe('多根工作区的文件、任务与旧检查点', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let app: PlatformApplication; let router: ApplicationRouter;
  let alpha: string; let beta: string;
  let generate: (input: ModelInput) => Promise<PlatformMessage>;
  const owner = { actorId: 'owner', clientId: 'multi-root-editor' };
  const workspace = () => app.workspace('owner', 'multi', ['workspace_read', 'workspace_write']);
  const rpc = <T>(method: string, params: Record<string, unknown> = {}) => router.call(owner, method, { workspaceId: 'multi', ...params }) as Promise<T>;
  beforeEach(async () => {
    f = await fixture(); await f.store.close();
    alpha = path.join(f.root, 'alpha'); beta = path.join(f.root, 'beta');
    await Promise.all([mkdir(alpha), mkdir(beta)]);
    await Promise.all([writeFile(path.join(alpha, 'same.txt'), 'alpha'), writeFile(path.join(beta, 'same.txt'), 'beta')]);
    generate = async () => ({ role: 'model', parts: [{ text: 'done' }] });
    app = await PlatformApplication.open({ dataDirectory: f.data, models: { generate: input => generate(input) } });
    const draft = app.settings.snapshot();
    draft.settings.agents[0].toolNames = ['workspace_files'];
    draft.settings.workspaces.push({ id: 'multi', name: '共同项目', directory: alpha, deviceId: 'local', roots: [{ name: 'alpha', directory: alpha }, { name: 'beta', directory: beta }] });
    draft.settings.accounts.push({ id: 'reader', role: 'member', displayName: '读取账号', effects: ['workspace_read'], workspaceIds: ['multi'] });
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision }); router = new ApplicationRouter(app);
  });
  afterEach(async () => { await app.close(); await f.cleanup(); });

  test('同名文件按目录区分，文件宿主、界面移动与草稿保护共用实际路径', async () => {
    expect((await rpc<Array<{ path: string }>>('files.list')).map(entry => entry.path)).toEqual(['@alpha', '@beta']);
    const context = { actorId: 'reader', runId: 'read', workspace: workspace(), signal: new AbortController().signal,
      requestApproval: jest.fn(async () => true), progress: () => {}, askUser: async () => { throw new Error('unused'); } } as ToolContext;
    const access = new FileReadAccess(app, context); const host = new NodeFileHost(app, context, access);
    expect(await readFile(await access.resolve('@BETA/same.txt'), 'utf8')).toBe('beta');
    expect(host.getAllWorkspaces().map(root => root.name)).toEqual(['alpha', 'beta']);
    expect(host.resolveUriWithInfo('beta/same.txt').uri?.fsPath).toBe(path.join(beta, 'same.txt'));
    expect(host.toRelativePath({ fsPath: path.join(beta, 'same.txt'), scheme: 'file' })).toBe('@beta/same.txt');
    await expect(access.resolve('same.txt')).rejects.toThrow('workspace prefix');
    await symlink(f.source, path.join(beta, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(access.resolve('@beta/outside/conversations')).rejects.toThrow('工作区外');
    expect(context.requestApproval).not.toHaveBeenCalled();
    let doc = await rpc<DocumentState>('documents.open', { path: 'beta/same.txt' });
    expect(doc.path).toBe('@beta/same.txt');
    doc = await rpc<DocumentState>('documents.update', { path: doc.path, version: doc.version, text: 'beta draft' });
    const entry = await rpc<FileEntryInfo>('files.inspect', { path: doc.path });
    await expect(rpc('files.move', { path: doc.path, target: '@alpha/moved.txt', expectedVersion: entry.version })).rejects.toThrow('DOCUMENT_DIRTY');
    doc = await rpc<DocumentState>('documents.save', { path: doc.path, version: doc.version });
    await rpc('files.move', { path: doc.path, target: '@alpha/moved.txt', expectedVersion: (await rpc<FileEntryInfo>('files.inspect', { path: doc.path })).version });
    expect(app.files.clientDocuments(owner.clientId, 'multi')[0]).toMatchObject({ path: '@alpha/moved.txt', text: 'beta draft', dirty: false });
    expect(await readFile(path.join(alpha, 'same.txt'), 'utf8')).toBe('alpha');
    const root = await rpc<FileEntryInfo>('files.inspect', { path: '@beta' });
    await expect(rpc('files.remove', { path: root.path, recursive: true, expectedVersion: root.version })).rejects.toThrow('根目录');
    const bytes = Buffer.from([0, 1, 255, 13, 10]);
    await app.fileActions.upload('owner', 'multi', '@beta/原字节.bin', 'missing', bytes);
    expect(await readFile((await app.fileActions.download('owner', 'multi', '@beta/原字节.bin')).absolute)).toEqual(bytes);
  });

  test('交换目录名称保留草稿并拒绝迟到输入，运行中的任务和检查点保持原目录', async () => {
    let first = await rpc<DocumentState>('documents.open', { path: '@alpha/same.txt' });
    await rpc<DocumentState>('documents.open', { path: '@beta/same.txt' });
    first = await rpc<DocumentState>('documents.update', { path: first.path, version: first.version, text: 'alpha draft' });
    const previousVersion = first.version;
    let started!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    generate = async () => {
      if (++calls > 1) return { role: 'model', parts: [{ text: 'written once' }] };
      started(); await gate;
      return { role: 'model', parts: [{ functionCall: { id: 'write-captured', name: 'workspace_files', args: {
        action: 'write', path: '@beta/old-task.txt', content: 'captured beta', expectedHash: null, oldText: null, newText: null,
      } } }] };
    };
    const settings = await app.product.draft();
    await settings.settings.updateCheckpointConfig({ enabled: true, beforeTools: ['write_file'], afterTools: ['write_file'] });
    await app.product.save(settings);
    const conversation = await rpc<{ id: string }>('conversations.create', { title: 'captured' });
    const run = await rpc<RunRecord>('runs.start', { conversationId: conversation.id, requestKey: 'captured', agentId: 'default', text: 'write' });
    await entered;
    try {
      let draft = app.settings.snapshot();
      draft.settings.workspaces[0].roots = [{ name: 'beta', directory: alpha }, { name: 'alpha', directory: beta }];
      await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
      const renamed = app.files.clientDocuments(owner.clientId, 'multi').find(doc => doc.text === 'alpha draft')!;
      expect(renamed).toMatchObject({ path: '@beta/same.txt', dirty: true }); expect(renamed.version).toBeGreaterThan(previousVersion);
      await expect(rpc('documents.update', { path: '@alpha/same.txt', version: previousVersion, text: 'late input' })).rejects.toThrow('DOCUMENT_CONFLICT');
      await rpc('documents.save', { path: renamed.path, version: renamed.version });
      const replacement = path.join(f.root, 'replacement'); await mkdir(replacement);
      draft = app.settings.snapshot(); draft.settings.workspaces[0].roots![1].directory = replacement;
      await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    } finally { release(); }
    expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    expect(await readFile(path.join(beta, 'old-task.txt'), 'utf8')).toBe('captured beta');
    expect(await readFile(path.join(alpha, 'same.txt'), 'utf8')).toBe('alpha draft');
    await expect(readFile(path.join(alpha, 'old-task.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const checkpoints = (await app.checkpoints.list('owner', conversation.id)).filter(checkpoint => checkpoint.runId === run.id);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.every(checkpoint => checkpoint.manifest.roots.some(root => root.name === 'beta' && root.uri.toLowerCase() === pathToFileURL(beta).toString().toLowerCase()))).toBe(true);
    expect(calls).toBe(2);
  });

  test('固定文件和记忆按实际目录归属，目录改名后仍可读取与注入上下文', async () => {
    const conversation = await app.createConversation('owner', 'persistent references', 'multi');
    const ui = <T>(type: string, data: Record<string, unknown> = {}) => rpc<T>('ui.request', { type, data: { conversationId: conversation.id, ...data } });
    await writeFile(path.join(beta, 'same.txt'), 'PINNED_SECOND_ROOT_CONTENT');
    const validated = await ui<{ valid: boolean; relativePath: string; workspaceUri: string }>('validatePinnedFile', { path: '@beta/same.txt' });
    expect(validated.valid).toBe(true); expect(validated.relativePath).toBe('same.txt');
    await ui('addPinnedFile', { path: validated.relativePath, workspaceUri: validated.workspaceUri });
    await ui('addMemoryEntry', { workspaceUri: validated.workspaceUri, text: 'SECOND_ROOT_MEMORY' });
    const draft = app.settings.snapshot(); draft.settings.workspaces[0].roots![1].name = 'assets';
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    expect(await ui('getPinnedFilesConfig')).toMatchObject({ files: [{ path: '@assets/same.txt', workspaceUri: validated.workspaceUri }] });
    expect(await ui('getMemoryEntries', { workspaceUri: validated.workspaceUri })).toMatchObject({ total: 1 });
    expect(await ui('getMemoryEntries', { workspaceUri: pathToFileURL(alpha).toString() })).toMatchObject({ total: 0 });
    expect(await ui('listMemoryScopes')).toMatchObject({ scopes: expect.arrayContaining([expect.objectContaining({ name: 'assets', fsPath: beta })]) });
    const saved = await app.storage.getConversation(conversation.id);
    const prompt = await new PlatformPromptService(app).prepare({ request: { actorId: 'owner', conversationId: conversation.id, agentId: 'default', requestKey: 'preview', message: message(0) },
      actor: app.actor('owner')!, agent: { ...app.settings.snapshot().settings.agents[0], toolNames: [] }, workspace: workspace(), conversation: saved!, history: [], preview: true });
    const dynamic = 'previewDynamicText' in prompt ? prompt.previewDynamicText : undefined;
    expect(dynamic).toContain('PINNED_SECOND_ROOT_CONTENT');
    expect(dynamic).toContain('@assets/same.txt');
  });

  test('多目录局部检查点恢复限定文件和缺失状态，保留其他文件', async () => {
    await app.storage.createConversation({ ...metadata('partial'), actorId: 'owner', workspaceId: 'multi' });
    const checkpoint = await app.checkpoints.create('owner', 'partial', { affectedPaths: ['@alpha/missing.txt', '@beta/same.txt'] });
    await Promise.all([writeFile(path.join(alpha, 'missing.txt'), 'delete on restore'), writeFile(path.join(beta, 'same.txt'), 'changed'), writeFile(path.join(alpha, 'keep.txt'), 'keep')]);
    expect((await app.checkpoints.restore('owner', 'partial', checkpoint.id)).success).toBe(true);
    expect(await readFile(path.join(beta, 'same.txt'), 'utf8')).toBe('beta');
    expect(await readFile(path.join(alpha, 'keep.txt'), 'utf8')).toBe('keep');
    await expect(readFile(path.join(alpha, 'missing.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('嵌套目录只采集一次，旧重复记录在内容一致时可以恢复', async () => {
    const nested = path.join(alpha, 'nested'); await mkdir(nested); await writeFile(path.join(nested, 'nested.txt'), 'nested original');
    const draft = app.settings.snapshot(); draft.settings.workspaces[0].roots!.push({ name: 'nested', directory: nested });
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    await app.storage.createConversation({ ...metadata('nested'), actorId: 'owner', workspaceId: 'multi' });
    const checkpoint = await app.checkpoints.create('owner', 'nested');
    const keys = Object.keys(checkpoint.manifest.files).filter(file => file.endsWith('/nested.txt'));
    expect(keys).toHaveLength(1);
    const parent = checkpoint.manifest.roots.find(root => root.name === 'alpha')!;
    const duplicate = parent.id + '/nested/nested.txt';
    checkpoint.manifest.excluded = checkpoint.manifest.excluded.filter(entry => !entry.path.startsWith(parent.id + '/nested'));
    checkpoint.manifest.files[duplicate] = { ...checkpoint.manifest.files[keys[0]] }; checkpoint.contentIds[duplicate] = checkpoint.contentIds[keys[0]];
    await app.storage.commitRecords([{ namespace: 'workspace-checkpoints', id: checkpoint.id, ownerId: 'nested', value: checkpoint }]);
    await writeFile(path.join(nested, 'nested.txt'), 'changed');
    expect((await app.checkpoints.restore('owner', 'nested', checkpoint.id)).success).toBe(true);
    expect(await readFile(path.join(nested, 'nested.txt'), 'utf8')).toBe('nested original');
  });

  test('旧多目录检查点经导入和逐根对应后恢复原字节，不扫描后来添加的目录', async () => {
    await app.storage.createConversation({ ...metadata('source'), actorId: 'owner', workspaceId: 'multi' });
    const original = await app.checkpoints.create('owner', 'source');
    const legacyId = 'legacy-multi'; const backup = path.join(f.source, 'checkpoints', 'legacy_cp');
    for (const [file, contentId] of Object.entries(original.contentIds)) {
      const target = path.join(backup, file); await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await app.storage.getRecord('workspace-checkpoint-content', contentId) as Uint8Array);
    }
    const hashes = Object.fromEntries(Object.entries(original.manifest.files).map(([file, value]) => [file, value.hash]));
    const legacy = { id: 'legacy_cp', conversationId: legacyId, messageIndex: 0, backupDir: 'legacy_cp', timestamp: 1000,
      toolName: 'write_file', phase: 'after', type: 'full', workspaceRoots: original.manifest.roots, fileHashes: hashes, fileCount: 2 };
    await writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ version: 1, checkpointId: 'legacy_cp', workspaceRoots: original.manifest.roots,
      files: original.manifest.files, emptyDirs: [], changes: [], excluded: [] }));
    await writeFile(path.join(f.source, 'conversations', legacyId + '.meta.json'), JSON.stringify({ ...metadata(legacyId), custom: { checkpoints: [legacy] } }));
    await writeFile(path.join(f.source, 'conversations', legacyId + '.json'), JSON.stringify([message(0)]));
    const imported = await app.migration.importDirectory('owner', f.source);
    expect(imported.issues).toEqual([]); expect(imported.imported).toContain(legacyId);
    const checkpoint = (await app.checkpoints.list('owner', legacyId))[0];
    const gamma = path.join(f.root, 'gamma'); const delta = path.join(f.root, 'delta'); await Promise.all([mkdir(gamma), mkdir(delta)]);
    const current = await rpc<{ id: string }>('workspaces.add', { name: '新位置', directory: gamma, roots: [{ name: 'gamma', directory: gamma }, { name: 'delta', directory: delta }] });
    const sources = (await app.migration.workspaceRoots('owner', legacyId)).roots;
    await expect(app.migration.bindWorkspace('owner', legacyId, current.id)).rejects.toThrow('对应目录');
    await expect(app.migration.bindWorkspace('owner', legacyId, current.id, Object.fromEntries(sources.map(root => [root.id, gamma])))).rejects.toThrow('不能合并');
    await app.migration.bindWorkspace('owner', legacyId, current.id, Object.fromEntries(sources.map(root => [root.id, root.name === 'alpha' ? delta : gamma])));
    const extra = path.join(f.root, 'extra'); await mkdir(extra); await writeFile(path.join(extra, 'private.txt'), 'do not scan');
    const draft = app.settings.snapshot(); draft.settings.workspaces.find(item => item.id === current.id)!.roots!.push({ name: 'extra', directory: extra });
    await app.settings.save({ settings: draft.settings, expectedRevision: draft.revision });
    const preview = await app.checkpoints.preview('owner', legacyId, checkpoint.id);
    expect(preview.untrackedPaths.some(file => file.includes('extra'))).toBe(false);
    expect((await app.checkpoints.restore('owner', legacyId, checkpoint.id, { previewId: preview.previewId, deleteUntrackedFiles: true })).success).toBe(true);
    expect(await readFile(path.join(delta, 'same.txt'), 'utf8')).toBe('alpha'); expect(await readFile(path.join(gamma, 'same.txt'), 'utf8')).toBe('beta');
    expect(await readFile(path.join(extra, 'private.txt'), 'utf8')).toBe('do not scan');
    expect(await readFile(path.join(alpha, 'same.txt'), 'utf8')).toBe('alpha'); expect(await readFile(path.join(beta, 'same.txt'), 'utf8')).toBe('beta');
  });
});
