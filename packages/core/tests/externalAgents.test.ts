import path from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import type { ToolContext } from '@graycode/core';
import type { WorkspaceDefinition } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

const owner = { actorId: 'owner', clientId: 'acp-test' };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIh8AAAAASUVORK5CYII=';
async function traces(directory: string): Promise<any[]> {
  try { return (await readFile(path.join(directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function until(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Fixture did not reach the expected operation'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function configure(app: PlatformApplication, directory: string, waitNew = false) {
  const router = new ApplicationRouter(app);
  const workspace = await router.call(owner, 'workspaces.add', { directory }) as WorkspaceDefinition;
  const ui = (type: string, data = {}) => router.call(owner, 'ui.request', { type, data });
  await ui('ui.settings.begin');
  await ui('platform.externalAgents.update', { profiles: [{ id: 'fixture', name: 'Fixture', enabled: true,
    command: process.execPath, args: [path.resolve('packages/core/tests/fixtures/acp-agent.mjs')],
    env: { ACP_FIXTURE_DIRECTORY: directory, ACP_FIXTURE_WAIT_NEW: waitNew ? '1' : '0' } }] });
  expect(app.tools.declarations().some(tool => tool.name === 'coding_agent')).toBe(false);
  await ui('ui.settings.save');
  await expect(access(path.join(directory, 'trace.jsonl'))).rejects.toThrow();
  const chat = await router.call(owner, 'conversations.create', { title: 'ACP', workspaceId: workspace.id }) as { id: string };
  let sequence = 0;
  const context = (signal = new AbortController().signal): ToolContext => ({ actorId: 'owner', runId: `test-${++sequence}`, conversationId: chat.id,
    toolCallId: `acp-${sequence}`, iteration: 0, workspace, signal, progress: () => {}, askUser: async () => { throw new Error('Unexpected question'); } });
  return { workspace, chat, context, router };
}

test('ACP runs in the task workspace, preserves permission choices, appends images, and restores/forks without replay', async () => {
  const f = await fixture(); await f.store.close();
  const options = { dataDirectory: f.data, models: { generate: async input => {
    if (input.messages.some(message => message.isFunctionResponse)) return { role: 'model' as const, parts: [{ text: '完成' }] };
    return { role: 'model' as const, parts: [{ functionCall: { id: 'external', name: 'coding_agent', args: { action: 'create', profileId: 'fixture', prompt: 'permission', images: ['pixel.png'] } } }] };
  } } };
  let app = await PlatformApplication.open(options);
  try {
    const { workspace, chat, context } = await configure(app, f.source);
    await writeFile(path.join(f.source, 'pixel.png'), Buffer.from(png, 'base64'));
    const choices: string[] = [];
    app.runtime.subscribe(event => {
      if (event.type !== 'event' || event.event.type !== 'approval.requested') return;
      const request = event.event.payload as any;
      const choice = request.choices?.[choices.length === 0 ? 0 : 1]?.id;
      if (choice) choices.push(choice);
      void app.runtime.resolveApproval(request.id, 'owner', true, choice);
    });
    const run = await app.runtime.start({ actorId: 'owner', agentId: 'default', conversationId: chat.id, workspaceId: workspace.id, requestKey: 'acp-native',
      message: { role: 'user', parts: [{ text: '测试代理' }] } });
    expect((await app.runtime.wait(run.id))?.status).toBe('completed');
    const history = await app.storage.readFullHistory(chat.id);
    const response = history.messages.find(message => message.isFunctionResponse)!;
    const result = (response.parts[0].functionResponse as any).response;
    if (!result.success) throw new Error(result.error);
    expect(result).toMatchObject({ success: true, data: { text: '已处理：permission', session: { status: 'idle', directory: f.source, agentInfo: { name: 'fixture' } } } });
    expect(response.parts[1].inlineData).toMatchObject({ mimeType: 'image/png', data: png });
    expect(choices).toEqual(['yes-1', 'no-2']);
    const id = result.data.session.id, remoteId = result.data.session.remoteSessionId;
    const exec = (args: Record<string, unknown>) => app.externalAgents.execute({ sessionId: id, ...args }, context()) as Promise<any>;
    expect((await exec({ action: 'prompt', prompt: 'second' })).success).toBe(true);
    expect((await exec({ action: 'configure', configId: 'model', value: 'two' })).success).toBe(true);
    expect((await exec({ action: 'configure', configId: 'thoughts', value: true })).success).toBe(true);
    expect((await exec({ action: 'configure', modeId: 'plan' })).data.session.modes.currentModeId).toBe('plan');
    const events = (await exec({ action: 'events' })).data.events;
    expect(events.map(event => event.type)).toContain('agent_thought_chunk');
    expect(events.filter(event => event.type === 'permission.resolved').map(event => event.data.choiceId)).toEqual(choices);
    const before = await traces(f.source);
    expect(before.filter(event => event.method === 'session/prompt').map(event => event.params.prompt))
      .toEqual([[{ type: 'text', text: 'permission' }, { type: 'image', mimeType: 'image/png', data: png }], [{ type: 'text', text: 'second' }]]);
    expect(before.every(event => event.cwd === f.source)).toBe(true);
    expect(before.find(event => event.method === 'initialize').params.clientCapabilities.terminal).toBe(false);
    await app.close(); app = await PlatformApplication.open(options);
    const restored = await exec({ action: 'load' });
    expect(restored.data.text).toBe('');
    expect(restored.data.session.configOptions).toEqual(expect.arrayContaining([{ id: 'thoughts', name: 'Thoughts', type: 'boolean', currentValue: true }]));
    expect(restored.data.session.modes.currentModeId).toBe('plan');
    expect((await exec({ action: 'prompt', prompt: 'third' })).success).toBe(true);
    const forked = await exec({ action: 'fork' });
    expect(forked.success).toBe(true); expect(forked.data.session.remoteSessionId).not.toBe(remoteId);
    expect(JSON.parse(await readFile(path.join(f.source, `${forked.data.session.remoteSessionId}.json`), 'utf8')).prompts).toHaveLength(3);
    expect((await exec({ action: 'events' })).data.events.some(event => JSON.stringify(event).includes('REPLAY MUST'))).toBe(false);
    expect((await traces(f.source)).filter(event => event.method === 'session/load')).toHaveLength(0);
    expect((await exec({ action: 'close' })).data.session.status).toBe('closed');
    await expect(exec({ action: 'prompt', prompt: 'closed' })).rejects.toThrow('已关闭');
    expect((await exec({ action: 'load' })).success).toBe(true);
  } finally { await app.close(); await f.cleanup(); }
}, 35000);

test('ACP cancellation releases owned processes and uncertain operations are not repeated after restart', async () => {
  const f = await fixture(); await f.store.close();
  let app = await PlatformApplication.open({ dataDirectory: f.data });
  try {
    const { context } = await configure(app, f.source);
    const created = await app.externalAgents.execute({ action: 'create' }, context()) as any;
    if (!created.success) throw new Error(created.error);
    expect(created.success).toBe(true);
    const sessionId = created.data.session.id;
    const cancel = new AbortController(), same = context(cancel.signal);
    const pending = app.externalAgents.execute({ action: 'prompt', sessionId, prompt: 'wait' }, same);
    await until(async () => (await traces(f.source)).some(event => event.method === 'session/prompt'));
    await expect(app.externalAgents.execute({ action: 'prompt', sessionId, prompt: 'different' }, same)).rejects.toThrow('另一组');
    cancel.abort(new Error('用户停止'));
    expect(await pending).toMatchObject({ success: false, code: 'CANCELLED' });
    const crashContext = context(), crashArgs = { action: 'prompt', sessionId, prompt: 'crash' };
    expect(await app.externalAgents.execute(crashArgs, crashContext)).toMatchObject({ success: false, code: 'EXTERNAL_EXECUTION_UNKNOWN' });
    await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data });
    expect(await app.externalAgents.execute(crashArgs, crashContext)).toMatchObject({ code: 'EXTERNAL_EXECUTION_UNKNOWN' });
    expect((await traces(f.source)).filter(event => event.method === 'session/prompt' && event.params.prompt[0].text === 'crash')).toHaveLength(1);
    const snapshot = app.settings.snapshot(); snapshot.settings.externalAgents![0].env!.ACP_FIXTURE_WAIT_NEW = '1';
    await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
    const newCancel = new AbortController();
    const creating = app.externalAgents.execute({ action: 'create' }, context(newCancel.signal));
    await until(async () => (await traces(f.source)).filter(event => event.method === 'session/new').length === 2);
    newCancel.abort(new Error('停止创建'));
    expect(await creating).toMatchObject({ success: false, code: 'EXTERNAL_EXECUTION_UNKNOWN' });
    await app.close();
    for (const pid of new Set((await traces(f.source)).map(event => event.pid))) expect(() => process.kill(pid, 0)).toThrow();
  } finally { await app.close(); await f.cleanup(); }
}, 25000);

test('ACP 恢复失败释放未恢复的进程，明确重试时重新恢复原会话', async () => {
  const f = await fixture(); await f.store.close();
  let app = await PlatformApplication.open({ dataDirectory: f.data });
  try {
    const { context } = await configure(app, f.source);
    const created = await app.externalAgents.execute({ action: 'create' }, context()) as any;
    expect(created.success).toBe(true);
    const sessionId = created.data.session.id;
    await app.close(); app = await PlatformApplication.open({ dataDirectory: f.data });
    await writeFile(path.join(f.source, 'fail-resume-once'), '1');
    const failed = await app.externalAgents.execute({ action: 'load', sessionId }, context());
    expect(failed).toMatchObject({ success: false, code: 'EXTERNAL_AGENT_FAILED', error: expect.stringContaining('Fixture refused') });
    const firstResume = (await traces(f.source)).find(event => event.method === 'session/resume');
    expect(() => process.kill(firstResume.pid, 0)).toThrow();
    expect(await app.externalAgents.execute({ action: 'load', sessionId }, context())).toMatchObject({ success: true });
    const resumed = (await traces(f.source)).filter(event => event.method === 'session/resume');
    expect(resumed).toHaveLength(2); expect(resumed[1].pid).not.toBe(resumed[0].pid);
    expect(resumed[1].params.sessionId).toBe(created.data.session.remoteSessionId);
    expect((await traces(f.source)).filter(event => event.method === 'session/prompt')).toHaveLength(0);
  } finally { await app.close(); await f.cleanup(); }
}, 25000);

test('ACP 关闭覆盖仍在读取操作记录的调用，不会继续启动代理', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  let release!: () => void;
  let readStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  try {
    const { context } = await configure(app, f.source);
    const getRecord = app.storage.getRecord.bind(app.storage);
    const read = jest.spyOn(app.storage, 'getRecord').mockImplementation(async (namespace, id) => {
      if (namespace === 'external-agent-operations') { readStarted(); await gate; }
      return getRecord(namespace, id);
    });
    const pending = app.externalAgents.execute({ action: 'create' }, context());
    await reading;
    const closing = app.externalAgents.close(); release();
    expect(await pending).toMatchObject({ success: false, code: 'CANCELLED' });
    await closing; read.mockRestore();
    expect(await traces(f.source)).toEqual([]);
  } finally { release(); await app.close(); await f.cleanup(); }
}, 25000);
