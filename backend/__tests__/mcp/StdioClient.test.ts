/**
 * StdioMcpClient 单测
 *
 * 覆盖：
 * - spawn 失败（'error' 事件，如命令不存在）立即拒绝 connect，不再挂满整个超时
 * - stdin 写入同步抛错（流已销毁）立即拒绝，不产生未处理异常
 * - 进程退出时拒绝所有 pending 请求
 * - stderr 缓存 64KB 上限与截断标记
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

function writeTempScript(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stdio-test-'));
    const file = path.join(dir, 'server.js');
    fs.writeFileSync(file, content);
    return file;
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
});
