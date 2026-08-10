/**
 * StdioMcpClient 单测
 *
 * 覆盖：
 * - spawn 失败（'error' 事件，如命令不存在）立即拒绝 connect，不再挂满整个超时
 * - stdin 写入同步抛错（流已销毁）立即拒绝，不产生未处理异常
 * - 进程退出时拒绝所有 pending 请求
 * - stderr 缓存 64KB 上限与截断标记
 * - 参数边界保留、Windows .cmd/.bat/PATHEXT 命令转义与安全 spawn 配置
 * - 正常 connect 流程（真实子进程）
 */
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StdioMcpClient } from '../../modules/mcp/StdioClient';

// 直接使用 require 拿到可写的 child_process 对象（import * as 的命名空间对象不可被 spyOn 改写）
const childProcess = require('child_process') as typeof import('child_process');

function createFakeProcess(overrides: { stdinWrite?: () => void } = {}) {
    const proc: any = new EventEmitter();
    proc.pid = 4242;
    proc.exitCode = null;
    proc.signalCode = null;
    proc.stdin = new PassThrough();
    if (overrides.stdinWrite) {
        proc.stdin.write = overrides.stdinWrite;
    }
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    return proc;
}

/**
 * 创建能对 initialize / tools/call 等请求自动响应的假进程。
 * respondToCallTool 为 false 时，tools/call 请求不响应（用于验证外部中止路径）。
 */
function createFakeProcessWithResponder(respondToCallTool = true) {
    const proc = createFakeProcess();
    proc.stdin.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (!line) return;
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        let result: any;
        if (msg.method === 'initialize') {
            result = {
                protocolVersion: '2024-11-05',
                serverInfo: { name: 'fake', version: '1.0.0' },
                capabilities: {},
            };
        } else if (msg.method === 'tools/call' && respondToCallTool) {
            result = { content: [{ type: 'text', text: 'ok' }] };
        } else {
            return; // 其他请求不响应
        }
        proc.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    });
    return proc;
}

function writeTempScript(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-test-'));
    const file = path.join(dir, 'server.js');
    fs.writeFileSync(file, content);
    return file;
}

function writeWindowsLauncher(scriptFile: string, extension: 'cmd' | 'bat'): string {
    const launcher = path.join(path.dirname(scriptFile), `MCP launcher.${extension}`);
    fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${scriptFile}" %*\r\n`);
    return launcher;
}

