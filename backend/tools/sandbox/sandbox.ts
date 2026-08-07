/**
 * 沙箱工具
 *
 * 在隔离的临时目录中安全地运行代码片段，具备以下防护：
 *  - 文件系统隔离：每次运行使用独立的临时目录，运行结束后清理（可配置）
 *  - 资源限制：超时自动终止进程树，输出行数上限截断
 *  - 语言白名单：仅允许配置中启用的语言运行
 *  - 按需确认：默认需要用户确认（与 execute_command 一致）
 *
 * 支持的语言：python / javascript / bash / powershell / sh
 *
 * 注意：本工具提供的是「轻量隔离」，并非操作系统级强隔离。
 * 它不限制网络访问、CPU 或内存用量。如需更强隔离请使用容器方案。
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { TextDecoder } from 'util';
import type { Tool, ToolResult, ToolContext } from '../types';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { getDefaultSandboxConfig, SANDBOX_LANGUAGES } from '../../modules/settings';
import type { SandboxToolConfig, SandboxLanguage } from '../../modules/settings';

// tree-kill 库，用于跨平台终止进程树
// eslint-disable-next-line @typescript-eslint/no-var-requires
const treeKill = require('tree-kill') as (pid: number, signal?: string, callback?: (error?: Error) => void) => void;

/** 语言运行信息 */
interface LanguageRunner {
    /** 文件扩展名（含点） */
    ext: string;
    /** 解析解释器命令与参数。返回 null 表示该平台不可用。 */
    resolveCommand: (tempDir: string, scriptPath: string) => { command: string; args: string[] } | null;
    /** 附加环境变量（合并到子进程 env） */
    env?: Record<string, string>;
}

/** 各语言的运行器定义 */
const LANGUAGE_RUNNERS: Record<SandboxLanguage, LanguageRunner> = {
    python: {
        ext: '.py',
        resolveCommand: (_tempDir, scriptPath) => ({
            command: process.platform === 'win32' ? 'python' : 'python3',
            args: [scriptPath]
        }),
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    },
    javascript: {
        ext: '.js',
        resolveCommand: (_tempDir, scriptPath) => ({
            command: process.execPath, // 使用当前 Node 可执行文件，保证可用
            args: [scriptPath]
        })
    },
    bash: {
        ext: '.sh',
        resolveCommand: (_tempDir, scriptPath) => ({
            command: 'bash',
            args: [scriptPath]
        })
    },
    powershell: {
        ext: '.ps1',
        resolveCommand: (_tempDir, scriptPath) => ({
            // Windows 用 powershell，其它平台尝试 pwsh（PowerShell Core）
            command: process.platform === 'win32' ? 'powershell' : 'pwsh',
            args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
        })
    },
    sh: {
        ext: '.sh',
        resolveCommand: (_tempDir, scriptPath) => ({
            command: 'sh',
            args: [scriptPath]
        })
    }
};

/** 获取沙箱配置：优先用注入的 context.config，其次读设置管理器，最后用默认值 */
function resolveSandboxConfig(contextConfig?: unknown): SandboxToolConfig {
    // 空列表语义：显式保存的空白名单 = 拒绝全部语言（不能回退到默认值，
    // 否则"全部禁用"会变成"全部放行"）
    const normalizeLanguages = (value: unknown): SandboxLanguage[] => {
        if (!Array.isArray(value)) {
            return getDefaultSandboxConfig().allowedLanguages;
        }
        return value.filter((l): l is SandboxLanguage => SANDBOX_LANGUAGES.includes(l as SandboxLanguage));
    };
    if (contextConfig && typeof contextConfig === 'object') {
        const cfg = contextConfig as SandboxToolConfig;
        // 合并默认值，保证字段完整
        const defaults = getDefaultSandboxConfig();
        return {
            enabled: cfg.enabled !== undefined ? cfg.enabled : defaults.enabled,
            allowedLanguages: Array.isArray(cfg.allowedLanguages)
                ? normalizeLanguages(cfg.allowedLanguages)
                : defaults.allowedLanguages,
            defaultTimeout: typeof cfg.defaultTimeout === 'number' && cfg.defaultTimeout > 0
                ? cfg.defaultTimeout : defaults.defaultTimeout,
            maxOutputLines: typeof cfg.maxOutputLines === 'number'
                ? cfg.maxOutputLines : defaults.maxOutputLines,
            cleanupTempDir: cfg.cleanupTempDir !== undefined ? cfg.cleanupTempDir : defaults.cleanupTempDir
        };
    }
    const settingsManager = getGlobalSettingsManager();
    return settingsManager?.getSandboxConfig() || getDefaultSandboxConfig();
}

