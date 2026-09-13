import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { DapConnection } from '../../../apps/server/src/development/dapConnection';
import { stopDevelopmentProcess } from '../../../apps/server/src/development/process';
import { fixture } from './fixtures';

test('DAP 分帧按字节处理中文，反向请求不会阻塞响应，断线拒绝未完成请求', async () => {
  const input = new PassThrough(), output = new PassThrough(), connection = new DapConnection(input, output);
  const messages: string[] = []; output.on('data', value => messages.push(value.toString()));
  const send = (message: unknown) => {
    const body = Buffer.from(JSON.stringify(message)), packet = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    for (let index = 0; index < packet.length; index += 3) input.write(packet.subarray(index, index + 3));
  };
  let finishReverse!: (value: unknown) => void;
  connection.reverseRequest = () => new Promise(resolve => { finishReverse = resolve; });
  send({ seq: 10, type: 'request', command: 'startDebugging' }); await Promise.resolve();
  const request = connection.request('evaluate', { expression: '中文变量' });
  send({ seq: 11, type: 'response', request_seq: 1, success: true, body: { result: '结果 🐱' } });
  expect(await request).toEqual({ result: '结果 🐱' });
  finishReverse({}); await Promise.resolve(); await Promise.resolve();
  expect(messages.join('')).toContain('"request_seq":10');
  const pending = connection.request('threads'); const rejected = expect(pending).rejects.toThrow('调试连接已关闭');
  connection.dispose(); await rejected;
});

function expectExited(pid: number) {
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  let failure: unknown;
  try { process.kill(pid, 0); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'ESRCH' });
}
async function fixturePid(directory: string, file: string) {
  const pid = Number((await readFile(path.join(directory, file), 'utf8')).trim());
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true); return pid;
}
async function waitForRunningFixture(directory: string, pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if (Number(await readFile(path.join(directory, 'node.running'), 'utf8')) === pid) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('测试程序尚未进入运行循环。');
}

async function setup() {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data });
  const router = new ApplicationRouter(app), client = { actorId: 'owner', clientId: 'debug-fixture' };
  const snapshot = app.settings.snapshot(); snapshot.settings.workspaces.push({ id: 'debug-project', name: '调试项目', directory: f.root, deviceId: 'local' });
  await app.settings.save({ settings: snapshot.settings, expectedRevision: snapshot.revision });
  const rpc = (method: string, params: Record<string, unknown> = {}, identity = client) => router.call(identity, method, { workspaceId: 'debug-project', ...params }) as Promise<any>;
  const waits = new Set<(error: Error) => void>();
  const session = (predicate: (value: any) => boolean, timeout = 15_000): Promise<any> => {
    const pending = new Promise((resolve, reject) => {
    const observed: any[] = [];
    const cleanup = () => { clearTimeout(timer); off(); waits.delete(cancel); };
    const cancel = (error: Error) => { cleanup(); reject(error); };
    const inspect = (value: any) => {
      observed.push({ id: value.id, status: value.status, reason: value.reason }); if (observed.length > 8) observed.shift();
      if (value.status === 'failed') { cleanup(); reject(new Error(value.error)); }
      else if (predicate(value)) { cleanup(); resolve(value); }
    };
    const off = app.subscribe(event => { if (event.type === 'debug.session') inspect(event.session); });
    const timer = setTimeout(() => { cleanup(); reject(new Error('未收到预期调试状态：' + JSON.stringify(observed))); }, timeout);
    waits.add(cancel);
    for (const value of app.debugging.list(client)) if (!['terminated', 'failed'].includes(value.status)) inspect(value);
    });
    // 启动或控制请求先失败时，等待者仍由用例清理，不能在下一个用例中产生未处理拒绝。
    void pending.catch(() => {}); return pending;
  };
  const close = async () => {
    for (const cancel of waits) cancel(new Error('调试验收已结束。'));
    try { await app.close(); } finally { await f.cleanup(); }
  };
  return { f, app, client, rpc, session, close };
}

