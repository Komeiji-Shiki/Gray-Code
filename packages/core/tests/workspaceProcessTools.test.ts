import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext } from '@graycode/core';
import type { WorkspaceDefinition } from '@graycode/contracts';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { WorkspaceFiles } from '../../../apps/server/src/workspace/files';
import { PlatformTerminals } from '../../../apps/server/src/terminal/service';
import { terminalTaskTool } from '../../../apps/server/src/terminal/tool';
import { ProcessSessionError } from '../../../shared/processOutput';
import { t } from '../../../backend/i18n';
import { TEMP_DIR_REMOVE_OPTIONS } from './fixtures';

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
  context = {
    actorId: 'actor',
    runId: 'run-1',
    conversationId: 'conversation',
    workspace,
    signal: new AbortController().signal,
    progress: jest.fn(),
    askUser: jest.fn(),
  };
  files = new WorkspaceFiles();
});
afterAll(async () => {
  await rm(directory, TEMP_DIR_REMOVE_OPTIONS);
});

function fixture(real = false) {
  const records = new Map<string, any>();
  const app = {
    files,
    publish: jest.fn(),
    conversation: jest.fn(async () => {}),
    product: { runtimeSettings: () => ({ getToolsEnabled: () => ({}), isToolEnabled: () => true }) },
    storage: {
      commitRecords: jest.fn(async (entries) => {
        for (const entry of entries) {
          if (entry.delete) records.delete(`${entry.namespace}:${entry.id}`);
          else records.set(`${entry.namespace}:${entry.id}`, structuredClone(entry.value));
        }
      }),
      getRecord: jest.fn(async (namespace, id) => records.get(`${namespace}:${id}`) ?? null),
      getRun: jest.fn(async (id) => ({ id, actorId: context.actorId, conversationId: context.conversationId })),
    },
    processes: {
      read: jest.fn(async () => {
        throw new ProcessSessionError('NOT_FOUND', 'not found');
      }),
    },
  };
  const terminals = new PlatformTerminals(app as unknown as PlatformApplication);
  const run = terminals.tool(),
    session = terminalTaskTool(terminals);
  const runner = {
    createExecuteCommandTool: () => ({ handler: runner.handler }),
    handler: jest.fn(async () => ({ success: true, data: { running: true } })),
    onTerminalOutput: jest.fn(() => () => {}),
    inputTerminalProcess: jest.fn(async () => {}),
    getTerminalOutput: jest.fn(() => ({ success: true, output: '', running: false })),
    killTerminalProcess: jest.fn(async () => ({ success: true })),
  };
  if (!real) jest.spyOn(terminals as any, 'runtime').mockReturnValue(runner);
  const active = (taskId: string) => (terminals as any).active.get(taskId).record;
  return { app, records, terminals, run, session, runner, active };
}

test.each([undefined, 'sub dir', 'internal-link'])('execute_command argv 将授权目录 %s 和原 args 交给运行器，身份仅取 ToolContext', async (cwd) => {
  const { run, runner, records } = fixture();
  const args = ['a b', '$HOME', 'x|y', '"quotes"', '%PATH%'];
  const result = await run.execute({ mode: 'argv', command: 'fixture', args, cwd }, context);
  const taskId = (result.data as any).taskId;
  const resolved = await realpath(path.join(workspace.directory, cwd ?? '.'));
  expect(runner.handler).toHaveBeenCalledWith(
    { mode: 'argv', command: 'fixture', args, cwd: resolved },
    { toolId: taskId, conversationId: context.conversationId, abortSignal: context.signal },
  );
  expect((runner.handler.mock.calls as any)[0][0].args).toBe(args);
  expect(records.get(`terminal-records:${taskId}`)).toMatchObject({ actorId: 'actor', conversationId: 'conversation', workspaceId: 'workspace' });
});