/**
 * 创建唯一的临时目录
 */
function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'graycode-sandbox-'));
}

/**
 * 安全删除目录（递归，忽略错误）
 */
function safeRemoveDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // 清理失败不阻塞返回
    }
}

/**
 * 流式输出内存护栏：持续输出的进程（如 `print('x'*10**9)`）会在截断前无限累积，
 * 超出上限的旧内容被丢弃并计数，最终按行截断时补充到总量提示中。
 * 上限按字符计（约 16MB UTF-16 文本），足够承载 20 万行 × 80 字符的输出。
 */
const MAX_RETAINED_OUTPUT_CHARS = 8_000_000;

type StreamDecodeMode = 'utf8' | 'gbk';

/**
 * 统计 Unicode 替换字符数量
 *
 * 当字节流按错误编码解码时，通常会出现大量 U+FFFD（�）
 */
function countReplacementChars(text: string): number {
    let count = 0;
    for (const ch of text) {
        if (ch === '\uFFFD') {
            count += 1;
        }
    }
    return count;
}

/**
 * 判断是否应从 UTF-8 降级到 GBK 解码
 */
function shouldFallbackToGbk(utf8Text: string, gbkText: string, chunk: Buffer): boolean {
    // 纯 ASCII 内容不需要降级
    if (!chunk.some(byte => byte >= 0x80)) {
        return false;
    }

    const utf8ReplacementCount = countReplacementChars(utf8Text);
    if (utf8ReplacementCount === 0) {
        return false;
    }

    const gbkReplacementCount = countReplacementChars(gbkText);
    return gbkReplacementCount < utf8ReplacementCount;
}

/**
 * 根据当前模式解码流式输出：Windows 下 UTF-8 出现替换字符时自动降级 GBK
 * （与 execute_command 同一套机制；GBK 预览解码复用实例避免逐 chunk 重建）
 */
function decodeWithMode(
    chunk: Buffer,
    modeRef: { mode: StreamDecodeMode },
    utf8Decoder: StringDecoder,
    gbkDecoder?: TextDecoder,
    gbkPreviewDecoder?: TextDecoder
): string {
    if (modeRef.mode === 'gbk' && gbkDecoder) {
        return gbkDecoder.decode(chunk, { stream: true });
    }

    const utf8Text = utf8Decoder.write(chunk);
    if (!gbkDecoder || !gbkPreviewDecoder) {
        return utf8Text;
    }

    const gbkPreview = gbkPreviewDecoder.decode(chunk);
    if (shouldFallbackToGbk(utf8Text, gbkPreview, chunk)) {
        modeRef.mode = 'gbk';
        return gbkDecoder.decode(chunk, { stream: true });
    }

    return utf8Text;
}

/**
 * 按行截断输出，保留最后 N 行
 *
 * 边界语义：
 *  - maxLines < 0：不截断，返回真实行数
 *  - maxLines === 0：全部丢弃（返回空串并标记截断）
 *  - 其余：保留最后 maxLines 行
 */
function truncateOutputLines(output: string, maxLines: number): { text: string; truncated: boolean; totalLines: number } {
    const totalLines = output.split('\n').length;
    if (maxLines < 0) {
        return { text: output, truncated: false, totalLines };
    }
    if (maxLines === 0) {
        return { text: '', truncated: true, totalLines };
    }
    const lines = output.split('\n');
    if (lines.length <= maxLines) {
        return { text: output, truncated: false, totalLines };
    }
    const kept = lines.slice(lines.length - maxLines);
    return {
        text: kept.join('\n'),
        truncated: true,
        totalLines
    };
}

/**
 * 创建沙箱工具
 */
