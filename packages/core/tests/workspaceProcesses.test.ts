import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, type ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import treeKill from 'tree-kill';
import { WorkspaceProcesses, type ProcessOwner } from '../../../apps/server/src/workspace/processes';
import { stopOwnedProcess } from '../../../apps/server/src/workspace/processLifecycle';
import type { RunRecord, StoredRecord, WorkspaceDefinition } from '@graycode/contracts';

jest.mock('cross-spawn', () => jest.fn());
jest.mock('node:child_process', () => ({ ...jest.requireActual('node:child_process'), execFile: jest.fn() }));
jest.mock('tree-kill', () => jest.fn());

function childProcess() {
  const child = Object.assign(new EventEmitter(), { pid: 45678, exitCode: null as number | null,
    signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  return Object.assign(child, { stdio: [child.stdin, child.stdout, child.stderr] }) as unknown as ChildProcess & { stdin: PassThrough };
}

const workspace: WorkspaceDefinition = { id: 'workspace', name: '测试', directory: process.cwd(), deviceId: 'local' };
function storage() {
  const records = new Map<string, unknown>();
  const runs = new Map<string, RunRecord>();
  return { records, runs,
    putRecord: jest.fn(async (record: StoredRecord) => { records.set(record.id, structuredClone(record.value)); }),
    getRecord: jest.fn(async (_namespace: string, id: string) => records.get(id) ?? null),
    getRun: jest.fn(async (id: string) => runs.get(id) ?? null) };
}

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { jest.useRealTimers(); });

test('完成命令释放活动对象和输出监听，结果仍可查询和恢复', async () => {
  const saved = storage(); const processes = new WorkspaceProcesses(saved);
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) {
    const child = childProcess(); (crossSpawn as unknown as jest.Mock).mockReturnValueOnce(child);
    const result = processes.start(workspace, 'task', 'fixture', []);
    child.stdout!.emit('data', Buffer.from('输出-' + i)); Object.assign(child, { exitCode: 0 }); child.emit('close', 0);
    ids.push((await result).id);
    expect(child.stdout!.listenerCount('data')).toBe(0);
    expect(child.stderr!.listenerCount('data')).toBe(0);
  }
  expect((processes as unknown as { entries: Map<string, unknown> }).entries.size).toBe(0);
  expect(await processes.read(ids[0], 'task')).toMatchObject({ running: false, output: '输出-0', exitCode: 0 });
  expect(await new WorkspaceProcesses(saved).read(ids[39], 'task')).toMatchObject({ output: '输出-39' });
  await processes.stop(ids[0], 'task');
  await processes.close();
});

test('启动失败保留错误输出和退出状态', async () => {
  const processes = new WorkspaceProcesses(storage()); const child = childProcess();
  (crossSpawn as unknown as jest.Mock).mockReturnValueOnce(child);
  const pending = processes.start(workspace, 'task', 'missing-program', []);
  child.emit('error', new Error('找不到可执行文件')); child.emit('close', null);
  expect(await pending).toMatchObject({ exitCode: -1, running: false, output: '找不到可执行文件' });
});

test('输入等待管道写入完成，异步写入失败会返回给调用方', async () => {
  const { processes, child, result } = await running(modelOwner);
  jest.useRealTimers();
  let acknowledge!: (error?: Error | null) => void;
  child.stdin._write = (_chunk, _encoding, callback) => { acknowledge = callback; };
  // 观察真实 Writable 的异步 error，断言之外也避免失败版本终止整个 Jest 工作进程。
  const errors: Error[] = [];
  child.stdin.on('error', error => errors.push(error));
  let settled = false;
  const write = processes.input(result.id, modelOwner, 'hello');
  void write.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  const settledBeforeWrite = settled;
  const rejected = expect(write).rejects.toThrow('EPIPE');
  acknowledge(new Error('EPIPE: pipe closed'));
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  expect(settledBeforeWrite).toBe(false);
  expect(errors).toHaveLength(1);
  expect(await processes.read(result.id, modelOwner)).toMatchObject({ running: true });
  child.emit('close', 0);
  await processes.close();
});

