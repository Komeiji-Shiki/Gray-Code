/**
 * execute_command 模块 smoke 测试（模块化重构回归网）
 *
 * 覆盖点：
 * - outputDecoder：GBK 回退解码基本路径（utf8 乱码 → gbk 降级）、纯 ASCII 不降级、
 *   输出行数护栏（50000 行上限丢弃旧行并计数）
 * - shellConfig：Windows 下 shell 选择（powershell/cmd/bash/wsl、ComSpec 解析、
 *   自定义路径优先、default → 配置默认 shell）
 * - processRunner handler：cmd /s /c 引号包裹（带空格路径命令）、powershell 参数拼接、
 *   完整执行流（stdout 收集 → close 返回）、GBK 输出经 handler 解码、background 模式、
 *   参数校验错误路径
 *
 * 进程隔离：jest.mock('child_process') 完全 mock spawn/exec/execFile/execSync，
 * 任何用例都不会启动真实进程（CI 安全）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { StringDecoder } from 'string_decoder';
import { TextDecoder } from 'util';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import type { Tool, ToolResult } from '../../tools/types';

let mockSettingsManager: any = null;

jest.mock('../../core/settingsContext', () => ({
    getGlobalSettingsManager: () => mockSettingsManager
}));

jest.mock('child_process', () => ({
    spawn: jest.fn(),
    exec: jest.fn(),
    execFile: jest.fn(),
    execSync: jest.fn()
}));

// 保留真实 getShellConfig 等实现，仅隔离 shell 可用性检测（避免真实 where/which/execSync）
jest.mock('../../tools/terminal/shellConfig', () => {
    const actual = jest.requireActual('../../tools/terminal/shellConfig');
    return {
        ...actual,
        checkShellAvailability: jest.fn(async () => ({ available: true })),
        checkShellAvailabilitySync: jest.fn(() => true)
    };
});

import { decodeWithMode, pushOutputLines, type StreamDecodeMode } from '../../tools/terminal/outputDecoder';
import { getShellConfig } from '../../tools/terminal/shellConfig';
import { createExecuteCommandTool } from '../../tools/terminal/execute_command';
import type { TerminalProcess } from '../../tools/terminal/processRunner';

const spawnMock = jest.mocked(cp.spawn);
const osModule = require('os') as typeof os;

/** Windows 风格 execute_command 配置（跨平台确定：CI 上 process.platform 可能是 linux） */
const WINDOWS_EXEC_CONFIG = {
    defaultShell: 'powershell',
    shells: [
        { type: 'powershell', enabled: true, displayName: 'PowerShell' },
        { type: 'cmd', enabled: true, displayName: 'CMD' },
        { type: 'bash', enabled: true, displayName: 'Bash (Git)' }
    ],
    defaultTimeout: 60000,
    maxOutputLines: 50
};

function useWindowsConfig(): void {
    mockSettingsManager = { getExecuteCommandConfig: () => WINDOWS_EXEC_CONFIG };
}

/** 模拟的 child_process.spawn 返回值：EventEmitter + 可写 stdout/stderr 流 */
class FakeChildProcess extends EventEmitter {
    pid = 4242;
    exitCode: number | null = null;
    killed = false;
    stdout = new PassThrough();
    stderr = new PassThrough();
    kill = jest.fn(() => true);
}

function makeFakeProc(): FakeChildProcess {
    const proc = new FakeChildProcess();
    spawnMock.mockReturnValue(proc as any);
    return proc;
}

function flush(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

let tmpDir: string;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-smoke-'));
    (vscode.workspace as any).workspaceFolders = [
        { name: 'test-ws', index: 0, uri: { fsPath: tmpDir, scheme: 'file' } }
    ];
});

afterAll(() => {
    (vscode.workspace as any).workspaceFolders = [];
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
    mockSettingsManager = null;
    jest.clearAllMocks();
});