describe('StdioMcpClient', () => {
    let spawnSpy: jest.SpyInstance | undefined;

    afterEach(() => {
        if (spawnSpy) {
            spawnSpy.mockRestore();
            spawnSpy = undefined;
        }
    });

    // ==================== spawn 失败立即失败（不再挂满超时） ====================

    it('should reject connect immediately when spawn emits error (ENOENT)', async () => {
        const fake = createFakeProcess();
        spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue(fake as any);

        const client = new StdioMcpClient('missing_cmd', [], undefined, undefined, 30000);
        // 防止未处理的 'error' 事件（生产环境由 McpManager 监听）
        client.on('error', () => {});

        const startedAt = Date.now();
        const connectPromise = client.connect();
        fake.emit('error', new Error('spawn ENOENT'));

        await expect(connectPromise).rejects.toThrow(/Process error: spawn ENOENT/);
        // 远小于 30s 超时，证明没有挂满超时
        expect(Date.now() - startedAt).toBeLessThan(5000);
    });

    it('should reject connect when stdin.write throws synchronously (dead process)', async () => {
        const fake = createFakeProcess({
            stdinWrite: () => {
                throw new Error('write after destroy');
            },
        });
        spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue(fake as any);

        const client = new StdioMcpClient('node', [], undefined, undefined, 30000);
        client.on('error', () => {});

        await expect(client.connect()).rejects.toThrow('write after destroy');
    });

    it('should reject pending requests when the process exits', async () => {
        const fake = createFakeProcess();
        spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue(fake as any);

        const client = new StdioMcpClient('node', [], undefined, undefined, 30000);
        client.on('error', () => {});

        const connectPromise = client.connect();
        fake.emit('exit', 1, null);

        await expect(connectPromise).rejects.toThrow(/Connection closed/);

        // 进程已清理，后续请求立即失败（而不是挂起）
        await expect(client.callTool('t', {})).rejects.toThrow(/Process not started/);
    });

    // ==================== 安全进程启动 ====================

    it('should preserve executable argv boundaries with shell disabled', async () => {
        const fake = createFakeProcessWithResponder();
        spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue(fake as any);
        const args = [
            'C:\\Program Files\\MCP server\\index.js',
            '--label=a b',
            'x&whoami',
        ];

        const client = new StdioMcpClient(process.execPath, args, undefined, undefined, 30000);
        client.on('error', () => {});
        await client.connect();

        expect(spawnSpy).toHaveBeenCalledTimes(1);
        const [spawnedCommand, spawnedArgs, options] = spawnSpy.mock.calls[0];
        expect(path.resolve(spawnedCommand)).toBe(path.resolve(process.execPath));
        expect(spawnedArgs).toEqual(args);
        expect(options).toEqual(expect.objectContaining({
            shell: false,
            windowsHide: true,
        }));
    });

    (process.platform === 'win32' ? it : it.skip)(
        'should resolve an npx.cmd command and escape cmd metacharacters',
        async () => {
            const fake = createFakeProcessWithResponder();
            spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue(fake as any);
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-npx-path-'));
            fs.writeFileSync(path.join(tempDir, 'npx.cmd'), '@echo off\r\n');
            const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') || 'Path';
            const args = ['value with spaces', 'x&whoami', '100%literal'];

            try {
                const client = new StdioMcpClient('npx', args, { [pathKey]: tempDir }, undefined, 30000);
                client.on('error', () => {});
                await client.connect();

                expect(spawnSpy).toHaveBeenCalledTimes(1);
                const [spawnedCommand, spawnedArgs, options] = spawnSpy.mock.calls[0];
                expect(path.basename(spawnedCommand).toLowerCase()).toBe('cmd.exe');
                expect(spawnedArgs.slice(0, 3)).toEqual(['/d', '/s', '/c']);
                expect(spawnedArgs[3]).toContain('^"value^ with^ spaces^"');
                expect(spawnedArgs[3]).toContain('x^&whoami');
                expect(spawnedArgs[3]).toContain('100^%literal');
                expect(options).toEqual(expect.objectContaining({
                    shell: false,
                    windowsVerbatimArguments: true,
                }));
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        }
    );

    (process.platform === 'win32' ? it.each(['cmd', 'bat'] as const) : it.skip.each(['cmd', 'bat'] as const))(
        'should preserve real argv semantics through a launcher with spaces (.%s)',
        async (extension) => {
            const script = `
                const receivedArgs = process.argv.slice(2);
                process.stdin.setEncoding('utf8');
                let buf = '';
                process.stdin.on('data', (d) => {
                    buf += d;
                    let idx;
                    while ((idx = buf.indexOf('\\n')) !== -1) {
                        const line = buf.slice(0, idx).trim();
                        buf = buf.slice(idx + 1);
                        if (!line) continue;
                        let msg;
                        try { msg = JSON.parse(line); } catch { continue; }
                        if (msg.method === 'initialize') {
                            process.stdout.write(JSON.stringify({
                                jsonrpc: '2.0',
                                id: msg.id,
                                result: {
                                    protocolVersion: '2024-11-05',
                                    serverInfo: { name: JSON.stringify(receivedArgs), version: '1.0.0' },
                                    capabilities: {}
                                }
                            }) + '\\n');
                        }
                    }
                });
            `;
            const scriptFile = writeTempScript(script);
            const launcher = writeWindowsLauncher(scriptFile, extension);
            const args = ['value with spaces', 'x&echo INJECTED', 'plain-value'];

            const client = new StdioMcpClient(launcher, args, undefined, undefined, 5000);
            client.on('error', () => {});
            try {
                await client.connect();
                expect(JSON.parse(client.getServerInfo()!.name)).toEqual(args);
            } finally {
                await client.disconnect();
                fs.rmSync(path.dirname(scriptFile), { recursive: true, force: true });
            }
        }
    );

    // ==================== stderr 64KB 上限 ====================

    it('should cap stderr output at 64KB and mark truncated', async () => {
        const script = `
            process.stderr.write('A'.repeat(200 * 1024));
            setInterval(() => { process.stderr.write('B'.repeat(1024)); }, 5);
            setTimeout(() => {
                process.stdin.setEncoding('utf8');
                let buf = '';
                process.stdin.on('data', (d) => {
                    buf += d;
                    let idx;
                    while ((idx = buf.indexOf('\\n')) !== -1) {
                        const line = buf.slice(0, idx).trim();
                        buf = buf.slice(idx + 1);
                        if (!line) continue;
                        let msg;
                        try { msg = JSON.parse(line); } catch { continue; }
                        if (msg.method === 'initialize') {
                            process.stdout.write(JSON.stringify({
                                jsonrpc: '2.0',
                                id: msg.id,
                                result: {
                                    protocolVersion: '2024-11-05',
                                    serverInfo: { name: 'fake', version: '1.0.0' },
                                    capabilities: {}
                                }
                            }) + '\\n');
                        }
                    }
                });
            }, 300);
        `;
        const scriptFile = writeTempScript(script);

        const client = new StdioMcpClient('node', [scriptFile], undefined, undefined, 5000);
        client.on('error', () => {});
        await client.connect();

        // 等待剩余的 stderr 数据事件送达
        await new Promise(resolve => setTimeout(resolve, 150));

        const anyClient = client as any;
        expect(anyClient.stderrOutput.length).toBeLessThanOrEqual(64 * 1024);
        expect(anyClient.stderrTruncated).toBe(true);

        await client.disconnect();
        fs.rmSync(path.dirname(scriptFile), { recursive: true, force: true });
    });

    // ==================== 正常 connect（真实子进程） ====================

    it('should connect, initialize and list tools with a real child process', async () => {
        const script = `
            process.stdin.setEncoding('utf8');
            let buf = '';
            process.stdin.on('data', (d) => {
                buf += d;
                let idx;
                while ((idx = buf.indexOf('\\n')) !== -1) {
                    const line = buf.slice(0, idx).trim();
                    buf = buf.slice(idx + 1);
                    if (!line) continue;
                    let msg;
                    try { msg = JSON.parse(line); } catch { continue; }
                    if (msg.method === 'initialize') {
                        process.stdout.write(JSON.stringify({
                            jsonrpc: '2.0',
                            id: msg.id,
                            result: {
                                protocolVersion: '2024-11-05',
                                serverInfo: { name: 'fake', version: '1.0.0' },
                                capabilities: { tools: { listChanged: false } }
                            }
                        }) + '\\n');
                    } else if (msg.method === 'tools/list') {
                        process.stdout.write(JSON.stringify({
                            jsonrpc: '2.0',
                            id: msg.id,
                            result: { tools: [{ name: 't1', inputSchema: { type: 'object' } }] }
                        }) + '\\n');
                    }
                }
            });
        `;
        const scriptFile = writeTempScript(script);

        const client = new StdioMcpClient('node', [scriptFile], undefined, undefined, 5000);
        client.on('error', () => {});
        await client.connect();

        expect(client.getProtocolVersion()).toBe('2024-11-05');
        expect(client.getServerInfo()).toEqual({ name: 'fake', version: '1.0.0' });
        expect(client.getTools()).toEqual([
            expect.objectContaining({ name: 't1' }),
        ]);

        await client.disconnect();
        fs.rmSync(path.dirname(scriptFile), { recursive: true, force: true });
    });

    // ==================== 外部 abort 中止 ====================

    it('should reject the pending request and clean up on external abort', async () => {
        // tools/call 不响应，让请求保持 pending 直到外部中止
        const fake = createFakeProcessWithResponder(false);
        spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue(fake as any);

        const client = new StdioMcpClient('node', [], undefined, undefined, 30000);
        client.on('error', () => {});
        await client.connect();

        const controller = new AbortController();
        const removeSpy = jest.spyOn(controller.signal, 'removeEventListener');
        const exitListenersBefore = fake.listenerCount('exit');

        const pending = client.callTool('t', { a: 1 }, controller.signal);
        await Promise.resolve();
        expect(fake.listenerCount('exit')).toBe(exitListenersBefore + 1);

        controller.abort();

        await expect(pending).rejects.toThrow(/aborted/i);

        // pending 已清理
        expect((client as any).pendingRequests.size).toBe(0);
        // exit 监听已摘除（回到基线）
        expect(fake.listenerCount('exit')).toBe(exitListenersBefore);
        // abort 监听已摘除
        expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('should reject immediately without writing to stdin when the signal is already aborted', async () => {
        const fake = createFakeProcessWithResponder();
        spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue(fake as any);

        const client = new StdioMcpClient('node', [], undefined, undefined, 30000);
        client.on('error', () => {});
        await client.connect();

        const controller = new AbortController();
        controller.abort();
        const writeSpy = jest.spyOn(fake.stdin, 'write');
        const exitListenersBefore = fake.listenerCount('exit');

        await expect(client.callTool('t', {}, controller.signal)).rejects.toThrow(/aborted/i);

        // 已中止的信号不写 stdin、不注册监听、不留 pending
        expect(writeSpy).not.toHaveBeenCalled();
        expect(fake.listenerCount('exit')).toBe(exitListenersBefore);
        expect((client as any).pendingRequests.size).toBe(0);
    });

    it('should remove abort/exit listeners after a successful resolve (no leak)', async () => {
        const fake = createFakeProcessWithResponder();
        spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue(fake as any);

        const client = new StdioMcpClient('node', [], undefined, undefined, 30000);
        client.on('error', () => {});
        await client.connect();

        const controller = new AbortController();
        const signal = controller.signal;
        const addSpy = jest.spyOn(signal, 'addEventListener');
        const removeSpy = jest.spyOn(signal, 'removeEventListener');
        const exitListenersBefore = fake.listenerCount('exit');

        const result = await client.callTool('t', { a: 1 }, signal);
        expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });

        // 所有添加的 abort 监听都已摘除
        const added = addSpy.mock.calls.filter(c => c[0] === 'abort').length;
        const removed = removeSpy.mock.calls.filter(c => c[0] === 'abort').length;
        expect(added).toBeGreaterThanOrEqual(1);
        expect(added).toBe(removed);
        // exit 监听回到基线、pending 无残留
        expect(fake.listenerCount('exit')).toBe(exitListenersBefore);
        expect((client as any).pendingRequests.size).toBe(0);
    });
});