test('目录授权期间取消后不再启动命令', async () => {
  const { run, runner } = fixture();
  const controller = new AbortController();
  const reason = new Error('Cancelled by user.');
  const resolving = jest.spyOn(files, 'resolve').mockImplementationOnce(async () => {
    controller.abort(reason);
    return workspace.directory;
  });
  try {
    await expect(run.execute({ mode: 'argv', command: 'fixture', args: [] }, { ...context, signal: controller.signal })).rejects.toBe(reason);
    expect(runner.handler).not.toHaveBeenCalled();
  } finally {
    resolving.mockRestore();
  }
});

test.each([undefined, '', '.', '@main', '@main/sub dir', '@other'])('多根工作区 cwd=%s 保留默认主根并支持显式根', async (cwd) => {
  const { run, runner } = fixture();
  const other = path.join(directory, 'outside');
  const multi = {
    ...workspace,
    roots: [
      { name: 'main', directory: workspace.directory },
      { name: 'other', directory: other },
    ],
  };
  await run.execute({ mode: 'argv', command: 'fixture', args: [], cwd }, { ...context, workspace: multi });
  const expected = cwd === '@other' ? other : cwd === '@main/sub dir' ? path.join(workspace.directory, 'sub dir') : workspace.directory;
  expect((runner.handler.mock.calls as any)[0][0].cwd).toBe(await realpath(expected));
});

test('多根工作区的模糊相对 cwd、未知前缀和根外目录不启动命令', async () => {
  const { run, runner } = fixture();
  const multi = {
    ...workspace,
    roots: [
      { name: 'main', directory: workspace.directory },
      { name: 'other', directory: path.join(directory, 'outside') },
    ],
  };
  for (const cwd of ['sub dir', '@missing', '@main/../..']) {
    await expect(run.execute({ mode: 'argv', command: 'fixture', args: [], cwd }, { ...context, workspace: multi })).rejects.toThrow();
  }
  expect(runner.handler).not.toHaveBeenCalled();
});

test.each(['../outside', 'external-link', 'file.txt', 'missing'])('cwd %s 越界、符号链接越界、文件或缺失时在启动前拒绝', async (cwd) => {
  const { run, runner } = fixture();
  await expect(run.execute({ mode: 'argv', command: 'fixture', args: [], cwd }, context)).rejects.toThrow();
  expect(runner.handler).not.toHaveBeenCalled();
});

test('未选择工作区不能启动，任意工作区外绝对路径也不能启动', async () => {
  const { run, runner } = fixture();
  await expect(run.execute({ mode: 'argv', command: 'fixture', args: [] }, { ...context, workspace: undefined })).rejects.toThrow('工作区');
  await expect(run.execute({ mode: 'argv', command: 'fixture', args: [], cwd: path.join(directory, 'outside') }, context)).rejects.toThrow('outside');
  expect(runner.handler).not.toHaveBeenCalled();
});

test('terminal_task read 按 cursor/maxChars 续读，缺少对话和工作区时不能接管任务', async () => {
  const { run, session, active } = fixture();
  const taskId = ((await run.execute({ mode: 'argv', command: 'fixture', args: [] }, context)).data as { taskId: string }).taskId;
  active(taskId).outputBuffer = { output: 'first-second', outputOffset: 0, truncated: false };
  expect(await session.execute({ action: 'read', taskId, cursor: 6, maxChars: 3 }, { ...context, runId: 'run-2' })).toMatchObject({
    data: { output: 'sec', nextCursor: 9, hasMore: true },
  });
  await expect(session.execute({ action: 'read', taskId }, { ...context, conversationId: undefined, workspace: undefined })).rejects.toThrow(
    '工作区',
  );
});