test('进程仍在运行但输入管道已关闭时拒绝输入，管道错误不会成为未处理异常', async () => {
  const { processes, child, result } = await running(modelOwner);
  expect(() => child.stdin.emit('error', new Error('EPIPE: pipe closed'))).not.toThrow();
  child.stdin.destroy();
  await expect(processes.input(result.id, modelOwner, 'hello')).rejects.toThrow('输入');
  expect(await processes.read(result.id, modelOwner)).toMatchObject({ running: true });
  child.emit('close', 0);
  await processes.close();
});

test('跨 stdout/stderr 字节块的 UTF-8 中文和 emoji 不产生替换字符', async () => {
  const processes = new WorkspaceProcesses(storage()); const child = childProcess();
  (crossSpawn as unknown as jest.Mock).mockReturnValueOnce(child);
  const pending = processes.start(workspace, 'task', 'fixture', []);
  const stdout = Buffer.from('中文😀'); const stderr = Buffer.from('错误');
  child.stdout!.emit('data', stdout.subarray(0, 1));
  child.stderr!.emit('data', stderr.subarray(0, 2));
  child.stdout!.emit('data', stdout.subarray(1, 8));
  child.stderr!.emit('data', stderr.subarray(2));
  child.stdout!.emit('data', stdout.subarray(8));
  child.emit('close', 0);
  expect((await pending).output).toBe('中文错误😀');
});

function termination(callback: (child: ChildProcess, done: (error?: Error) => void) => void, child: ChildProcess) {
  (execFile as unknown as jest.Mock).mockImplementation((_command, _args, _options, done) => { callback(child, done); });
  (treeKill as unknown as jest.Mock).mockImplementation((_pid, _signal, done) => { callback(child, done); });
}

test('终止命令非零退出直接报告失败，清理等待器并允许重试', async () => {
  const child = childProcess();
  termination((_child, done) => done(new Error('终止失败')), child);
  await expect(stopOwnedProcess(child)).rejects.toThrow('终止失败');
  expect(child.listenerCount('close')).toBe(0);
  termination((current, done) => { Object.assign(current, { exitCode: 0 }); current.emit('close', 0); done(); }, child);
  await expect(stopOwnedProcess(child)).resolves.toBeUndefined();
});

test('终止命令返回成功而目标不退出时，有明确截止时间', async () => {
  jest.useFakeTimers(); const child = childProcess();
  termination((_child, done) => done(), child);
  const stopped = stopOwnedProcess(child);
  const assertion = expect(stopped).rejects.toThrow('受管进程未能退出');
  await jest.advanceTimersByTimeAsync(7000);
  await assertion;
  expect(child.listenerCount('close')).toBe(0);
});

const modelOwner = { actorId: 'actor', conversationId: 'conversation', runId: 'run-1', workspaceId: workspace.id };

async function completed(owner: ProcessOwner, output = 'done', saved = storage()) {
  const processes = new WorkspaceProcesses(saved); const child = childProcess();
  (crossSpawn as unknown as jest.Mock).mockReturnValueOnce(child);
  const pending = processes.start(workspace, owner, 'fixture', []);
  child.stdout!.emit('data', Buffer.from(output)); child.emit('close', 0);
  return { processes, child, saved, result: await pending };
}

async function running(owner: ProcessOwner) {
  jest.useFakeTimers();
  const saved = storage(); const processes = new WorkspaceProcesses(saved); const child = childProcess();
  (crossSpawn as unknown as jest.Mock).mockReturnValueOnce(child);
  const pending = processes.start(workspace, owner, 'fixture', []);
  await jest.advanceTimersByTimeAsync(300);
  return { processes, child, saved, result: await pending };
}

function successfulTermination(child: ChildProcess) {
  termination((current, done) => { Object.assign(current, { exitCode: 0 }); current.emit('close', 0); done(); }, child);
}

test('模型同账号同对话同工作区跨 run 可读写和停止，落盘及重建后仍可读', async () => {
  const { processes, child, saved, result } = await running(modelOwner);
  const continuation = { ...modelOwner, runId: 'run-2' };
  child.stdout!.emit('data', Buffer.from('hello'));
  expect(await processes.read(result.id, continuation)).toMatchObject({ running: true, output: 'hello' });
  await processes.input(result.id, continuation, '输入原文 | $HOME');
  expect(child.stdin!.read().toString()).toBe('输入原文 | $HOME');
  successfulTermination(child);
  await processes.stop(result.id, continuation);
  expect(processes.activeCount).toBe(0);
  expect(await new WorkspaceProcesses(saved).read(result.id, continuation)).toMatchObject({ output: 'hello', running: false });
  expect(saved.getRun).not.toHaveBeenCalled();
  if (process.platform === 'win32') expect(execFile).toHaveBeenCalledWith(expect.any(String), ['/PID', '45678', '/T', '/F'], expect.any(Object), expect.any(Function));
  else expect(treeKill).toHaveBeenCalledWith(45678, 'SIGTERM', expect.any(Function));
});