describe('outputDecoder：GBK 回退与输出护栏', () => {
    test('GBK 字节触发 utf8 → gbk 自动降级，输出中文', () => {
        const modeRef: { mode: StreamDecodeMode } = { mode: 'utf8' };
        const utf8Decoder = new StringDecoder('utf8');
        const gbkDecoder = new TextDecoder('gbk');
        const chunk = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]); // GBK 编码的「中文」

        const text = decodeWithMode(chunk, modeRef, utf8Decoder, gbkDecoder);

        expect(text).toBe('中文');
        expect(modeRef.mode).toBe('gbk');
    });

    test('纯 ASCII 内容保持 utf8 不降级', () => {
        const modeRef: { mode: StreamDecodeMode } = { mode: 'utf8' };
        const text = decodeWithMode(
            Buffer.from('hello'),
            modeRef,
            new StringDecoder('utf8'),
            new TextDecoder('gbk')
        );
        expect(text).toBe('hello');
        expect(modeRef.mode).toBe('utf8');
    });

    test('pushOutputLines 超过 50000 行丢弃旧行并计数', () => {
        const tp: TerminalProcess = {
            id: 't1', command: 'x', cwd: '/', shell: 'cmd',
            process: {} as any, output: [], startTime: 0
        };
        const lines = Array.from({ length: 50010 }, (_, i) => `line-${i}`);
        pushOutputLines(tp, lines);

        expect(tp.output).toHaveLength(50000);
        expect(tp.output[0]).toBe('line-10');
        expect(tp.omittedOutputLines).toBe(10);
    });
});