test('真实 Node 子会话命中断点、读取变量、执行单步并重启，停止后释放进程', async () => {
  const t = await setup();
  try {
    await writeFile(path.join(t.f.root, '计算.js'), "require('node:fs').writeFileSync(__dirname + '/node.pid', String(process.pid)); function add(a, b) {\n  const result = a + b;\n  return result;\n}\nconst total = add(1, 2);\nconsole.log('结果', total);\nsetInterval(() => { globalThis.tick = (globalThis.tick || 0) + 1; if (globalThis.tick === 1) require('node:fs').writeFileSync(__dirname + '/node.running', String(process.pid)); }, 100);\n");
    await t.rpc('debug.breakpoints.set', { expectedRevision: null, breakpoints: [{ id: 'return', path: '计算.js', line: 3, enabled: true }] });
    const configuration = { id: 'node-launch', name: 'Node 计算', adapterId: 'node', request: 'launch', program: '计算.js', env: { FIXTURE_VALUE: '中文值' } };
    await t.rpc('debug.configurations.save', { expectedRevision: null, configurations: [configuration] });
    const stopped = t.session(value => value.status === 'stopped');
    const root = await t.rpc('debug.start', { configuration }); const target = await stopped;
    const firstPid = await fixturePid(t.f.root, 'node.pid');
    expect(target.parentId).toBe(root.id); expect(target.rootId).toBe(root.id);
    const request = (command: string, args: Record<string, unknown> = {}) => t.rpc('debug.request', { id: target.id, command, arguments: args });
    const stack = await request('stackTrace', { threadId: target.threadId });
    expect(stack.stackFrames[0]).toMatchObject({ name: expect.stringMatching(/(^|\.)add$/), line: 3 });
    const scopes = await request('scopes', { frameId: stack.stackFrames[0].id });
    const variables = await request('variables', { variablesReference: scopes.scopes[0].variablesReference });
    expect(variables.variables).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'result', value: '3' })]));
    expect((await request('evaluate', { frameId: stack.stackFrames[0].id, expression: 'process.env.FIXTURE_VALUE', context: 'watch' })).result).toContain('中文值');
    await expect(t.rpc('debug.snapshot', { id: target.id }, { ...t.client, clientId: 'other-window' })).rejects.toThrow('不属于当前窗口');
    const step = t.session(value => value.id === target.id && value.status === 'stopped' && value.reason === 'step');
    await request('stepOut', { threadId: target.threadId }); await step;
    expect((await t.rpc('debug.snapshot', { id: target.id })).session.status).toBe('stopped');
    await request('continue', { threadId: target.threadId });
    // continue 的响应只确认请求，目标真正进入循环后再验收运行中的暂停。
    await waitForRunningFixture(t.f.root, firstPid);
    // Node 跳过内部代码后可能以 step 原因报告暂停，验证新的停止事件和实际调用栈。
    const paused = t.session(value => value.id === target.id && value.status === 'stopped');
    await request('pause', { threadId: target.threadId }); await paused;
    expect((await request('stackTrace', { threadId: target.threadId })).stackFrames.length).toBeGreaterThan(0);
    const restarted = t.session(value => value.rootId !== root.id && value.status === 'stopped');
    const nextRoot = await t.rpc('debug.restart', { id: root.id }); const next = await restarted;
    expect(next.rootId).toBe(nextRoot.id);
    const nextPid = await fixturePid(t.f.root, 'node.pid'); expect(nextPid).not.toBe(firstPid); expectExited(firstPid);
    await t.rpc('debug.stop', { id: next.id });
    expect((await t.rpc('debug.list')).every((value: any) => value.status === 'terminated')).toBe(true);
    expectExited(nextPid);
    expect((await t.rpc('debug.settings')).configurations).toEqual([configuration]);
    await expect(t.rpc('debug.configurations.save', { expectedRevision: null, configurations: [] })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  } finally { await t.close(); }
}, 40_000);

test('Node 附加使用真实 inspector 端口，分离后保留原进程', async () => {
  const t = await setup(); let target: ReturnType<typeof spawn> | undefined;
  try {
    const file = path.join(t.f.root, '附加.js'); await writeFile(file, 'const value = 42;\nsetInterval(() => {}, 100);\n');
    target = spawn(process.execPath, ['--inspect-brk=0', file], { windowsHide: true, stdio: 'pipe' });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('inspector 未启动')), 5000);
      target!.once('error', reject); target!.stderr!.on('data', value => { const match = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(value.toString()); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
    });
    const stopped = t.session(value => value.status === 'stopped');
    const root = await t.rpc('debug.start', { configuration: { id: 'attach', name: '附加 Node', adapterId: 'node', request: 'attach', port } });
    await stopped; await t.rpc('debug.stop', { id: root.id });
    expect(target.exitCode).toBeNull(); expect(() => process.kill(target!.pid!, 0)).not.toThrow();
  } finally { if (target) await stopDevelopmentProcess(target); await t.close(); }
}, 30_000);