test.each([
  { ...modelOwner, actorId: 'other-actor' },
  { ...modelOwner, conversationId: 'other-conversation' },
  { ...modelOwner, workspaceId: 'other-workspace' },
  { ...modelOwner, workspaceId: undefined },
  'run-1',
])('活动和完成命令拒绝跨身份访问 %j', async owner => {
  const { processes, child, saved, result } = await running(modelOwner);
  for (const read of [processes, new WorkspaceProcesses(saved)]) {
    // 第二次读取模拟宿主重建，只能从带明确 owner 的完成记录授权。
    if (read !== processes) { child.emit('close', 0); await processes.read(result.id, modelOwner); }
    await expect(read.read(result.id, owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(read.input(result.id, owner, 'x')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(read.stop(result.id, owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }
  expect(child.stdin!.read()).toBeNull();
  expect(execFile).not.toHaveBeenCalled(); expect(treeKill).not.toHaveBeenCalled();
});

test('RPC string 只允许原 client，不能被同名模型 run 认领', async () => {
  const { processes, child, saved, result } = await running('run-1');
  saved.runs.set('run-1', { id: 'run-1', ...modelOwner } as unknown as RunRecord);
  await expect(processes.read(result.id, 'client-2')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(processes.read(result.id, modelOwner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await processes.input(result.id, 'run-1', 'ok');
  expect(child.stdin!.read().toString()).toBe('ok');
  child.emit('close', 0);
  expect(await processes.read(result.id, 'run-1')).toMatchObject({ running: false });
  await expect(new WorkspaceProcesses(saved).read(result.id, modelOwner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(processes.input(result.id, 'run-1', 'late')).rejects.toMatchObject({ code: 'EXITED' });
  expect(saved.getRun).not.toHaveBeenCalled();
});

test('没有 conversation 时退回原 run，仍保留账号和工作区隔离', async () => {
  const owner = { ...modelOwner, conversationId: undefined };
  const { processes, result } = await completed(owner);
  expect(await processes.read(result.id, { ...owner })).toMatchObject({ output: 'done' });
  for (const forbidden of [{ ...owner, runId: 'run-2' }, { ...owner, actorId: 'other' }, { ...owner, workspaceId: undefined }])
    await expect(processes.read(result.id, forbidden)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('旧 runId 记录只通过可信 getRun 核验兼容，并把缺失 outputOffset 规范化为零', async () => {
  const saved = storage();
  saved.records.set('legacy', { id: 'legacy', ownerId: modelOwner.runId, output: 'old', truncated: true, running: false, exitCode: 0 });
  const processes = new WorkspaceProcesses(saved);
  await expect(processes.read('legacy', modelOwner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  saved.runs.set(modelOwner.runId, { id: modelOwner.runId, ...modelOwner } as unknown as RunRecord);
  const continuation = { ...modelOwner, runId: 'run-2' };
  expect(await processes.read('legacy', continuation, { cursor: 1, maxChars: 1 })).toMatchObject({
    output: 'l', outputOffset: 1, nextCursor: 2, hasMore: true, outputLost: false, truncated: true,
  });
  for (const owner of [{ ...continuation, actorId: 'other' }, { ...continuation, conversationId: 'other' },
    { ...continuation, workspaceId: 'other' }, { ...continuation, conversationId: undefined }])
    await expect(processes.read('legacy', owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(processes.input('legacy', continuation, 'late')).rejects.toMatchObject({ code: 'EXITED' });
  await expect(processes.stop('legacy', continuation)).resolves.toBeUndefined();
  expect(execFile).not.toHaveBeenCalled(); expect(treeKill).not.toHaveBeenCalled();
  expect(saved.getRun).toHaveBeenCalledWith(modelOwner.runId);
  // 旧 RPC 记录保持精确 client 比较，不要求其 ownerId 是有效运行。
  saved.records.set('legacy-client', { id: 'legacy-client', ownerId: 'rpc-client', output: '', truncated: false, running: false, exitCode: 0 });
  await expect(processes.read('legacy-client', 'rpc-client')).resolves.toMatchObject({ nextCursor: 0 });
  await expect(processes.read('legacy-client', 'other-client')).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('未知 id 与已退出命令的 input 返回不同错误，stop 完成命令幂等且不终止其他 PID', async () => {
  const { processes, result } = await completed(modelOwner);
  await expect(processes.read('missing', modelOwner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(processes.input('missing', modelOwner, 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(processes.stop('missing', modelOwner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  await expect(processes.input(result.id, modelOwner, 'late')).rejects.toMatchObject({ code: 'EXITED' });
  await processes.stop(result.id, modelOwner);
  expect(execFile).not.toHaveBeenCalled(); expect(treeKill).not.toHaveBeenCalled();
});

test('只收到 exit 尚未 close 时也不能继续 input，close 按原对象归属收尾', async () => {
  const { processes, child, result } = await running(modelOwner);
  Object.assign(child, { exitCode: 0 });
  await expect(processes.input(result.id, modelOwner, 'late')).rejects.toMatchObject({ code: 'EXITED' });
  child.emit('close', 0); await processes.close();
  expect(processes.activeCount).toBe(0);
});

test('read 用 UTF-16 绝对位置增量读取，省略选项仍返回全部，恰好尾部没有 hasMore', async () => {
  const { processes, child, result } = await running(modelOwner);
  child.stdout!.emit('data', Buffer.from('A😀中B'));
  const first = await processes.read(result.id, modelOwner, { cursor: 0, maxChars: 3 });
  expect(first).toMatchObject({ output: 'A😀', outputOffset: 0, nextCursor: 3, hasMore: true, outputLost: false });
  const second = await processes.read(result.id, modelOwner, { cursor: first.nextCursor, maxChars: 2 });
  expect(second).toMatchObject({ output: '中B', outputOffset: 3, nextCursor: 5, hasMore: false });
  expect(await processes.read(result.id, modelOwner, { cursor: second.nextCursor })).toMatchObject({ output: '', nextCursor: 5, hasMore: false });
  child.stdout!.emit('data', Buffer.from('新'));
  expect(await processes.read(result.id, modelOwner, { cursor: second.nextCursor })).toMatchObject({ output: '新', outputOffset: 5, nextCursor: 6 });
  expect(await processes.read(result.id, modelOwner)).toMatchObject({ output: 'A😀中B新', outputOffset: 0, nextCursor: 6 });
  child.emit('close', 0); await processes.close();
});

test('环形保留区和落盘后的游标保持绝对位置，过期游标显式报告丢失', async () => {
  const { processes, child, saved, result } = await running(modelOwner);
  child.stdout!.emit('data', Buffer.from('x'.repeat(256005)));
  expect(await processes.read(result.id, modelOwner, { cursor: 0, maxChars: 2 })).toMatchObject({
    output: 'xx', outputOffset: 5, nextCursor: 7, hasMore: true, outputLost: true, truncated: true,
  });
  expect(await processes.read(result.id, modelOwner, { cursor: 256005 })).toMatchObject({ output: '', nextCursor: 256005, hasMore: false, outputLost: false });
  child.stdout!.emit('data', Buffer.from('tail')); child.emit('close', 0);
  await processes.read(result.id, modelOwner);
  const restored = new WorkspaceProcesses(saved);
  const full = await restored.read(result.id, modelOwner);
  expect(full).toMatchObject({ outputOffset: 9, nextCursor: 256009, hasMore: false, outputLost: false });
  expect(full.output).toHaveLength(256000);
  expect(await restored.read(result.id, modelOwner, { cursor: 7, maxChars: 2 })).toMatchObject({ outputOffset: 9, nextCursor: 11, outputLost: true });
  expect(await restored.read(result.id, modelOwner, { cursor: 256005 })).toMatchObject({ output: 'tail', nextCursor: 256009, hasMore: false });
});

test.each([
  { cursor: -1 }, { cursor: 0.5 }, { cursor: Infinity }, { cursor: '1' }, { cursor: null }, { cursor: 5 },
  { maxChars: 0 }, { maxChars: 0.5 }, { maxChars: 256001 }, { maxChars: '1' }, { maxChars: null },
])('拒绝未来或无效读取选项 %j', async options => {
  const { processes, result } = await completed(modelOwner);
  await expect(processes.read(result.id, modelOwner, options as any)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
});

test('可选 cwd 保持旧 start 签名和 shell:false，args 不展开或重写', async () => {
  const processes = new WorkspaceProcesses(storage()); const first = childProcess(); const second = childProcess();
  (crossSpawn as unknown as jest.Mock).mockReturnValueOnce(first).mockReturnValueOnce(second);
  const args = ['a b', '$HOME', 'x|y', '"quoted"', '%PATH%'];
  const original = processes.start(workspace, 'client', 'fixture', args);
  first.emit('close', 0); await original;
  expect(crossSpawn).toHaveBeenNthCalledWith(1, 'fixture', args, expect.objectContaining({ cwd: workspace.directory, shell: false }));
  const custom = processes.start(workspace, modelOwner, 'fixture', args, undefined, { cwd: 'authorized-directory' });
  second.emit('close', 0); await custom;
  expect(crossSpawn).toHaveBeenNthCalledWith(2, 'fixture', args, expect.objectContaining({ cwd: 'authorized-directory', shell: false }));
  expect((crossSpawn as unknown as jest.Mock).mock.calls[1][1]).toBe(args);
});

test('宿主 close 保留模型和 RPC 两种原 owner 并停止自己持有的所有进程', async () => {
  jest.useFakeTimers(); const processes = new WorkspaceProcesses(storage());
  const first = childProcess(); const second = childProcess();
  (crossSpawn as unknown as jest.Mock).mockReturnValueOnce(first).mockReturnValueOnce(second);
  const starts = [processes.start(workspace, 'client', 'fixture', []), processes.start(workspace, modelOwner, 'fixture', [])];
  await jest.advanceTimersByTimeAsync(300); const results = await Promise.all(starts);
  // 两个 mock 子进程使用相同示例 PID，但停止必须仍按持有对象分别等待关闭。
  const terminate = (_pid: unknown, _signal: unknown, done: (error?: Error) => void) => {
    const child = first.exitCode === null ? first : second;
    Object.assign(child, { exitCode: 0 }); child.emit('close', 0); done();
  };
  (treeKill as unknown as jest.Mock).mockImplementation(terminate);
  (execFile as unknown as jest.Mock).mockImplementation((_command, _args, _options, done) => terminate(undefined, undefined, done));
  await processes.close();
  expect(processes.activeCount).toBe(0);
  expect(await processes.read(results[0].id, 'client')).toMatchObject({ running: false });
  expect(await processes.read(results[1].id, modelOwner)).toMatchObject({ running: false });
  await expect(processes.start(workspace, 'client', 'fixture', [])).rejects.toThrow('宿主正在关闭');
});

test('关闭保留停止失败的受管对象并返回错误，允许下一次关闭重试', async () => {
  const { processes, child } = await running(modelOwner);
  termination((_child, done) => done(new Error('fixture kill failure')), child);
  await expect(processes.close()).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'fixture kill failure' })] });
  expect(processes.activeCount).toBe(1);
  successfulTermination(child);
  await processes.close();
  expect(processes.activeCount).toBe(0);
});

test('退出结果保存失败后可重试保存，并发关闭不会重新停止进程或重复写入', async () => {
  const saved = storage();
  const failure = new Error('fixture storage unavailable');
  saved.putRecord.mockRejectedValueOnce(failure);
  const logging = jest.spyOn(console, 'error').mockImplementation(() => {});
  const changed: number[] = [];
  const processes = new WorkspaceProcesses(saved, () => changed.push(processes.activeCount));
  const child = childProcess(); (crossSpawn as unknown as jest.Mock).mockReturnValueOnce(child);
  try {
    const pending = processes.start(workspace, modelOwner, 'fixture', []);
    child.stdout!.emit('data', Buffer.from('finished output')); child.emit('close', 0);
    await expect(pending).rejects.toBe(failure);
    await Promise.all([processes.close(), processes.close()]);
    expect(saved.putRecord).toHaveBeenCalledTimes(2);
    expect((await processes.read([...saved.records.keys()][0], modelOwner)).output).toBe('finished output');
    expect(execFile).not.toHaveBeenCalled(); expect(treeKill).not.toHaveBeenCalled();
    expect(changed).toEqual([1, 0]);
  } finally { logging.mockRestore(); await processes.close(); }
});
