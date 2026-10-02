import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolContext } from '@graycode/core';
import type { RunRecord } from '@graycode/contracts';
import { PlatformApplication } from '../../../apps/server/src/application';
import { fixture } from './fixtures';

let f: Awaited<ReturnType<typeof fixture>>, app: PlatformApplication, context: ToolContext;
beforeEach(async () => {
  f = await fixture(); await f.store.close(); app = await PlatformApplication.open({ dataDirectory: f.data });
  const now = Date.now();
  await app.storage.createConversation({ id: 'terminal-chat', actorId: 'owner', title: 'terminal', createdAt: now, updatedAt: now });
  const run: RunRecord = { id: 'terminal-run', requestKey: 'terminal-run', actorId: 'owner', agentId: 'default', conversationId: 'terminal-chat', status: 'queued', iteration: 0, catalogVersion: 'fixture', createdAt: now, updatedAt: now };
  await app.storage.createRun(run, { id: 'terminal-input', role: 'user', parts: [{ text: 'test' }] });
  context = { actorId: 'owner', runId: run.id, conversationId: run.conversationId, workspace: { id: 'terminal-workspace', directory: f.root, name: 'Fixture', deviceId: 'local' },
    signal: new AbortController().signal, progress: jest.fn(), askUser: jest.fn() };
});
afterEach(async () => {
  await app.terminals.close();
  await app.storage.appendRunEvent({ runId: context.runId, type: 'run.cancelled', payload: {}, update: { status: 'cancelled' } });
  await app.close(); await f.cleanup();
});
const task = (args: Record<string, unknown>, owner = context) => app.tools.catalog(['terminal_task']).entries.get('terminal_task')!.tool.execute(args, owner) as Promise<any>;

async function start(script: string) {
  await writeFile(path.join(f.root, 'terminal-fixture.cjs'), script);
  const command = process.platform === 'win32' ? 'node terminal-fixture.cjs; exit $LASTEXITCODE' : 'node terminal-fixture.cjs; exit $?';
  const result = await app.tools.catalog(['execute_command']).entries.get('execute_command')!.tool.execute({ command, shell: process.platform === 'win32' ? 'powershell' : 'default', background: true }, context);
  expect(result.success).toBe(true);
  return (result.data as any).taskId as string;
}
async function waitFor(id: string, predicate: (result: any) => boolean) {
  const deadline = Date.now() + 15000;
  let result;
  do {
    result = await task({ action: 'read', taskId: id });
    if (predicate(result.data)) return result.data;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`Terminal fixture did not reach the expected state: ${JSON.stringify(result)}`);
}

test('真实后台命令保留自动通知与非零终态，查询支持增量输出和续读', async () => {
  context.toolCallId = 'terminal-call';
  const publish = jest.spyOn(app, 'publish');
  const feedback = jest.spyOn(app.subagents.feedback, 'enqueueMessage');
  const id = await start("process.stdout.write('first😀\\n'); setTimeout(() => { process.stderr.write('second\\n'); process.exitCode = 7; }, 1000);");
  const first = await waitFor(id, data => data.output.includes('first'));
  expect(first.running).toBe(true);
  const final = await waitFor(id, data => !data.running);
  expect(final).toMatchObject({ status: 'error', exitCode: 7, output: 'first😀\nsecond\n' });
  const outputEvents = publish.mock.calls.map(([event]) => event as any).filter(event => event.message?.command === 'terminalOutput');
  expect(outputEvents.length).toBeGreaterThan(2);
  for (const event of outputEvents) expect(event.message.data).toMatchObject({ terminalId: id, toolId: 'terminal-call', conversationId: 'terminal-chat' });
  const next = await task({ action: 'read', taskId: id, cursor: first.nextCursor });
  expect(next).toMatchObject({ success: true, data: { output: 'second\n', nextCursor: final.nextCursor, cursorOriginKnown: true } });
  expect(await task({ action: 'status', taskId: id })).toMatchObject({ success: true, data: { running: false, exitCode: 7, status: 'error' } });
  expect(await task({ action: 'list' })).toMatchObject({ success: true, data: { total: 1, tasks: [{ taskId: id }] } });
  const records = await app.storage.listRecords('terminal-records', 'terminal-chat');
  expect(records).toContain(id);
  expect(await app.storage.getRecord('terminal-records', id)).toMatchObject({ outputBuffer: { output: 'first😀\nsecond\n' } });
  expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ id: `terminal-result-${id}`, message: expect.objectContaining({ source: 'background_task', backgroundTask: { kind: 'terminal', taskId: id, status: 'error' } }) }));
}, 25000);