let python = false;
try { execFileSync('python', ['-c', 'import debugpy'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); python = true; } catch { /* CI 未安装 debugpy 时保留明确的外部工具链验收状态。 */ }
(python ? test : test.skip)('真实 Python debugpy 启动、断点、作用域与控制台，停止后释放目标', async () => {
  const t = await setup();
  try {
    await writeFile(path.join(t.f.root, '计算.py'), "import time\ndef add(a, b):\n    result = a + b\n    return result\ntotal = add(2, 3)\nprint('结果', total, flush=True)\nwhile True: time.sleep(0.1)\n");
    await t.rpc('debug.breakpoints.set', { expectedRevision: null, breakpoints: [{ id: 'return', path: '计算.py', line: 4, enabled: true }] });
    const stopped = t.session(value => value.status === 'stopped');
    const root = await t.rpc('debug.start', { configuration: { id: 'python', name: 'Python 计算', adapterId: 'python', request: 'launch', program: '计算.py' } });
    const target = await stopped;
    const request = (command: string, args: Record<string, unknown> = {}) => t.rpc('debug.request', { id: target.id, command, arguments: args });
    const stack = await request('stackTrace', { threadId: target.threadId }); expect(stack.stackFrames[0]).toMatchObject({ name: 'add', line: 4 });
    expect(await request('evaluate', { frameId: stack.stackFrames[0].id, expression: 'result', context: 'repl' })).toMatchObject({ result: '5' });
    const scopes = await request('scopes', { frameId: stack.stackFrames[0].id });
    const variables = await request('variables', { variablesReference: scopes.scopes[0].variablesReference });
    expect(variables.variables).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'result', value: '5' })]));
    await t.rpc('debug.stop', { id: root.id }); expectExited(target.processId);
  } finally { await t.close(); }
}, 30_000);


(python ? test : test.skip)('Python 附加到实际 debugpy 监听端口，分离后保留原进程', async () => {
  const t = await setup(); let processHandle: ReturnType<typeof spawn> | undefined;
  try {
    const file = path.join(t.f.root, 'attach.py');
    await writeFile(file, "import debugpy, time\naddress = debugpy.listen(('127.0.0.1', 0))\nprint(address[1], flush=True)\ndebugpy.wait_for_client()\nvalue = 42\nwhile True: time.sleep(0.1)\n");
    processHandle = spawn('python', [file], { windowsHide: true, stdio: 'pipe' });
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('debugpy 未启动')), 8000);
      processHandle!.once('error', reject);
      processHandle!.stdout!.on('data', bytes => { const value = Number(bytes.toString().trim()); if (value > 0) { clearTimeout(timer); resolve(value); } });
    });
    await t.rpc('debug.breakpoints.set', { expectedRevision: null, breakpoints: [{ id: 'value', path: 'attach.py', line: 5, enabled: true }] });
    const stopped = t.session(value => value.status === 'stopped');
    const root = await t.rpc('debug.start', { configuration: { id: 'attach-python', name: '附加 Python', adapterId: 'python', request: 'attach', port } });
    const target = await stopped;
    const stack = await t.rpc('debug.request', { id: target.id, command: 'stackTrace', arguments: { threadId: target.threadId } });
    expect(stack.stackFrames[0].line).toBe(5);
    await t.rpc('debug.stop', { id: root.id });
    expect(processHandle.exitCode).toBeNull(); expect(() => process.kill(processHandle!.pid!, 0)).not.toThrow();
  } finally { if (processHandle) await stopDevelopmentProcess(processHandle); await t.close(); }
}, 30_000);

