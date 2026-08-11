/**
 * Shell config & availability detection
 *
 * Split from execute_command.ts: cross-platform shell selection
 * (cmd/powershell/bash/sh/zsh/gitbash/wsl), shell executable path
 * resolution, availability checks (async/sync with module-level cache),
 * and enabled-shell descriptions.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { getGlobalSettingsManager } from '../../core/settingsContext';
import { getDefaultExecuteCommandConfig } from '../../modules/settings';
import { t } from '../../i18n';

/**
 * Shell 类型定义
 */
export type ShellType = 'default' | 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh' | 'gitbash' | 'wsl';

/**
 * 在 Windows 上解析 shell 可执行文件的路径。
 *
 * 优先使用用户配置的自定义路径。未配置时返回简短文件名（如 'powershell.exe'、'cmd.exe'），
 * 让 Windows 的 CreateProcessW 通过内置的系统目录搜索来定位可执行文件。
 *
 * CreateProcessW 的搜索顺序保证 System32 始终在 PATH 之前被搜索，
 * 因此不需要拼接完整路径，避免了 fs.existsSync 与实际 spawn 之间可能的不一致
 * （例如 WOW64 重定向、文件系统过滤驱动干扰等边缘场景）。
 *
 * @param shellType  shell 类型（如 'powershell', 'cmd'）
 * @param customPath 用户在设置中配置的自定义路径（可选）
 * @returns shell 可执行文件路径
 */
function resolveWindowsShellExecutable(shellType: string, customPath?: string): string {
    // 用户显式配置的路径优先
    if (customPath) {
        return customPath;
    }

    switch (shellType) {
        case 'cmd':
            // ComSpec 通常指向 C:\Windows\System32\cmd.exe，优先使用
            if (process.env.ComSpec) {
                return process.env.ComSpec;
            }
            return 'cmd.exe';

        case 'powershell':
            // 直接使用简短文件名，让 Windows 的 CreateProcessW 通过内置搜索找到它。
            // CreateProcessW 总是优先搜索 System32，不依赖 PATH。
            // 如果系统安装了 PowerShell 7 且 PATH 中有 pwsh，CreateProcessW 也会找到。
            return 'powershell.exe';

        default:
            // 其他 shell（bash.exe, sh.exe 等）保持原逻辑
            return `${shellType}.exe`;
    }
}

/**
 * 获取 shell 配置（从设置中读取）
 */
export function getShellConfig(shellType: ShellType): {
    shell: string;
    shellArgs?: string[];
    prependCommand?: string;  // 在命令前添加的命令（用于设置编码等）
} {
    const platform = os.platform();
    const settingsManager = getGlobalSettingsManager();
    const config = settingsManager?.getExecuteCommandConfig() || getDefaultExecuteCommandConfig();
    
    // 如果是 default，使用配置中的默认 shell
    let actualShellType = shellType;
    if (shellType === 'default') {
        actualShellType = config.defaultShell as ShellType;
    }
    
    // 从配置中查找 shell
    const shellConfig = config.shells.find(s => s.type === actualShellType);
    
    // 使用配置的路径或默认路径
    const customPath = shellConfig?.path;
    
    switch (actualShellType) {
        case 'powershell':
            if (platform === 'win32') {
                // PowerShell 需要设置输出编码为 UTF-8，同时设置控制台编码
                return {
                    shell: resolveWindowsShellExecutable('powershell', customPath),
                    shellArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'],
                    prependCommand: '$OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8;'
                };
            }
            return { shell: customPath || 'pwsh', shellArgs: ['-NoProfile', '-Command'] };
            
        case 'cmd':
            if (platform === 'win32') {
                // Windows cmd：直接使用 cmd.exe，通过 chcp 65001 设置 UTF-8 编码
                // 不再使用 PowerShell 包装，避免命令语法不兼容问题（如 && 运算符）
                // 使用 /s /c 参数确保命令中的引号被正确处理
                return {
                    shell: resolveWindowsShellExecutable('cmd', customPath),
                    shellArgs: ['/s', '/c'],
                    prependCommand: 'chcp 65001 >nul &&'
                };
            }
            return {
                shell: customPath || 'cmd.exe',
                shellArgs: ['/s', '/c'],
                prependCommand: 'chcp 65001 >nul &&'
            };
            
        case 'bash':
            if (platform === 'win32') {
                // Windows: 优先使用 PATH 中的 bash
                return {
                    shell: customPath || 'bash.exe',
                    shellArgs: ['-c']
                };
            }
            return { shell: customPath || '/bin/bash', shellArgs: ['-c'] };
            
        case 'zsh':
            if (platform === 'win32') {
                // Windows 无 zsh，降级到 PowerShell（带 UTF-8 编码）
                return {
                    shell: resolveWindowsShellExecutable('powershell'),
                    shellArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'],
                    prependCommand: '$OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8;'
                };
            }
            return { shell: customPath || '/bin/zsh', shellArgs: ['-c'] };
            
        case 'sh':
            if (platform === 'win32') {
                // Windows: 优先使用 PATH 中的 sh
                return {
                    shell: customPath || 'sh.exe',
                    shellArgs: ['-c']
                };
            }
            return { shell: customPath || '/bin/sh', shellArgs: ['-c'] };
            
        case 'gitbash':
            // Git Bash: 优先使用 PATH 中的 bash
            return {
                shell: customPath || 'bash.exe',
                shellArgs: ['-c']
            };
            
        case 'wsl':
            return { shell: 'wsl.exe', shellArgs: ['--', 'bash', '-c'] };
            
        default:
            // 使用配置的默认 shell
            if (platform === 'win32') {
                // Windows 默认使用 PowerShell（带 UTF-8 编码）
                return {
                    shell: resolveWindowsShellExecutable('powershell'),
                    shellArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'],
                    prependCommand: '$OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8;'
                };
            }
            return { shell: '/bin/sh', shellArgs: ['-c'] };
    }
}

