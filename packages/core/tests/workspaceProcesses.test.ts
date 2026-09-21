import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, type ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import treeKill from 'tree-kill';
import { WorkspaceProcesses } from '../../../apps/server/src/workspace/processes';
import { stopOwnedProcess } from '../../../apps/server/src/workspace/processLifecycle';
import type { StoredRecord, WorkspaceDefinition } from '@graycode/contracts';

jest.mock('cross-spawn', () => jest.fn());
jest.mock('node:child_process', () => ({ ...jest.requireActual('node:child_process'), execFile: jest.fn() }));
jest.mock('tree-kill', () => jest.fn());

function childProcess() {
  const child = Object.assign(new EventEmitter(), { pid: 45678, exitCode: null as number | null,
    signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  return Object.assign(child, { stdio: [child.stdin, child.stdout, child.stderr] }) as unknown as ChildProcess;
}

const workspace: WorkspaceDefinition = { id: 'workspace', name: '测试', directory: process.cwd(), deviceId: 'local' };
function storage() {
  const records = new Map<string, unknown>();
  return { putRecord: jest.fn(async (record: StoredRecord) => { records.set(record.id, structuredClone(record.value)); }),
    getRecord: jest.fn(async (_namespace: string, id: string) => records.get(id) ?? null) };
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
