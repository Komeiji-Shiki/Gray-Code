import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext } from '@graycode/core';
import type { StoredRecord, WorkspaceDefinition } from '@graycode/contracts';
import { WorkspaceFiles } from '../../../apps/server/src/workspace/files';
import { WorkspaceProcesses, ProcessSessionError, type ProcessResult } from '../../../apps/server/src/workspace/processes';
import { workspaceTools } from '../../../apps/server/src/workspace/tools';
import { t } from '../../../backend/i18n';

let directory: string;
let workspace: WorkspaceDefinition;
let context: ToolContext;
let files: WorkspaceFiles;
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'graycode-process-tools-'));
  const root = path.join(directory, 'workspace');
  await mkdir(path.join(root, 'sub dir'), { recursive: true });
  await mkdir(path.join(directory, 'outside'));
  await writeFile(path.join(root, 'file.txt'), 'not a directory');
  await symlink(path.join(directory, 'outside'), path.join(root, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(path.join(root, 'sub dir'), path.join(root, 'internal-link'), process.platform === 'win32' ? 'junction' : 'dir');
  workspace = { id: 'workspace', directory: root, deviceId: 'local', name: '测试' };
  context = { actorId: 'actor', runId: 'run-1', conversationId: 'conversation', workspace,
    signal: new AbortController().signal, progress: jest.fn(), askUser: jest.fn() };
  files = new WorkspaceFiles();
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function fixture() {
  const processes = {
    start: jest.fn(async () => ({ id: 'session' })),
    read: jest.fn(async () => ({ id: 'session', output: 'read' })),
    input: jest.fn(async () => {}), stop: jest.fn(async () => {}),
  };
  const tools = workspaceTools(files, processes as unknown as WorkspaceProcesses, {} as any);
  return { processes, run: tools.find(tool => tool.declaration.name === 'run_command')!, session: tools.find(tool => tool.declaration.name === 'process_session')! };
}

const owner = { actorId: 'actor', runId: 'run-1', conversationId: 'conversation', workspaceId: 'workspace' };

test.each([undefined, 'sub dir', 'internal-link'])('run_command 将授权后的目录 %s 和原 args 交给 start，身份仅取 ToolContext', async cwd => {
  const { run, processes } = fixture();
  const args = ['a b', '$HOME', 'x|y', '"quotes"', '%PATH%'];
  const resolved = await realpath(path.join(workspace.directory, cwd ?? '.'));
  await run.execute({ command: 'fixture', args, cwd, actorId: 'intruder', conversationId: 'other', workspaceId: 'outside' }, context);
  expect(processes.start).toHaveBeenCalledWith(workspace, owner, 'fixture', args, expect.any(Function), { cwd: resolved });
  expect((processes.start.mock.calls as any)[0][3]).toBe(args);
  (processes.start.mock.calls as any)[0][4]('progress');
  expect(context.progress).toHaveBeenCalledWith({ text: 'progress' });
});

// 默认启动目录沿用旧行为；多根工作区的非默认路径仍使用文件工具的显式根前缀。
test.each([undefined, '', '.', '@main', '@main/sub dir', '@other'])('多根工作区 cwd=%s 保留默认主根并支持显式根', async cwd => {
  const { run, processes } = fixture();
  const other = path.join(directory, 'outside');
  const multi = { ...workspace, roots: [{ name: 'main', directory: workspace.directory }, { name: 'other', directory: other }] };
  await run.execute({ command: 'fixture', args: [], cwd }, { ...context, workspace: multi });
  const expected = cwd === '@other' ? other : cwd === '@main/sub dir' ? path.join(workspace.directory, 'sub dir') : workspace.directory;
  expect(processes.start).toHaveBeenCalledWith(multi, owner, 'fixture', [], expect.any(Function), { cwd: await realpath(expected) });
});

test('多根工作区的模糊相对 cwd、未知前缀和根外目录不启动命令', async () => {
  const { run, processes } = fixture();
  const multi = { ...workspace, roots: [{ name: 'main', directory: workspace.directory }, { name: 'other', directory: path.join(directory, 'outside') }] };
  for (const cwd of ['sub dir', '@missing', '@main/../..']) {
    await expect(run.execute({ command: 'fixture', args: [], cwd }, { ...context, workspace: multi })).rejects.toThrow();
  }
  expect(processes.start).not.toHaveBeenCalled();
});

test.each(['../outside', 'external-link', 'file.txt', 'missing'])('cwd %s 越界、符号链接越界、文件或缺失时在启动前拒绝', async cwd => {
  const { run, processes } = fixture();
  await expect(run.execute({ command: 'fixture', args: [], cwd }, context)).rejects.toThrow();
  expect(processes.start).not.toHaveBeenCalled();
});

test('未选择工作区不能启动，任意工作区外绝对路径也不能启动', async () => {
  const { run, processes } = fixture();
  await expect(run.execute({ command: 'fixture', args: [] }, { ...context, workspace: undefined })).rejects.toThrow('Select a workspace');
  await expect(run.execute({ command: 'fixture', args: [], cwd: path.join(directory, 'outside') }, context)).rejects.toThrow('outside');
  expect(processes.start).not.toHaveBeenCalled();
});

test('process_session read 传递 cursor/maxChars，缺 conversation 和 workspace 时不伪造归属', async () => {
  const { session, processes } = fixture();
  await session.execute({ action: 'read', id: 'session', cursor: 7, maxChars: 20, actorId: 'intruder' }, { ...context, runId: 'run-2' });
  expect(processes.read).toHaveBeenCalledWith('session', { ...owner, runId: 'run-2' }, { cursor: 7, maxChars: 20 });
  await session.execute({ action: 'read', id: 'session' }, { ...context, conversationId: undefined, workspace: undefined });
  expect(processes.read).toHaveBeenLastCalledWith('session', { ...owner, conversationId: undefined, workspaceId: undefined }, { cursor: undefined, maxChars: undefined });
});

test('input 必须等待异步授权和写入成功才 read；stop 使用同一可信 owner', async () => {
  const { session, processes } = fixture();
  let resolve!: () => void;
  processes.input.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  const pending = session.execute({ action: 'input', id: 'session', text: 'raw\n', cursor: 100 }, context);
  expect(processes.input).toHaveBeenCalledWith('session', owner, 'raw\n');
  expect(processes.read).not.toHaveBeenCalled();
  resolve(); await pending;
  expect(processes.read).toHaveBeenCalledWith('session', owner, undefined);
  await session.execute({ action: 'stop', id: 'session' }, context);
  expect(processes.stop).toHaveBeenCalledWith('session', owner);
});

test.each(['NOT_FOUND', 'FORBIDDEN', 'EXITED', 'INVALID_CURSOR'] as const)('process_session 保留错误码 %s，异步 input 拒绝时不伪报成功', async code => {
  const { session, processes } = fixture();
  processes.input.mockRejectedValueOnce(new ProcessSessionError(code, '明确原因'));
  // 错误码与失败语义保持不变，可诊断状态同时给出同一受管会话的准确读取入口。
  const expected = { success: false, code, error: '明确原因',
    ...(['EXITED', 'INVALID_CURSOR'].includes(code) ? { data: { id: 'session', nextActions: [{
      tool: 'process_session', args: { action: 'read', id: 'session' }, when: t('tools.terminal.nextActions.processInspect'),
    }] } } : {}) };
  expect(await session.execute({ action: 'input', id: 'session', text: 'late' }, context)).toEqual(expected);
  expect(processes.read).not.toHaveBeenCalled();
  processes.read.mockRejectedValueOnce(new ProcessSessionError(code, '明确原因'));
  expect(await session.execute({ action: 'read', id: 'session' }, context)).toEqual(expected);
});

test('未知异常不被伪装为进程权限或状态错误', async () => {
  const { session, processes } = fixture();
  processes.stop.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(session.execute({ action: 'stop', id: 'session' }, context)).rejects.toThrow('storage unavailable');
  expect(processes.read).not.toHaveBeenCalled();
});

test('声明的 cwd 和读取游标可选，身份字段不能由模型指定', () => {
  const { run, session } = fixture();
  expect(run.declaration.parameters.required).toEqual(['command', 'args']);
  expect(run.declaration.parameters.properties).toMatchObject({ cwd: { type: 'string' } });
  expect(session.declaration.parameters.required).toEqual(['action', 'id']);
  expect(session.declaration.parameters.properties).toMatchObject({ cursor: { type: 'integer', minimum: 0 }, maxChars: { maximum: 256000 } });
  for (const tool of [run, session]) {
    expect(tool.declaration.parameters.additionalProperties).toBe(false);
    expect(tool.declaration.parameters.properties).not.toHaveProperty('actorId');
  }
  expect(session.declaration.description).toContain('UTF-16');
  expect(session.declaration.description).toContain('taskId');
});

test('真实子进程：cwd、无 Shell 参数、跨 run 输入与增量读取可以完成一轮', async () => {
  const records = new Map<string, unknown>();
  const processes = new WorkspaceProcesses({
    putRecord: async (record: StoredRecord) => { records.set(record.id, structuredClone(record.value)); },
    getRecord: async (_namespace: string, id: string) => records.get(id) ?? null,
    getRun: async () => null,
  });
  const tools = workspaceTools(files, processes, {} as any);
  const run = tools.find(tool => tool.declaration.name === 'run_command')!;
  const session = tools.find(tool => tool.declaration.name === 'process_session')!;
  const args = ['a b', '$HOME', 'x|y', '"quotes"', '%PATH%'];
  // 夹具只等待本测试发送的输入，finally 按自己持有的对象收尾，不使用全局 PID 清理。
  const script = "process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }) + '\\n'); process.stdin.once('data', data => { process.stdout.write(data, () => process.exit(0)); });";
  try {
    const started = await run.execute({ command: process.execPath, args: ['-e', script, ...args], cwd: 'sub dir' }, context);
    expect(started.success).toBe(true);
    const result = started.data as ProcessResult;
    const continuation = { ...context, runId: 'run-2' };
    const first = await session.execute({ action: 'read', id: result.id, cursor: 0 }, continuation);
    expect(first.success).toBe(true);
    let firstRead = first.data as ProcessResult;
    const startupDeadline = Date.now() + 5000;
    // start 的 300ms 只是首屏等待，不保证繁忙设备已完成 Node 启动；按输出就绪而非固定延迟断言。
    while (!firstRead.output.endsWith('\n') && firstRead.running && Date.now() < startupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const read = await session.execute({ action: 'read', id: result.id, cursor: 0 }, continuation);
      expect(read.success).toBe(true); firstRead = read.data as ProcessResult;
    }
    expect(JSON.parse(firstRead.output)).toEqual({ cwd: await realpath(path.join(workspace.directory, 'sub dir')), args });
    expect((await session.execute({ action: 'input', id: result.id, text: '输入😀\n' }, continuation)).success).toBe(true);
    let final = firstRead;
    const deadline = Date.now() + 5000;
    while (final.running && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      const read = await session.execute({ action: 'read', id: result.id, cursor: firstRead.nextCursor }, continuation);
      expect(read.success).toBe(true); final = read.data as ProcessResult;
    }
    expect(final).toMatchObject({ output: '输入😀\n', exitCode: 0, running: false, outputLost: false, hasMore: false });
    expect(await session.execute({ action: 'input', id: result.id, text: 'late' }, continuation)).toMatchObject({ success: false, code: 'EXITED' });
  } finally { await processes.close(); }
});

test.each([{ running: false, exitCode: 7, success: false }, { running: false, exitCode: -1, success: false }, { running: false, exitCode: 0, success: true }, { running: true, exitCode: null, success: true }, { running: false, exitCode: null, success: true }])('进程终态 $exitCode running=$running 保留输出和游标，明确失败摘要', async ({ running, exitCode, success }) => {
  const { run, session, processes } = fixture();
  const data = { id: 'session', output: 'diagnostic', outputOffset: 20, nextCursor: 30, hasMore: true, outputLost: true, truncated: true, running, exitCode };
  processes.start.mockResolvedValue(data); processes.read.mockResolvedValue(data);
  for (const result of [await run.execute({ command: 'fixture', args: [] }, context), await session.execute({ action: 'read', id: data.id, cursor: 20, maxChars: 10 }, context)]) {
    expect(result.success).toBe(success); expect(result.data).toBe(data);
    if (!success) expect(result).toMatchObject({ code: 'COMMAND_EXIT_NONZERO', error: `Command exited with code ${exitCode}` });
    else expect(result.error).toBeUndefined();
  }
  expect((await session.execute({ action: 'stop', id: data.id }, context)).success).toBe(true);
});

test.each([0, 600])('真实非零退出（延迟 %dms）在初次或续读结果标记失败且仍可跨 run 续读', async delay => {
  const records = new Map<string, unknown>();
  const processes = new WorkspaceProcesses({
    putRecord: async (record: StoredRecord) => { records.set(record.id, structuredClone(record.value)); },
    getRecord: async (_namespace: string, id: string) => records.get(id) ?? null, getRun: async () => null,
  });
  const tools = workspaceTools(files, processes, {} as any);
  const run = tools.find(tool => tool.declaration.name === 'run_command')!, session = tools.find(tool => tool.declaration.name === 'process_session')!;
  try {
    let result = await run.execute({ command: process.execPath, args: ['-e', `setTimeout(() => { console.error('fixture failure'); process.exitCode = 7; }, ${delay})`] }, context);
    const deadline = Date.now() + 5000;
    while ((result.data as ProcessResult).running && Date.now() < deadline) {
      expect(result.success).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 20));
      result = await session.execute({ action: 'read', id: (result.data as ProcessResult).id }, { ...context, runId: 'continued' });
    }
    expect(result).toMatchObject({ success: false, code: 'COMMAND_EXIT_NONZERO', error: 'Command exited with code 7', data: { running: false, exitCode: 7, output: expect.stringContaining('fixture failure') } });
    const final = result.data as ProcessResult;
    expect(await session.execute({ action: 'read', id: final.id, cursor: final.nextCursor }, context)).toMatchObject({ success: false, data: { output: '', nextCursor: final.nextCursor, exitCode: 7 } });
  } finally { await processes.close(); }
});