/**
 * 获取启用的 shell 列表（用于工具描述）
 */
export function getEnabledShellTypes(): string[] {
    const settingsManager = getGlobalSettingsManager();
    const config = settingsManager?.getExecuteCommandConfig() || getDefaultExecuteCommandConfig();
    return config.shells.filter(s => s.enabled).map(s => s.type);
}

/**
 * 获取 Shell 的默认可执行文件路径（用于可用性检测）
 * 这个路径应该与 getShellConfig 中使用的路径一致
 */
function getDefaultShellPath(shellType: string): string {
    const platform = os.platform();
    
    switch (shellType) {
        case 'powershell':
            if (platform === 'win32') {
                return resolveWindowsShellExecutable('powershell');
            }
            return 'pwsh';
        case 'cmd':
            if (platform === 'win32') {
                return resolveWindowsShellExecutable('cmd');
            }
            return 'cmd.exe';
        case 'bash':
            // Windows 使用 PATH 中的 bash
            return platform === 'win32' ? 'bash.exe' : '/bin/bash';
        case 'zsh':
            return platform === 'win32' ? 'zsh.exe' : '/bin/zsh';
        case 'sh':
            // Windows 使用 PATH 中的 sh
            return platform === 'win32' ? 'sh.exe' : '/bin/sh';
        case 'gitbash':
            // Git Bash 使用 PATH 中的 bash
            return 'bash.exe';
        case 'wsl':
            return 'wsl.exe';
        default:
            return shellType;
    }
}

/**
 * 检测单个 Shell 是否可用
 *
 * 修改原因：异步检测每次调用都会重新 execFile/execFile 外部进程，而同步版
 *          checkShellAvailabilitySync 已有模块级缓存；同一 shell 在工具执行时被
 *          重复检测浪费进程启动开销。
 * 修改方式：入口先查 shellAvailabilityCache（与同步版共用、进程生命周期 TTL），
 *          命中直接返回；未命中则执行检测并把布尔结果回写缓存，两种路径共享结果。
 */
export async function checkShellAvailability(shellType: string, customPath?: string): Promise<{
    available: boolean;
    reason?: string;
}> {
    const cacheKey = getShellAvailabilityCacheKey(shellType, customPath);
    const cached = getCachedShellAvailability(cacheKey);
    if (cached !== undefined) {
        // 缓存只存布尔值（与同步版一致），不可用时不再重构具体原因，由调用方回退兜底文案
        return cached ? { available: true } : { available: false };
    }
    const result = await checkShellAvailabilityUncached(shellType, customPath);
    setCachedShellAvailability(cacheKey, result.available);
    return result;
}