test('停止仅作用于受管任务，输出可以继续读，未知和跨工作区访问明确失败', async () => {
  const id = await start("console.log('ready'); setInterval(() => {}, 1000);");
  await waitFor(id, data => data.output.includes('ready'));
  expect(await task({ action: 'stop', taskId: id }, { ...context, workspace: { ...context.workspace!, id: 'other' } })).toMatchObject({ success: false, code: 'FORBIDDEN' });
  expect(await task({ action: 'status', taskId: 'missing' })).toMatchObject({ success: false, code: 'NOT_FOUND' });
  expect(await task({ action: 'stop', taskId: id })).toMatchObject({ success: true, data: { running: false } });
  expect((await task({ action: 'read', taskId: id })).data.output).toContain('ready');
  expect(await app.terminals.output('owner', id)).toMatchObject({ success: true, running: false, killed: true });
  expect(await task({ action: 'read', taskId: id, cursor: 1e9 })).toMatchObject({ success: false, code: 'INVALID_CURSOR' });
  expect(await task({ action: 'stop', taskId: id })).toMatchObject({ success: true, data: { running: false } });
}, 25000);

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// 实机复现启动器场景：启动器拉起继承标准输出的子进程后退出，Shell 随之结束，子进程的父进程已不存在。
(process.platform === 'win32' ? test : test.skip)('前台命令中断时终止父进程已退出的后代，并说明原因与清理结果', async () => {
  const pidFile = path.join(f.root, 'orphan.pid');
  await writeFile(path.join(f.root, 'orphan-child.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  await writeFile(path.join(f.root, 'orphan-launcher.cjs'), `const child = require('node:child_process').spawn(process.execPath, [require('node:path').join(__dirname, 'orphan-child.cjs')], { stdio: 'inherit', detached: true });
    child.unref(); setTimeout(() => {}, 3000);`);
  const controller = new AbortController();
  const pending = app.tools.catalog(['execute_command']).entries.get('execute_command')!.tool.execute(
    { command: 'node orphan-launcher.cjs', shell: 'powershell', timeout: 0 }, { ...context, toolCallId: 'orphan-call', signal: controller.signal }) as Promise<any>;
  let child = 0;
  for (const deadline = Date.now() + 10_000; !child && Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, 100));
    child = Number(await import('node:fs/promises').then(fs => fs.readFile(pidFile, 'utf8')).catch(() => '0'));
  }
  try {
    expect(child).toBeGreaterThan(0);
    // 等启动器和 Shell 退出后再中断：此时 taskkill /T 从 Shell 已经找不到子进程
    await new Promise(resolve => setTimeout(resolve, 4500));
    expect(alive(child)).toBe(true);
    controller.abort(new Error('Cancelled by user.'));
    const result = await pending;
    expect(result).toMatchObject({ success: false, code: 'CANCELLED', data: { interruption: { reason: 'user_cancelled', processTree: { verified: true, cleaned: true } } } });
    expect(result.data.interruption.processTree.detached).toEqual(expect.arrayContaining([expect.objectContaining({ pid: child })]));
    expect(result.error).toContain('User cancelled');
    expect(alive(child)).toBe(false);
  } finally { if (child && alive(child)) process.kill(child); }
}, 40000);

test('已保存输出支持截断游标、旧记录与分页，重启后标记中断而不重放', async () => {
  for (let index = 0; index < 3; index++) await app.storage.putRecord({ namespace: 'terminal-records', id: `saved-${index}`, ownerId: 'terminal-chat', value: {
    id: `saved-${index}`, actorId: 'owner', conversationId: 'terminal-chat', runId: context.runId, workspaceId: context.workspace!.id,
    status: index === 2 ? 'running' : 'completed', startTime: index, updatedAt: index, data: { output: 'legacy', background: false, command: 'do not run' },
    ...(index ? { outputBuffer: { output: 'kept', outputOffset: 9000, truncated: true } } : {}),
  } });
  await app.storage.putRecord({ namespace: 'terminal-active', id: 'saved-2', ownerId: 'terminal-chat', value: { id: 'saved-2' } });
  await app.terminals.initialize();
  expect(await task({ action: 'status', taskId: 'saved-2' })).toMatchObject({ data: { status: 'interrupted', running: false } });
  expect(await task({ action: 'read', taskId: 'saved-1', cursor: 0, maxChars: 2 })).toMatchObject({ data: { output: 'ke', outputOffset: 9000, nextCursor: 9002, outputLost: true, hasMore: true } });
  expect(await task({ action: 'read', taskId: 'saved-0' })).toMatchObject({ data: { output: 'legacy', cursorOriginKnown: false } });
  const page = await task({ action: 'list', limit: 1 });
  expect(page.data).toMatchObject({ tasks: [{ taskId: 'saved-2' }], nextOffset: 1 });
  expect((await task({ action: 'list', limit: 1, offset: page.data.nextOffset })).data.tasks[0].taskId).toBe('saved-1');
});