test('TypeScript 构建后的 source map 将断点和调用栈映射到原文件', async () => {
  const t = await setup();
  try {
    await writeFile(path.join(t.f.root, 'main.ts'), 'function add(a: number, b: number): number {\n  const result = a + b;\n  return result;\n}\nconst total = add(2, 4);\nconsole.log(total);\n');
    await writeFile(path.join(t.f.root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'CommonJS', outDir: './dist', sourceMap: true, types: [] }, files: ['main.ts'] }));
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(t.f.root, 'tsconfig.json')], { windowsHide: true, stdio: 'pipe', timeout: 15_000 });
    await t.rpc('debug.breakpoints.set', { expectedRevision: null, breakpoints: [{ id: 'return-ts', path: 'main.ts', line: 3, enabled: true }] });
    const stopped = t.session(value => value.status === 'stopped');
    const root = await t.rpc('debug.start', { configuration: { id: 'ts', name: 'TypeScript', adapterId: 'node', request: 'launch', program: 'dist/main.js',
      options: { sourceMaps: true, outFiles: [path.join(t.f.root, 'dist', '**', '*.js')] } } });
    const target = await stopped;
    const stack = await t.rpc('debug.request', { id: target.id, command: 'stackTrace', arguments: { threadId: target.threadId } });
    expect(stack.stackFrames[0].source.path.toLowerCase()).toBe(path.join(t.f.root, 'main.ts').toLowerCase()); expect(stack.stackFrames[0].line).toBe(3);
    await t.rpc('debug.stop', { id: root.id });
  } finally { await t.close(); }
}, 30_000);


test('DAP 终端启动接收标准输入，命中回调断点并在正常结束后释放会话', async () => {
  const t = await setup();
  try {
    await writeFile(path.join(t.f.root, 'input.js'), "const readline = require('node:readline');\nconst reader = readline.createInterface({ input: process.stdin, output: process.stdout });\nreader.question('INPUT: ', (input) => {\n  const result = Number(input) + 1;\n  console.log('RESULT', result);\n  reader.close();\n});\n");
    await t.rpc('debug.breakpoints.set', { expectedRevision: null, breakpoints: [{ id: 'input-result', path: 'input.js', line: 5, enabled: true }] });
    const terminalReady = t.session(value => !!value.terminalId);
    const root = await t.rpc('debug.start', { configuration: { id: 'input', name: '交互输入', adapterId: 'node', request: 'launch', program: 'input.js', options: { console: 'integratedTerminal' } } });
    const terminalSession = await terminalReady;
    const stopped = t.session(value => value.status === 'stopped');
    await t.rpc('terminal.input', { id: terminalSession.terminalId, data: '5\r' });
    const target = await stopped;
    const stack = await t.rpc('debug.request', { id: target.id, command: 'stackTrace', arguments: { threadId: target.threadId } });
    expect(await t.rpc('debug.request', { id: target.id, command: 'evaluate', arguments: { frameId: stack.stackFrames[0].id, expression: 'result', context: 'watch' } })).toMatchObject({ result: '6' });
    const ended = t.session(value => value.id === root.id && value.status === 'terminated');
    await t.rpc('debug.request', { id: target.id, command: 'continue', arguments: { threadId: target.threadId } }); await ended;
    await t.rpc('debug.stop', { id: root.id });
    expect((await t.rpc('terminal.snapshot', { id: terminalSession.terminalId })).status).toBe('exited');
    expectExited((await t.rpc('terminal.snapshot', { id: terminalSession.terminalId })).pid);
  } finally { await t.close(); }
}, 30_000);


test('Node fork 创建真实子会话，根会话停止后回收父子目标', async () => {
  const t = await setup();
  try {
    await writeFile(path.join(t.f.root, 'parent.js'), "require('node:fs').writeFileSync(__dirname + '/parent.pid', String(process.pid)); require('node:child_process').fork(require('node:path').join(__dirname, 'child.js'));\nsetInterval(() => {}, 100);\n");
    await writeFile(path.join(t.f.root, 'child.js'), "require('node:fs').writeFileSync(__dirname + '/child.pid', String(process.pid)); const left = 2;\nconst right = 3;\nconst result = left + right;\nconsole.log(result);\nsetInterval(() => {}, 100);\n");
    await t.rpc('debug.breakpoints.set', { expectedRevision: null, breakpoints: [{ id: 'child', path: 'child.js', line: 4, enabled: true }] });
    const stopped = t.session(value => value.status === 'stopped' && value.name.includes('child.js'));
    const root = await t.rpc('debug.start', { configuration: { id: 'fork', name: '父子进程', adapterId: 'node', request: 'launch', program: 'parent.js' } });
    const child = await stopped; const sessions = await t.rpc('debug.list');
    const parent = sessions.find((value: any) => value.id === child.parentId);
    expect(parent.parentId).toBe(root.id); expect(child.rootId).toBe(root.id);
    const pids = await Promise.all(['parent.pid', 'child.pid'].map(file => fixturePid(t.f.root, file)));
    expect(new Set(pids).size).toBe(2);
    await t.rpc('debug.stop', { id: child.id });
    for (const pid of pids) expectExited(pid);
  } finally { await t.close(); }
}, 30_000);