/** 无缓存的原始异步检测逻辑（仅由 checkShellAvailability 调用） */
async function checkShellAvailabilityUncached(shellType: string, customPath?: string): Promise<{
    available: boolean;
    reason?: string;
}> {
    const platform = os.platform();
    const shellPath = customPath || getDefaultShellPath(shellType);
    
    // Windows 特殊处理
    if (platform === 'win32') {
        // WSL 需要特殊检测
        if (shellType === 'wsl') {
            return new Promise((resolve) => {
                cp.execFile('wsl.exe', ['--status'], { timeout: 5000 }, (error) => {
                    if (error) {
                        resolve({ available: false, reason: t('tools.terminal.shellCheck.wslNotInstalled') });
                    } else {
                        resolve({ available: true });
                    }
                });
            });
        }
        
        // 对于绝对路径，检查文件是否存在
        if (shellPath.includes('\\') || shellPath.includes('/')) {
            const fs = require('fs');
            try {
                fs.accessSync(shellPath, fs.constants.X_OK);
                return { available: true };
            } catch {
                return { available: false, reason: t('tools.terminal.shellCheck.shellNotFound', { shellPath }) };
            }
        }
        
        // 对于命令名，使用 where 命令检查 PATH
        return new Promise((resolve) => {
            // 参数必须通过 argv 传递，不能拼进 shell 命令；customPath 属于用户可控配置。
            cp.execFile('where.exe', [shellPath], { timeout: 5000 }, (error) => {
                if (error) {
                    resolve({ available: false, reason: t('tools.terminal.shellCheck.shellNotInPath', { shellPath }) });
                } else {
                    resolve({ available: true });
                }
            });
        });
    } else {
        // Unix 系统
        // 对于绝对路径，检查文件是否存在
        if (shellPath.startsWith('/')) {
            const fs = require('fs');
            try {
                fs.accessSync(shellPath, fs.constants.X_OK);
                return { available: true };
            } catch {
                return { available: false, reason: t('tools.terminal.shellCheck.shellNotFound', { shellPath }) };
            }
        }
        
        // 对于命令名，使用 which 命令检查 PATH
        return new Promise((resolve) => {
            cp.execFile('which', [shellPath], { timeout: 5000 }, (error) => {
                if (error) {
                    resolve({ available: false, reason: t('tools.terminal.shellCheck.shellNotInPath', { shellPath }) });
                } else {
                    resolve({ available: true });
                }
            });
        });
    }
}

/**
 * 检测所有 Shell 的可用性
 */
export async function checkAllShellsAvailability(shells: Array<{ type: string; path?: string }>): Promise<Map<string, { available: boolean; reason?: string }>> {
    const results = new Map<string, { available: boolean; reason?: string }>();
    
    await Promise.all(
        shells.map(async (shell) => {
            const result = await checkShellAvailability(shell.type, shell.path);
            results.set(shell.type, result);
        })
    );
    
    return results;
}

/**
 * Shell 可用性检测结果缓存（模块级 Map，带时间戳 TTL 过期）。
 *
 * 修改原因：工具创建时 getAvailableShells 会对每个启用的 shell 同步 execSync
 * （which/where/wsl --status，各最多 3s），且 getAvailableShellsDescription /
 * getEnabledShellTypesForEnum / getUnavailableShellsDescription 会多次触发
 * getAvailableShells，一次工具创建可能重复执行多轮外部检测，阻塞 extension host。
 * 修改方式：按 "shellType:customPath" 缓存首次检测结果，后续读取直接命中缓存；
 *           缓存条目记录检测时间戳，超过 SHELL_AVAILABILITY_CACHE_TTL_MS 后视为过期
 *           并重新检测（用户新装 shell / 修改 PATH 后能在 TTL 内自动反映）。
 * 修改目的：保留「一次工具创建内重复检测直接命中」的去重收益，同时避免永久缓存
 *           导致环境变化永远无法生效。
 */
const SHELL_AVAILABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

interface ShellAvailabilityCacheEntry {
    available: boolean;
    checkedAt: number;
}

const shellAvailabilityCache = new Map<string, ShellAvailabilityCacheEntry>();

function getCachedShellAvailability(cacheKey: string): boolean | undefined {
    const entry = shellAvailabilityCache.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() - entry.checkedAt > SHELL_AVAILABILITY_CACHE_TTL_MS) {
        shellAvailabilityCache.delete(cacheKey);
        return undefined;
    }
    return entry.available;
}

function setCachedShellAvailability(cacheKey: string, available: boolean): void {
    shellAvailabilityCache.set(cacheKey, { available, checkedAt: Date.now() });
}