describe('shellConfig：Windows shell 选择', () => {
    let platformSpy: jest.SpyInstance;

    beforeEach(() => {
        platformSpy = jest.spyOn(osModule, 'platform').mockReturnValue('win32');
        useWindowsConfig();
    });

    afterEach(() => {
        platformSpy.mockRestore();
    });

    test('powershell：powershell.exe + -NoProfile/-ExecutionPolicy/-Command + UTF8 前置命令', () => {
        const cfg = getShellConfig('powershell');
        expect(cfg.shell).toBe('powershell.exe');
        expect(cfg.shellArgs).toEqual(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command']);
        expect(cfg.prependCommand).toContain('$OutputEncoding');
    });

    test('cmd：优先 ComSpec 路径 + /s /c + chcp 65001 前置命令', () => {
        const prev = process.env.ComSpec;
        process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
        try {
            const cfg = getShellConfig('cmd');
            expect(cfg.shell).toBe('C:\\Windows\\System32\\cmd.exe');
            expect(cfg.shellArgs).toEqual(['/s', '/c']);
            expect(cfg.prependCommand).toBe('chcp 65001 >nul &&');
        } finally {
            if (prev === undefined) {
                delete process.env.ComSpec;
            } else {
                process.env.ComSpec = prev;
            }
        }
    });

    test('cmd 自定义路径优先于默认解析', () => {
        mockSettingsManager = {
            getExecuteCommandConfig: () => ({
                ...WINDOWS_EXEC_CONFIG,
                shells: [{ type: 'cmd', enabled: true, displayName: 'CMD', path: 'C:\\tools\\cmd.exe' }]
            })
        };
        const cfg = getShellConfig('cmd');
        expect(cfg.shell).toBe('C:\\tools\\cmd.exe');
    });

    test('default 解析为配置的默认 shell（powershell）', () => {
        const cfg = getShellConfig('default');
        expect(cfg.shell).toBe('powershell.exe');
        expect(cfg.shellArgs).toEqual(expect.arrayContaining(['-Command']));
    });

    test('wsl：wsl.exe -- bash -c', () => {
        const cfg = getShellConfig('wsl');
        expect(cfg.shell).toBe('wsl.exe');
        expect(cfg.shellArgs).toEqual(['--', 'bash', '-c']);
    });
});

describe('handler：spawn 隔离下的参数转义与执行流', () => {
    let platformSpy: jest.SpyInstance;
    let handler: Tool['handler'];
    let toolIdSeq = 0;

    beforeEach(() => {
        platformSpy = jest.spyOn(osModule, 'platform').mockReturnValue('win32');
        useWindowsConfig();
        handler = createExecuteCommandTool().handler;
    });

    afterEach(() => {
        platformSpy.mockRestore();
    });

    function runCommand(args: any): Promise<ToolResult> {
        toolIdSeq += 1;
        return handler(args, { toolId: `tool-${toolIdSeq}`, conversationId: 'conv-1' } as any);
    }

    test('空 command 返回校验错误，不 spawn', async () => {
        const result = await runCommand({});
        expect(result.success).toBe(false);
        expect(result.error).toContain('command is required');
        expect(spawnMock).not.toHaveBeenCalled();
    });

    test('无工作区时返回错误，不 spawn', async () => {
        (vscode.workspace as any).workspaceFolders = [];
        try {
            const result = await runCommand({ command: 'echo hi' });
            expect(result.success).toBe(false);
            expect(result.error).toContain('No workspace folder open');
        } finally {
            (vscode.workspace as any).workspaceFolders = [
                { name: 'test-ws', index: 0, uri: { fsPath: tmpDir, scheme: 'file' } }
            ];
        }
        expect(spawnMock).not.toHaveBeenCalled();
    });

    test('cmd /s /c：带引号空格路径的命令整体包裹，windowsVerbatimArguments=true', async () => {
        const prev = process.env.ComSpec;
        process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
        try {
            const proc = makeFakeProc();
            const promise = runCommand({
                command: '"C:\\Program Files\\node\\node.exe" --version',
                cwd: tmpDir,
                shell: 'cmd',
                timeout: 0
            });
            await flush();

            expect(spawnMock).toHaveBeenCalledWith(
                'C:\\Windows\\System32\\cmd.exe',
                ['/s', '/c', '"chcp 65001 >nul && "C:\\Program Files\\node\\node.exe" --version"'],
                expect.objectContaining({ cwd: tmpDir, windowsHide: true, windowsVerbatimArguments: true })
            );

            proc.emit('close', 0); // 清理 TaskManager 注册
            await promise;
        } finally {
            if (prev === undefined) {
                delete process.env.ComSpec;
            } else {
                process.env.ComSpec = prev;
            }
        }
    });

    test('powershell：prependCommand 与命令拼接为单个 -Command 参数', async () => {
        const proc = makeFakeProc();
        const promise = runCommand({ command: 'echo hi', cwd: tmpDir, shell: 'powershell', timeout: 0 });
        await flush();

        expect(spawnMock).toHaveBeenCalledWith(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', expect.stringContaining('echo hi')],
            expect.objectContaining({ cwd: tmpDir, windowsHide: true })
        );
        const finalArg = spawnMock.mock.calls[0][1]![4] as string;
        expect(finalArg).toContain('$OutputEncoding');

        proc.emit('close', 0);
        await promise;
    });

    test('完整执行流：stdout/stderr 数据收集 → close(0) → success + output + exitCode', async () => {
        const proc = makeFakeProc();
        const promise = runCommand({ command: 'echo hello', cwd: tmpDir, shell: 'powershell', timeout: 0 });
        await flush();

        proc.stdout.write(Buffer.from('hello\n'));
        proc.stderr.write(Buffer.from('warn\n'));
        proc.emit('close', 0);

        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.data.output).toBe('hello\nwarn');
        expect(result.data.exitCode).toBe(0);
    });

    test('Windows 下 GBK 输出经 handler 解码为中文', async () => {
        const proc = makeFakeProc();
        const promise = runCommand({ command: 'chcp 65001', cwd: tmpDir, shell: 'cmd', timeout: 0 });
        await flush();

        // GBK 编码的「中文」+ 换行
        proc.stdout.write(Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0x0A]));
        proc.emit('close', 0);

        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.data.output).toBe('中文');
    });

    test('background=true 时立即返回任务信息，不等待进程结束', async () => {
        const proc = makeFakeProc();
        const promise = runCommand({
            command: 'sleep 1', cwd: tmpDir, shell: 'powershell', timeout: 0, background: true
        });
        await flush();

        const result = await promise;
        expect(result.success).toBe(true);
        expect(result.data.background).toBe(true);
        expect(result.data.taskId).toBeDefined();

        proc.emit('close', 0); // 清理 TaskManager 注册
    });
});
