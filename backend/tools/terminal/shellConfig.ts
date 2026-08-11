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
import * as path from 'path';
import { getGlobalSettingsManager, getGlobalStoragePath } from '../../core/settingsContext';
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
    const cached = shellAvailabilityCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        // 缓存只存布尔值（与同步版一致），不可用时不再重构具体原因，由调用方回退兜底文案
        return cached.available ? { available: true } : { available: false };
    }
    const result = await checkShellAvailabilityUncached(shellType, customPath);
    shellAvailabilityCache.set(cacheKey, { available: result.available, expiresAt: Date.now() + SHELL_AVAILABILITY_CACHE_TTL_MS });
    persistShellCacheToDisk();
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
 * Shell 可用性同步检测结果缓存（模块级 Map + TTL）。
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

/**
 * 磁盘缓存 TTL：跨会话复用探测结果，冷启动不再重复 spawn 子进程。
 *
 * 为什么加磁盘层：进程内缓存只能省掉进程生命周期内的重复探测，每次启动
 * （尤其打包版 exe）仍要对全部启用 shell 做一轮同步 spawn（wsl --status
 * 最坏可阻塞 3s），是启动路径上最大的同步阻塞点。
 * 怎么改：探测结果落盘到数据目录 shell-availability.json（24h TTL），
 * 宿主在数据路径就绪后调用 warmUpShellAvailabilityCache() 预热进内存，
 * 启动路径完全免 spawn；进程内 5 分钟 TTL 语义保留（运行期间新装 shell
 * 5 分钟内被重新识别），预热条目的进程内 TTL 从预热时刻重新起算。
 */
const SHELL_CACHE_DISK_TTL_MS = 24 * 60 * 60 * 1000;
const SHELL_CACHE_FILE_NAME = 'shell-availability.json';

interface ShellAvailabilityCacheEntry {
    available: boolean;
    expiresAt: number;
}

const shellAvailabilityCache = new Map<string, ShellAvailabilityCacheEntry>();

/**
 * 磁盘缓存文件路径：{ [cacheKey]: { available, expiresAt } }
 * 读写均容错：读失败/解析失败视为无缓存，写失败静默（缓存只是加速手段）。
 */
function getShellCacheFilePath(): string | null {
    const dataPath = getGlobalStoragePath();
    if (!dataPath) {
        return null;
    }
    return path.join(dataPath, SHELL_CACHE_FILE_NAME);
}

function loadShellCacheFromDisk(): void {
    const cachePath = getShellCacheFilePath();
    if (!cachePath) {
        return;
    }
    try {
        if (!fs.existsSync(cachePath)) {
            return;
        }
        const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as Record<string, ShellAvailabilityCacheEntry>;
        if (!raw || typeof raw !== 'object') {
            return;
        }
        const now = Date.now();
        for (const [key, entry] of Object.entries(raw)) {
            if (!entry || typeof entry.available !== 'boolean' || typeof entry.expiresAt !== 'number') {
                continue;
            }
            if (entry.expiresAt <= now) {
                continue;
            }
            // 预热进进程内缓存：TTL 从预热时刻起算（保持"5 分钟内新装可识别"语义）
            shellAvailabilityCache.set(key, {
                available: entry.available,
                expiresAt: now + SHELL_AVAILABILITY_CACHE_TTL_MS
            });
        }
    } catch {
        // 损坏缓存忽略，下次探测后重写
    }
}

function persistShellCacheToDisk(): void {
    const cachePath = getShellCacheFilePath();
    if (!cachePath) {
        return;
    }
    try {
        const now = Date.now();
        // 只写磁盘有效窗口内的条目（进程内 5 分钟 TTL 的条目也一并落盘，
        // 磁盘侧 TTL 统一按 24h 起算）
        const data: Record<string, ShellAvailabilityCacheEntry> = {};
        for (const [key, entry] of shellAvailabilityCache) {
            if (entry.expiresAt > now) {
                data[key] = {
                    available: entry.available,
                    expiresAt: now + SHELL_CACHE_DISK_TTL_MS
                };
            }
        }
        fs.writeFileSync(cachePath, JSON.stringify(data), 'utf-8');
    } catch {
        // 写缓存失败不影响功能
    }
}

/**
 * 启动时预热磁盘缓存（宿主在数据路径就绪后、工具注册前调用，
 * 使工具注册阶段的同步探测直接命中缓存，免 spawn）。
 */
export function warmUpShellAvailabilityCache(): void {
    loadShellCacheFromDisk();
}

function getShellAvailabilityCacheKey(shellType: string, customPath?: string): string {
    return `${shellType}:${customPath ?? ''}`;
}

/**
 * 同步检测 Shell 是否可用（带模块级 TTL 缓存：用户运行期间新装 shell 在 5 分钟内可被重新识别）
 */
function checkShellAvailabilitySync(shellType: string, customPath?: string): boolean {
    // 缓存命中直接返回，避免重复 execSync 阻塞（TTL 过期后重新检测）
    const cacheKey = getShellAvailabilityCacheKey(shellType, customPath);
    const cached = shellAvailabilityCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.available;
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
                // 使用 where 检查 PATH
                cp.execSync(`where ${shellPath}`, { timeout: 3000, stdio: 'ignore' });
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

    shellAvailabilityCache.set(cacheKey, { available, expiresAt: Date.now() + SHELL_AVAILABILITY_CACHE_TTL_MS });
    persistShellCacheToDisk();
    return available;
}

/**
 * 带原因的同步可用性检测（execute_command 执行路径使用）。
 *
 * 修改原因：高频命令调用会反复 spawn 子进程。
 * 修改方式：可用性直接复用 checkShellAvailabilitySync（5 分钟 TTL 缓存），
 * 不再 spawn；仅不可用路径按原异步版本的相同分支生成 reason 文案，语义保持一致。
 */
export function getShellAvailabilityWithReason(shellType: string, customPath?: string): { available: boolean; reason?: string } {
    const available = checkShellAvailabilitySync(shellType, customPath);
    if (available) {
        return { available: true };
    }

    const platform = os.platform();
    const shellPath = customPath || getDefaultShellPath(shellType);
    if (platform === 'win32') {
        // WSL 需要特殊检测
        if (shellType === 'wsl') {
            return { available: false, reason: t('tools.terminal.shellCheck.wslNotInstalled') };
        }
        // 对于绝对路径，检查文件是否存在
        if (shellPath.includes('\\') || shellPath.includes('/')) {
            return { available: false, reason: t('tools.terminal.shellCheck.shellNotFound', { shellPath }) };
        }
        return { available: false, reason: t('tools.terminal.shellCheck.shellNotInPath', { shellPath }) };
    }

    // Unix 系统
    if (shellPath.startsWith('/')) {
        return { available: false, reason: t('tools.terminal.shellCheck.shellNotFound', { shellPath }) };
    }
    return { available: false, reason: t('tools.terminal.shellCheck.shellNotInPath', { shellPath }) };
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