function getShellAvailabilityCacheKey(shellType: string, customPath?: string): string {
    return `${shellType}:${customPath ?? ''}`;
}

/**
 * 同步检测 Shell 是否可用（带模块级缓存）
 */
function checkShellAvailabilitySync(shellType: string, customPath?: string): boolean {
    // 缓存命中直接返回，避免重复 execSync 阻塞（TTL 过期后重新检测）
    const cacheKey = getShellAvailabilityCacheKey(shellType, customPath);
    const cached = getCachedShellAvailability(cacheKey);
    if (cached !== undefined) {
        return cached;
    }

    const platform = os.platform();
    const shellPath = customPath || getDefaultShellPath(shellType);
    
    let available = false;
    try {
        if (platform === 'win32') {
            // WSL 特殊处理
            if (shellType === 'wsl') {
                cp.execSync('wsl --status', { timeout: 3000, stdio: 'ignore' });
            } else if (shellPath.includes('\\') || shellPath.includes('/')) {
                // 绝对路径检查文件存在
                fs.accessSync(shellPath, fs.constants.X_OK);
            } else {
                // 使用 where 检查 PATH：参数必须通过 argv 传递，不能拼进 shell 命令——
                // customPath 属于用户可控配置，字符串拼接存在命令注入风险（与异步版 276 行同口径）
                cp.execFileSync('where.exe', [shellPath], { timeout: 3000, stdio: 'ignore' });
            }
        } else {
            // 绝对路径检查文件存在
            if (shellPath.startsWith('/')) {
                fs.accessSync(shellPath, fs.constants.X_OK);
            } else {
                // 使用 which 检查 PATH
                cp.execSync(`which ${shellPath}`, { timeout: 3000, stdio: 'ignore' });
            }
        }
        available = true;
    } catch {
        available = false;
    }

    setCachedShellAvailability(cacheKey, available);
    return available;
}

/**
 * 获取启用且可用的 Shell 列表
 */
function getAvailableShells(): Array<{ type: string; displayName: string; isDefault: boolean }> {
    const settingsManager = getGlobalSettingsManager();
    const config = settingsManager?.getExecuteCommandConfig() || getDefaultExecuteCommandConfig();
    
    return config.shells
        .filter(s => s.enabled && checkShellAvailabilitySync(s.type, s.path))
        .map(s => ({
            type: s.type,
            displayName: s.displayName,
            isDefault: s.type === config.defaultShell
        }));
}

/**
 * 获取可用的 Shell 描述
 */
export function getAvailableShellsDescription(): string {
    const availableShells = getAvailableShells();
    
    if (availableShells.length === 0) {
        return '- No available Shell';
    }
    
    return availableShells
        .map(s => `- ${s.type}: ${s.displayName}${s.isDefault ? ' (default)' : ''}`)
        .join('\n');
}

/**
 * 获取默认 Shell 名称
 */
export function getDefaultShellName(): string {
    const settingsManager = getGlobalSettingsManager();
    const config = settingsManager?.getExecuteCommandConfig() || getDefaultExecuteCommandConfig();
    const defaultShell = config.shells.find(s => s.type === config.defaultShell);
    return defaultShell?.displayName || config.defaultShell;
}

/**
 * 获取启用且可用的 Shell 类型列表（用于 enum）
 */
export function getEnabledShellTypesForEnum(): string[] {
    const availableShells = getAvailableShells();
    
    const types = availableShells.map(s => s.type);
    
    // 确保 default 始终在列表开头
    return ['default', ...types];
}

/**
 * 获取默认 Shell 类型
 */
export function getDefaultShellType(): string {
    const settingsManager = getGlobalSettingsManager();
    const config = settingsManager?.getExecuteCommandConfig() || getDefaultExecuteCommandConfig();
    return config.defaultShell;
}

/**
 * 获取已启用但当前不可用的 Shell 描述
 */
export function getUnavailableShellsDescription(): string {
    const settingsManager = getGlobalSettingsManager();
    const config = settingsManager?.getExecuteCommandConfig() || getDefaultExecuteCommandConfig();
    const availableTypes = new Set(getAvailableShells().map(s => s.type));
    const unavailableShells = config.shells
        .filter(s => s.enabled && !availableTypes.has(s.type))
        .map(s => `- ${s.type}: ${s.displayName}`);

    if (unavailableShells.length === 0) {
        return '- 无';
    }

    return unavailableShells.join('\n');
}