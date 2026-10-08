import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunRecord } from '@graycode/contracts';
import type { ToolContext } from '@graycode/core';
import { PlatformApplication } from '../../../apps/server/src/application';
import { buildInitialReviewDocument } from '../../../backend/tools/review/reviewDocumentSection';
import { buildProgressDocument } from '../../../backend/tools/progress/documentLayout';
import { fixture } from './fixtures';

let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, context: ToolContext, run: RunRecord;
const designPath = '.graycode/design/example.md';
beforeEach(async () => {
  f = await fixture(); await f.store.close(); app = await PlatformApplication.open({ dataDirectory: f.data });
  const workspace = { id: 'project', name: '文档夹具', directory: f.source, deviceId: 'local' };
  const settings = app.settings.snapshot(); settings.settings.workspaces.push(workspace);
  await app.settings.save({ settings: settings.settings, expectedRevision: settings.revision });
  await app.createConversation('owner', '文档工具', workspace.id, undefined, undefined, { id: 'documents' });
  run = { id: 'artifact-run', requestKey: 'artifact-run', conversationId: 'documents', actorId: 'owner', agentId: 'default',
    workspaceId: workspace.id, status: 'queued', createdAt: 1, updatedAt: 1, iteration: 0, catalogVersion: 'fixture' };
  await app.storage.createRun(run, { id: 'input', runId: run.id, role: 'user', isUserInput: false,
    parts: [{ text: '文档夹具' }, { inlineData: { mimeType: 'application/octet-stream', data: 'AA==' } }] });
  await app.storage.appendRunEvent({ runId: run.id, type: 'run.started', payload: {}, update: { status: 'running' } });
  context = { runId: run.id, conversationId: run.conversationId, actorId: 'owner', toolCallId: 'artifact-call', workspace,
    signal: new AbortController().signal, progress() {}, askUser: async () => { throw new Error('unused'); } };
  await fs.mkdir(path.join(f.source, '.graycode', 'design'), { recursive: true });
  await fs.mkdir(path.join(f.source, '.graycode', 'review'), { recursive: true });
  await fs.writeFile(path.join(f.source, designPath), '# 原设计\n');
  const review = buildInitialReviewDocument({ title: 'Review', review: '检查当前实现。' });
  await fs.writeFile(path.join(f.source, '.graycode/review/base.md'), review);
  await fs.writeFile(path.join(f.source, '.graycode/review/target.md'), review);
  await fs.writeFile(path.join(f.source, '.graycode/progress.md'), buildProgressDocument({ projectId: 'project', projectName: '文档夹具',
    createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z', status: 'active', phase: 'plan', currentFocus: '', latestConclusion: '', nextAction: '',
    activeArtifacts: {}, todos: [], milestones: [], risks: [], log: [] }).content);
});
afterEach(async () => { jest.restoreAllMocks(); await app.close(); await f.cleanup(); });
const tool = (name: string) => app.artifacts.tools().find(tool => tool.declaration.name === name)!;

test.each([
  ['validate_review_document', { path: '.graycode/review/base.md' }],
  ['validate_progress_document', { path: '.graycode/progress.md' }],
  ['compare_review_documents', { basePath: '.graycode/review/base.md', targetPath: '.graycode/review/target.md' }],
] as const)('只读 %s 不加载对话正文或附件', async (name, args) => {
  const reads = jest.spyOn(app.storage, 'readConversationState');
  expect(await tool(name).execute(args, context)).toMatchObject({ success: true });
  expect(reads).not.toHaveBeenCalled();
});

test('没有文档确认请求的普通运行不加载完整历史', async () => {
  const reads = jest.spyOn(app.storage, 'readConversationState');
  await app.artifacts.beforeRun(run);
  expect(reads).not.toHaveBeenCalled();
});

test('设计读取后的外部修改不能被更新工具覆盖', async () => {
  const target = path.join(f.source, designPath), nativeOpen = fs.open;
  let changed = false;
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (args[0] === target && !changed) {
      const read = handle.readFile.bind(handle);
      jest.spyOn(handle, 'readFile').mockImplementationOnce(async () => {
        const bytes = await read(); changed = true; await fs.writeFile(target, '# 外部的新修改\n'); return bytes;
      });
    }
    return handle;
  });
  const result = await tool('update_design').execute({ path: designPath, design: '# 工具生成的修改\n' }, context);
  expect(result.success).toBe(false); expect(result.error).toContain('FILE_CONFLICT');
  expect(await fs.readFile(target, 'utf8')).toBe('# 外部的新修改\n');
  expect(await app.storage.getRecord('workspace-operations', run.conversationId)).toBeNull();
  expect(await tool('update_design').execute({ path: designPath, design: '# 重新读取后更新\n' }, context)).toMatchObject({ success: true });
});

test('正常文档更新保留确认请求，并继续使用操作开始时的对话版本', async () => {
  const target = path.join(f.source, designPath);
  const read = jest.spyOn(app.storage, 'readConversationState');
  const info = jest.spyOn(app.storage, 'getConversationInfo');
  expect(await tool('update_design').execute({ path: designPath, design: '# 已更新设计\n' }, context)).toMatchObject({ success: true });
  expect(read).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(target, 'utf8')).toBe('# 已更新设计\n');
  expect((await app.storage.getConversation(run.conversationId))?.custom).toMatchObject({ pendingApprovalGate: { sourceToolCallId: 'artifact-call', sourceToolName: 'update_design' } });
  const nativeOpen = fs.open; let advanced = false;
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (args[0] === target && !advanced) {
      advanced = true;
      await app.storage.appendHistory(run.conversationId, [{ id: 'later-input', role: 'user', parts: [{ text: '工具读取期间的新消息' }] }]);
    }
    return handle;
  });
  await expect(tool('update_design').execute({ path: designPath, design: '# 不能覆盖的旧事务\n' }, context)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  expect(await fs.readFile(target, 'utf8')).toBe('# 已更新设计\n');
});

test.each([false, true])('有确认请求时仍区分自动接续与显式用户输入（%s）', async explicit => {
  if (explicit) await app.storage.appendHistory(run.conversationId, [{ id: 'explicit-input', runId: run.id, role: 'user', isUserInput: true, parts: [{ text: '新的用户要求' }] }]);
  const state = await app.storage.readConversationState(run.conversationId);
  const gate = { id: 'approval-fixture', kind: 'generate_plan', continuationIntent: 'generate_plan_now', sourceToolCallId: 'previous-tool',
    sourceToolName: 'create_design', sourceArtifactType: 'design', sourcePath: designPath, createdAt: 1 };
  await app.storage.commitConversation({ conversationId: run.conversationId, expectedRevision: state.history.revision, expectedMetadataToken: state.metadataToken,
    activeRunId: run.id, metadata: { ...state.metadata, custom: { ...state.metadata.custom as object, pendingApprovalGate: gate } } });
  const reads = jest.spyOn(app.storage, 'readConversationState');
  await app.artifacts.beforeRun(run);
  expect(reads).not.toHaveBeenCalled();
  expect((await app.storage.getConversation(run.conversationId))?.custom).toMatchObject({ pendingApprovalGate: explicit ? null : gate });
  expect((await app.storage.readHistory(run.conversationId, { offset: 0, limit: 1 })).messages[0].parts[1]).toEqual({ inlineData: { mimeType: 'application/octet-stream', data: 'AA==' } });
});