test('input 必须等待异步授权和写入成功才返回；stop 使用同一受管任务', async () => {
  const { run, session, runner } = fixture();
  const taskId = ((await run.execute({ mode: 'argv', command: 'fixture', args: [] }, context)).data as { taskId: string }).taskId;
  let resolve!: () => void;
  runner.inputTerminalProcess.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const pending = session.execute({ action: 'input', taskId, text: 'raw\n' }, context);
  while (!resolve) await Promise.resolve();
  expect(runner.inputTerminalProcess).toHaveBeenCalledWith(taskId, 'raw\n', context.signal);
  resolve();
  expect((await pending).success).toBe(true);
  await session.execute({ action: 'stop', taskId }, context);
  expect(runner.killTerminalProcess).toHaveBeenCalledWith(taskId, 'stopped');
});

test.each(['NOT_FOUND', 'FORBIDDEN', 'EXITED', 'INVALID_CURSOR'] as const)(
  'terminal_task 保留错误码 %s，异步 input 拒绝时不伪报成功',
  async (code) => {
    const { run, session, runner } = fixture();
    const taskId = ((await run.execute({ mode: 'argv', command: 'fixture', args: [] }, context)).data as { taskId: string }).taskId;
    runner.inputTerminalProcess.mockRejectedValueOnce(new ProcessSessionError(code, '明确原因'));
    const expected = {
      success: false,
      code,
      error: '明确原因',
      ...(['EXITED', 'INVALID_CURSOR'].includes(code)
        ? {
            data: {
              taskId,
              nextActions: [
                {
                  tool: 'terminal_task',
                  args: { action: 'read', taskId },
                  when: t(code === 'INVALID_CURSOR' ? 'tools.terminal.nextActions.terminalResetCursor' : 'tools.terminal.nextActions.processInspect'),
                },
              ],
            },
          }
        : {}),
    };
    expect(await session.execute({ action: 'input', taskId, text: 'late' }, context)).toEqual(expected);
  },
);

test('未知异常不被伪装为进程权限或状态错误', async () => {
  const { run, session, runner } = fixture();
  const taskId = ((await run.execute({ mode: 'argv', command: 'fixture', args: [] }, context)).data as { taskId: string }).taskId;
  runner.killTerminalProcess.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(session.execute({ action: 'stop', taskId }, context)).rejects.toThrow('storage unavailable');
});

test('声明保留 Shell 默认值，argv、输入与读取游标可选，身份字段不能由模型指定', () => {
  const { run, session } = fixture();
  expect(run.declaration.parameters.required).toEqual(['command']);
  expect(run.declaration.parameters.properties).toMatchObject({ mode: { enum: ['shell', 'argv'], default: 'shell' }, args: { type: 'array' } });
  expect(session.declaration.parameters.required).toEqual(['action']);
  expect(session.declaration.parameters.properties).toMatchObject({
    action: { enum: ['list', 'status', 'read', 'input', 'stop'] },
    cursor: { type: 'integer', minimum: 0 },
    maxChars: { maximum: 256000 },
  });
  for (const tool of [run, session]) {
    expect(tool.declaration.parameters.additionalProperties).toBe(false);
    expect(tool.declaration.parameters.properties).not.toHaveProperty('actorId');
  }
  expect(session.declaration.description).toContain('UTF-16');
  expect(session.effects({ action: 'input' })).toEqual(['process_execute', 'high_risk']);
  expect((session.parallelRead as Function)({ action: 'input' })).toBe(false);
});

test.each([
  { exitCode: 7, success: false },
  { exitCode: -1, success: false },
  { exitCode: 0, success: true },
  { exitCode: null, success: true },
])('进程终态 $exitCode 保留输出和游标，明确失败摘要', async ({ exitCode, success }) => {
  const { records, session } = fixture();
  records.set('terminal-records:session', {
    id: 'session',
    actorId: 'actor',
    conversationId: 'conversation',
    workspaceId: 'workspace',
    status: exitCode === 0 ? 'completed' : 'error',
    data: { mode: 'argv', exitCode },
    outputBuffer: { output: 'diagnostic', outputOffset: 20, truncated: true },
  });
  const result = await session.execute({ action: 'read', taskId: 'session', cursor: 0, maxChars: 4 }, context);
  expect(result.success).toBe(success);
  expect(result.data).toMatchObject({ output: 'diag', outputOffset: 20, nextCursor: 24, hasMore: true, outputLost: true, exitCode });
  if (!success) expect(result).toMatchObject({ code: 'COMMAND_EXIT_NONZERO', error: `Command exited with code ${exitCode}` });
  expect((await session.execute({ action: 'stop', taskId: 'session' }, context)).success).toBe(true);
});