export function createSandboxTool(): Tool {
    const supportedList = SANDBOX_LANGUAGES.join(', ');

    const description = [
        'Run code in an isolated sandbox (temporary directory with timeout and output limits).',
        'Safer than execute_command for running untrusted code snippets: the code runs in a throwaway',
        'temp directory that is cleaned up afterwards, with a hard timeout that kills the process tree',
        'and an output line cap to prevent flooding.',
        '',
        'Supported languages: ' + supportedList + '.',
        'Pass the full source code via the `code` parameter; the tool writes it to a file and invokes',
        'the corresponding interpreter. Optional `stdin` is piped to the program.',
        '',
        'NOTE: This is lightweight filesystem isolation, NOT OS-level sandboxing. It does not block',
        'network access or limit CPU/memory. Do not use for truly malicious code.',
        '',
        'By default this tool requires user confirmation before execution (same as execute_command);',
        'it can be set to auto-execute in the tool auto-execution settings.'
    ].join('\n');

    return {
        declaration: {
            name: 'sandbox',
            category: 'sandbox',
            description,
            strict: true, // API 端强制 schema 校验
            parameters: {
                type: 'object',
                properties: {
                    language: {
                        type: 'string',
                        enum: SANDBOX_LANGUAGES,
                        description: 'Programming language of the code to run.'
                    },
                    code: {
                        type: 'string',
                        description: 'The source code to execute.'
                    },
                    stdin: {
                        type: 'string',
                        description: 'Optional input to pass to the program via standard input.'
                    },
                    timeout: {
                        type: 'number',
                        description: 'Optional timeout in milliseconds. Capped by the configured default timeout.'
                    }
                },
                required: ['language', 'code']
            }
        },
        handler: async (args, context?: ToolContext): Promise<ToolResult> => {
            const language = args.language as SandboxLanguage;
            const code = args.code as string;
            const stdin = args.stdin as string | undefined;
            const rawTimeout = args.timeout as number | undefined;

            if (!language) {
                return { success: false, error: 'language is required' };
            }
            if (!code || typeof code !== 'string') {
                return { success: false, error: 'code is required' };
            }
            if (!SANDBOX_LANGUAGES.includes(language)) {
                return { success: false, error: `Unsupported language: ${language}. Supported: ${supportedList}` };
            }

            const config = resolveSandboxConfig(context?.config);

            // 总开关校验（双重保险，isToolEnabled 已在更上层拦截）
            if (config.enabled === false) {
                return { success: false, error: 'Sandbox is disabled. Enable it in Settings > Sandbox.' };
            }

            // 语言白名单校验
            if (!config.allowedLanguages.includes(language)) {
                return {
                    success: false,
                    error: `Language "${language}" is not allowed by the sandbox configuration. Allowed: ${config.allowedLanguages.join(', ')}`
                };
            }

            const runner = LANGUAGE_RUNNERS[language];
            const resolved = runner.resolveCommand('', '');
            if (!resolved) {
                return { success: false, error: `Language "${language}" is not available on this platform.` };
            }

            // 超时：用户传入的值不能超过配置上限
            const maxTimeout = config.defaultTimeout;
            const timeout = (typeof rawTimeout === 'number' && rawTimeout > 0)
                ? Math.min(rawTimeout, maxTimeout)
                : maxTimeout;

            // 创建临时目录与脚本文件
            let tempDir: string;
            try {
                tempDir = createTempDir();
            } catch (error) {
                return {
                    success: false,
                    error: `Failed to create temp directory: ${error instanceof Error ? error.message : String(error)}`
                };
            }

            const scriptPath = path.join(tempDir, `sandbox${runner.ext}`);
            try {
                fs.writeFileSync(scriptPath, code, { encoding: 'utf8' });
            } catch (error) {
                if (config.cleanupTempDir) {
                    safeRemoveDir(tempDir);
                }
                return {
                    success: false,
                    error: `Failed to write script file: ${error instanceof Error ? error.message : String(error)}`
                };
            }

            const cmdInfo = runner.resolveCommand(tempDir, scriptPath)!;

            // 构建子进程环境：继承当前环境并叠加语言特定变量
            const childEnv = { ...process.env, ...runner.env };

            const startTime = Date.now();
            let timedOut = false;
            let aborted = false;

            return new Promise<ToolResult>((resolve) => {
                let proc: cp.ChildProcess;
                try {
                    proc = cp.spawn(cmdInfo.command, cmdInfo.args, {
                        cwd: tempDir,
                        shell: false,
                        env: childEnv,
                        windowsHide: true
                    });
                } catch (error) {
                    if (config.cleanupTempDir) {
                        safeRemoveDir(tempDir);
                    }
                    resolve({
                        success: false,
                        error: `Failed to spawn "${cmdInfo.command}": ${error instanceof Error ? error.message : String(error)}`
                    });
                    return;
                }

                // Windows 上支持 UTF-8 -> GBK 自动降级（与 execute_command 同一套机制）
                const isWindows = process.platform === 'win32';
                const stdoutUtf8Decoder = new StringDecoder('utf8');
                const stderrUtf8Decoder = new StringDecoder('utf8');
                const stdoutGbkDecoder = isWindows ? new TextDecoder('gbk') : undefined;
                const stderrGbkDecoder = isWindows ? new TextDecoder('gbk') : undefined;
                const stdoutGbkPreviewDecoder = isWindows ? new TextDecoder('gbk') : undefined;
                const stderrGbkPreviewDecoder = isWindows ? new TextDecoder('gbk') : undefined;
                const stdoutDecodeModeRef: { mode: StreamDecodeMode } = { mode: 'utf8' };
                const stderrDecodeModeRef: { mode: StreamDecodeMode } = { mode: 'utf8' };
                let stdoutText = '';
                let stderrText = '';
                let stdoutOmittedChars = 0;
                let stderrOmittedChars = 0;

                // 有界追加：超出内存护栏时丢弃最旧内容并计数
                const appendBounded = (current: string, incoming: string): { next: string; omitted: number } => {
                    const combined = current + incoming;
                    if (combined.length <= MAX_RETAINED_OUTPUT_CHARS) {
                        return { next: combined, omitted: 0 };
                    }
                    return {
                        next: combined.slice(combined.length - MAX_RETAINED_OUTPUT_CHARS),
                        omitted: combined.length - MAX_RETAINED_OUTPUT_CHARS
                    };
                };

                proc.stdout?.on('data', (chunk: Buffer) => {
                    const text = decodeWithMode(chunk, stdoutDecodeModeRef, stdoutUtf8Decoder, stdoutGbkDecoder, stdoutGbkPreviewDecoder);
                    const { next, omitted } = appendBounded(stdoutText, text);
                    stdoutText = next;
                    stdoutOmittedChars += omitted;
                });
                proc.stderr?.on('data', (chunk: Buffer) => {
                    const text = decodeWithMode(chunk, stderrDecodeModeRef, stderrUtf8Decoder, stderrGbkDecoder, stderrGbkPreviewDecoder);
                    const { next, omitted } = appendBounded(stderrText, text);
                    stderrText = next;
                    stderrOmittedChars += omitted;
                });

                // 写入 stdin（如果有）
                if (stdin !== undefined && stdin !== '' && proc.stdin) {
                    try {
                        proc.stdin.end(stdin);
                    } catch {
                        // stdin 写入失败不致命
                    }
                } else if (proc.stdin) {
                    try { proc.stdin.end(); } catch { /* ignore */ }
                }

                // 终止进程树：先 SIGTERM，回调报错（进程不存在等）时升级 SIGKILL，
                // 避免忽略 SIGTERM 的进程导致 close 永不触发、Promise 永久挂起
                const killProcessTree = (pid: number) => {
                    treeKill(pid, 'SIGTERM', (err) => {
                        if (err) {
                            try {
                                treeKill(pid, 'SIGKILL');
                            } catch {
                                try { proc.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
                            }
                        }
                    });
                };

                // 超时定时器
                const timer = setTimeout(() => {
                    timedOut = true;
                    if (proc.pid) {
                        killProcessTree(proc.pid);
                    } else {
                        try { proc.kill(); } catch { /* ignore */ }
                    }
                }, timeout);

                // 外部中止信号
                const abortSignal = context?.abortSignal as AbortSignal | undefined;
                const onAbort = () => {
                    aborted = true;
                    if (proc.pid) {
                        killProcessTree(proc.pid);
                    } else {
                        try { proc.kill(); } catch { /* ignore */ }
                    }
                };
                if (abortSignal) {
                    if (abortSignal.aborted) {
                        onAbort();
                    } else {
                        abortSignal.addEventListener('abort', onAbort, { once: true });
                    }
                }

                const finalize = (exitCode: number | null, signal: NodeJS.Signals | null) => {
                    clearTimeout(timer);
                    if (abortSignal) {
                        abortSignal.removeEventListener('abort', onAbort);
                    }

                    // flush 解码器残留
                    stdoutText += stdoutDecodeModeRef.mode === 'gbk' && stdoutGbkDecoder
                        ? stdoutGbkDecoder.decode()
                        : stdoutUtf8Decoder.end();
                    stderrText += stderrDecodeModeRef.mode === 'gbk' && stderrGbkDecoder
                        ? stderrGbkDecoder.decode()
                        : stderrUtf8Decoder.end();

                    // 合并输出
                    const rawOutput = (stdoutText + (stderrText ? '\n[stderr]\n' + stderrText : '')).trimEnd();
                    const maxLines = config.maxOutputLines;
                    const { text: output, truncated, totalLines } = truncateOutputLines(rawOutput, maxLines);

                    const duration = Date.now() - startTime;

                    // 清理临时目录
                    if (config.cleanupTempDir) {
                        safeRemoveDir(tempDir);
                    }

                    let error: string | undefined;
                    let success: boolean;
                    if (aborted) {
                        error = 'Sandbox execution was aborted.';
                        success = false;
                    } else if (timedOut) {
                        error = `Sandbox execution timed out after ${timeout}ms.`;
                        success = false;
                    } else if (exitCode !== null && exitCode !== 0) {
                        error = `Process exited with code ${exitCode}.`;
                        success = false;
                    } else if (signal) {
                        error = `Process terminated by signal ${signal}.`;
                        success = false;
                    } else {
                        success = true;
                    }

                    const omittedChars = stdoutOmittedChars + stderrOmittedChars;
                    resolve({
                        success,
                        data: {
                            language,
                            exitCode: exitCode,
                            signal: signal ?? undefined,
                            duration,
                            output: output || '(no output)',
                            truncated: truncated || omittedChars > 0,
                            truncatedNote: (truncated || omittedChars > 0)
                                ? [
                                    truncated ? `Output truncated to last ${maxLines} lines (total ${totalLines} lines).` : null,
                                    omittedChars > 0 ? `Output overflow: oldest ${omittedChars} characters were dropped to bound memory.` : null
                                ].filter(Boolean).join(' ')
                                : undefined,
                            tempDir: config.cleanupTempDir ? undefined : tempDir
                        },
                        error
                    });
                };

                proc.on('error', (err) => {
                    // spawn 失败（如解释器不存在，ENOENT）
                    clearTimeout(timer);
                    if (abortSignal) {
                        abortSignal.removeEventListener('abort', onAbort);
                    }
                    // flush
                    stdoutText += stdoutDecodeModeRef.mode === 'gbk' && stdoutGbkDecoder
                        ? stdoutGbkDecoder.decode()
                        : stdoutUtf8Decoder.end();
                    stderrText += stderrDecodeModeRef.mode === 'gbk' && stderrGbkDecoder
                        ? stderrGbkDecoder.decode()
                        : stderrUtf8Decoder.end();

                    if (config.cleanupTempDir) {
                        safeRemoveDir(tempDir);
                    }

                    const hint = (err as NodeJS.ErrnoException).code === 'ENOENT'
                        ? ` Interpreter "${cmdInfo.command}" not found. Make sure it is installed and on PATH.`
                        : '';
                    resolve({
                        success: false,
                        error: `Failed to run sandbox: ${err.message}${hint}`,
                        data: {
                            language,
                            output: (stdoutText + (stderrText ? '\n[stderr]\n' + stderrText : '')).trimEnd() || '(no output)',
                            duration: Date.now() - startTime
                        }
                    });
                });

                proc.on('close', (code, signal) => {
                    finalize(code, signal);
                });
            });
        }
    };
}

/**
 * 注册沙箱工具
 */
export function registerSandbox(): Tool {
    return createSandboxTool();
}