test('真实子进程：cwd、无 Shell 参数、跨 run 输入与增量读取可以完成一轮', async () => {
  const { run, session, terminals } = fixture(true);
  const args = ['a b', '$HOME', 'x|y', '"quotes"', '%PATH%'];
  // 夹具只等待本测试发送的输入，finally 按自己持有的对象收尾，不使用全局 PID 清理。
  const script =
    "process.stdout.write(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }) + '\\n'); process.stdin.once('data', data => { process.stdout.write(data, () => process.exit(0)); });";
  try {
    const started = await run.execute({ mode: 'argv', command: process.execPath, args: ['-e', script, ...args], cwd: 'sub dir' }, context);
    expect(started.success).toBe(true);
    const result = started.data as any;
    const continuation = { ...context, runId: 'run-2' };
    const first = await session.execute({ action: 'read', taskId: result.taskId, cursor: 0 }, continuation);
    expect(first.success).toBe(true);
    let firstRead = first.data as any;
    const startupDeadline = Date.now() + 5000;
    // start 的 300ms 只是首屏等待，不保证繁忙设备已完成 Node 启动；按输出就绪而非固定延迟断言。
    while (!firstRead.output.endsWith('\n') && firstRead.running && Date.now() < startupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const read = await session.execute({ action: 'read', taskId: result.taskId, cursor: 0 }, continuation);
      expect(read.success).toBe(true);
      firstRead = read.data as any;
    }
    expect(JSON.parse(firstRead.output)).toEqual({ cwd: await realpath(path.join(workspace.directory, 'sub dir')), args });
    expect((await session.execute({ action: 'input', taskId: result.taskId, text: '输入😀\n' }, continuation)).success).toBe(true);
    let final = firstRead;
    const deadline = Date.now() + 5000;
    while (final.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const read = await session.execute({ action: 'read', taskId: result.taskId, cursor: firstRead.nextCursor }, continuation);
      expect(read.success).toBe(true);
      final = read.data as any;
    }
    expect(final).toMatchObject({ output: '输入😀\n', exitCode: 0, running: false, outputLost: false, hasMore: false });
    expect(await session.execute({ action: 'input', taskId: result.taskId, text: 'late' }, continuation)).toMatchObject({
      success: false,
      code: 'EXITED',
    });
  } finally {
    await terminals.close();
  }
});

test.each([0, 600])('真实非零退出（延迟 %dms）在初次或续读结果标记失败且仍可跨 run 续读', async (delay) => {
  const { run, session, terminals } = fixture(true);
  try {
    let result = await run.execute(
      {
        mode: 'argv',
        command: process.execPath,
        args: ['-e', `setTimeout(() => { console.error('fixture failure'); process.exitCode = 7; }, ${delay})`],
      },
      context,
    );
    const deadline = Date.now() + 5000;
    while ((result.data as any).running && Date.now() < deadline) {
      expect(result.success).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      result = await session.execute({ action: 'read', taskId: (result.data as any).taskId }, { ...context, runId: 'continued' });
    }
    expect(result).toMatchObject({
      success: false,
      code: 'COMMAND_EXIT_NONZERO',
      error: 'Command exited with code 7',
      data: { running: false, exitCode: 7, output: expect.stringContaining('fixture failure') },
    });
    const final = result.data as any;
    expect(await session.execute({ action: 'read', taskId: final.taskId, cursor: final.nextCursor }, context)).toMatchObject({
      success: false,
      data: { output: '', nextCursor: final.nextCursor, exitCode: 7 },
    });
  } finally {
    await terminals.close();
  }
});
