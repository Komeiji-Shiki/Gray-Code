/**
 * 动态依赖管理器
 *
 * 用于管理可选的原生依赖（如 sharp），支持：
 * - 检查依赖是否已安装
 * - 在本地文件系统中安装依赖（默认 ~/.graycode/node_modules）
 * - 动态加载已安装的依赖
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { promisify } from 'util';
import { pathToFileURL } from 'url';
import { t } from '../../i18n';
// cross-spawn 在 Windows 上能正确解析 .cmd/.bat（npm.cmd 等）并保持参数边界：
// 原生 execFile 对 .cmd 的解析在扩展进程环境（PATH 隔离）中不可靠，导致依赖安装
// 在 Windows 下静默失败（仅返回 "Command failed"）。与 MCP StdioClient 同一兼容策略。
const crossSpawn = require('cross-spawn') as typeof childProcess.spawn;

const execFile = promisify(childProcess.execFile);
const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const statAsync = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const rm = promisify(fs.rm);

/**
 * 依赖信息
 */
export interface DependencyInfo {
    /** 依赖名称 */
    name: string;
    /** 版本要求 */
    version: string;
    /** 描述 */
    description: string;
    /** 是否已安装 */
    installed: boolean;
    /** 已安装的版本 */
    installedVersion?: string;
    /** 安装大小（估算，MB） */
    estimatedSize?: number;
}

/**
 * 安装进度事件
 */
export interface InstallProgressEvent {
    type: 'start' | 'progress' | 'complete' | 'error';
    dependency: string;
    message?: string;
    error?: string;
}

/**
 * 依赖管理器
 */
export class DependencyManager {
    private static instance: DependencyManager;
    
    /** GrayCode 依赖根目录（默认 ~/.graycode 或自定义路径下的 dependencies） */
    private graycodeDir: string;
    
    /** 依赖安装目录（graycodeDir/node_modules） */
    private depsDir: string;
    
    /** 依赖清单文件路径（记录每个已安装包的传递依赖目录快照，卸载时据此清理残留） */
    private manifestPath: string;
    
    /** 进度事件监听器 */
    private progressListeners: Set<(event: InstallProgressEvent) => void> = new Set();
    
    /** 已加载的模块缓存 */
    private loadedModules: Map<string, any> = new Map();
    
    /** 依赖安装状态缓存（用于同步检查） */
    private installedCache: Map<string, boolean> = new Map();
    
    /** 进行中的安装任务（同依赖串行化：第二个调用复用其结果；不同依赖可并行） */
    private installsInFlight: Map<string, Promise<{ success: boolean; error?: string }>> = new Map();
    
    /** 进行中的卸载任务（同依赖串行化：第二个调用复用其结果） */
    private uninstallsInFlight: Map<string, Promise<{ success: boolean; error?: string }>> = new Map();
    
    /** 复制阶段全局串行队列：不同依赖并行安装时共享同一个 depsDir，复制阶段必须互斥执行 */
    private copyQueue: Promise<void> = Promise.resolve();

    /** manifest 读-改-写串行队列：并发安装/卸载共享同一清单文件，读-改-写必须互斥执行 */
    private manifestQueue: Promise<void> = Promise.resolve();
    
    /** 支持的可选依赖配置 */
    private readonly optionalDependencies: Record<string, { version: string; descriptionKey: string; estimatedSize: number }> = {
        'sharp': {
            version: '^0.33.5',
            descriptionKey: 'modules.dependencies.descriptions.sharp',
            estimatedSize: 30  // MB
        },
        'pdfjs-dist': {
            version: '^4.10.38',
            descriptionKey: 'modules.dependencies.descriptions.pdfjsDist',
            estimatedSize: 18  // MB
        },
        '@napi-rs/canvas': {
            version: '^1.0.7',
            descriptionKey: 'modules.dependencies.descriptions.napiCanvas',
            estimatedSize: 12  // MB
        }
    };
    
    private constructor(private context: vscode.ExtensionContext, customDepsPath?: string) {
        // 如果提供了自定义路径，使用自定义路径
        // 否则使用用户主目录下的 .graycode 文件夹
        this.graycodeDir = customDepsPath || path.join(os.homedir(), '.graycode');
        this.depsDir = path.join(this.graycodeDir, 'node_modules');
        this.manifestPath = path.join(this.graycodeDir, '.deps-manifest.json');
    }
    
    /**
     * 获取单例实例
     *
     * @param context VSCode 扩展上下文（首次创建或需要重建时必须提供）
     * @param customDepsPath 自定义依赖安装目录（可选；显式传入且与当前实例目录不一致时触发重建）
     */
    static getInstance(context?: vscode.ExtensionContext, customDepsPath?: string): DependencyManager {
        const current = DependencyManager.instance;

        // 存储路径切换检测：单例首次创建后，若后续显式传入的 customDepsPath 与当前实例
        // 的 graycodeDir 不一致，重建实例，使依赖重新安装到新目录，避免与新存储布局分叉。
        // 仅在显式传入 customDepsPath 时比较（getSharp 等无参调用必须复用现有实例）。
        const needsRebuild = current
            && customDepsPath !== undefined
            && customDepsPath !== current.graycodeDir;

        if (needsRebuild) {
            if (!context) {
                // 需要重建但未提供 context：构造函数依赖 ExtensionContext，无法安全重建。
                // 选择抛错（fail fast）而非静默沿用旧实例——沿用会把依赖继续装进旧目录，
                // 正是本修复要消除的静默分叉；正常调用方（bootstrap 的 initDependencies）
                // 重建时总是携带 context。
                throw new Error(t('modules.dependencies.errors.requiresContext'));
            }
            // 重建会丢失 progressListeners 与 loadedModules 缓存：这是可接受的取舍——
            // 重建场景是存储路径切换，旧目录的监听器与模块缓存本就应随目录一起作废。
            DependencyManager.instance = new DependencyManager(context, customDepsPath);
        } else if (!current) {
            if (!context) {
                throw new Error(t('modules.dependencies.errors.requiresContext'));
            }
            DependencyManager.instance = new DependencyManager(context, customDepsPath);
        }

        return DependencyManager.instance;
    }
    
    /**
     * 获取安装目录路径
     */
    getInstallPath(): string {
        return this.graycodeDir;
    }
    
    /**
     * 初始化依赖管理器（确保目录存在并刷新缓存）
     */
    async initialize(): Promise<void> {
        try {
            await mkdir(this.graycodeDir, { recursive: true });
            await mkdir(this.depsDir, { recursive: true });
        } catch {
            // 目录可能已存在
        }
        
        // 刷新安装状态缓存
        await this.refreshInstalledCache();
    }
    
    /**
     * 刷新依赖安装状态缓存
     */
    async refreshInstalledCache(): Promise<void> {
        for (const name of Object.keys(this.optionalDependencies)) {
            const installed = await this.isInstalled(name);
            this.installedCache.set(name, installed);
        }
    }
    
    /**
     * 同步检查依赖是否已安装（基于缓存）
     *
     * 注意：此方法返回的是缓存状态，可能不是最新的
     * 在安装/卸载后需要调用 refreshInstalledCache() 刷新
     */
    isInstalledSync(name: string): boolean {
        return this.installedCache.get(name) ?? false;
    }
    
    /**
     * 获取所有可选依赖的状态
     */
    async listDependencies(): Promise<DependencyInfo[]> {
        const result: DependencyInfo[] = [];
        
        for (const [name, config] of Object.entries(this.optionalDependencies)) {
            const installed = await this.isInstalled(name);
            let installedVersion: string | undefined;
            
            if (installed) {
                installedVersion = await this.getInstalledVersion(name);
            }
            
            result.push({
                name,
                version: config.version,
                description: t(config.descriptionKey as any),
                installed,
                installedVersion,
                estimatedSize: config.estimatedSize
            });
        }
        
        return result;
    }
    
    /**
     * 检查依赖是否已安装
     */
    async isInstalled(name: string): Promise<boolean> {
        try {
            const packageJsonPath = path.join(this.depsDir, name, 'package.json');
            await statAsync(packageJsonPath);
            return true;
        } catch {
            return false;
        }
    }
    
    /**
     * 获取已安装依赖的版本
     */
    async getInstalledVersion(name: string): Promise<string | undefined> {
        try {
            const packageJsonPath = path.join(this.depsDir, name, 'package.json');
            const content = await readFile(packageJsonPath, 'utf-8');
            const pkg = JSON.parse(content);
            return pkg.version;
        } catch {
            return undefined;
        }
    }
    
    /**
     * 读取依赖清单（记录每个已安装包复制进 depsDir 的传递依赖目录；缺失/损坏视为空）
     */
    private async loadManifest(): Promise<Record<string, string[]>> {
        try {
            const content = await readFile(this.manifestPath, 'utf-8');
            const data = JSON.parse(content);
            return data && typeof data === 'object' ? data : {};
        } catch {
            return {};
        }
    }

    /**
     * 持久化依赖清单（失败仅记日志，不阻断安装/卸载主流程）
     */
    private async saveManifest(manifest: Record<string, string[]>): Promise<void> {
        try {
            await writeFile(this.manifestPath, JSON.stringify(manifest, null, 2));
        } catch (error) {
            console.error('[deps] failed to save dependency manifest:', error);
        }
    }

    /**
     * 串行执行 manifest 读-改-写（loadManifest → mutate → saveManifest 整段入队）：
     * 并发安装/卸载若各自「读旧清单 → 改 → 写回」，后写者会基于过期清单覆盖先写者
     *（丢条目）。与 copyQueue 同构的链式队列保证互斥。
     */
    private async updateManifest(
        mutate: (manifest: Record<string, string[]>) => void | Promise<void>
    ): Promise<void> {
        const run = this.manifestQueue.then(async () => {
            const manifest = await this.loadManifest();
            await mutate(manifest);
            await this.saveManifest(manifest);
        });
        this.manifestQueue = run.then(
            () => undefined,
            () => undefined
        );
        await run;
    }
    
    /**
     * 安装依赖
     *
     * 并发保护：同依赖的安装请求通过 installsInFlight 串行化——
     * 若同一依赖已有安装在进行中，后续调用直接复用其结果（等待其完成），
     * 避免多个安装共享固定 deps-temp 目录时互相删除/覆盖；
     * 不同依赖互不阻塞，可并行安装（各自使用独立的临时目录）。
     * 同一依赖的卸载进行中时，安装会等待其完成后再执行，避免安装复制与卸载清理互相干扰。
     */
    async install(name: string): Promise<{ success: boolean; error?: string }> {
        const config = this.optionalDependencies[name];
        if (!config) {
            this.emitProgress({
                type: 'error',
                dependency: name,
                error: t('modules.dependencies.errors.unknownDependency', { name })
            });
            return { success: false, error: t('modules.dependencies.errors.unknownDependency', { name }) };
        }
        
        // 同依赖并发安装：复用进行中的安装任务
        const inFlight = this.installsInFlight.get(name);
        if (inFlight) {
            return inFlight;
        }
        
        // 同依赖卸载进行中：等待其完成后再安装，避免安装复制与卸载残留清理互相干扰。
        // 等待期间同依赖安装可能已由其他并发调用注册，复用其结果（不重复安装）
        const uninstallInFlight = this.uninstallsInFlight.get(name);
        if (uninstallInFlight) {
            await uninstallInFlight;
            const afterWait = this.installsInFlight.get(name);
            if (afterWait) {
                return afterWait;
            }
        }
        
        const promise = this.doInstall(name, config);
        this.installsInFlight.set(name, promise);
        try {
            return await promise;
        } finally {
            // 仅当仍指向本次任务时删除，避免误删后续任务
            if (this.installsInFlight.get(name) === promise) {
                this.installsInFlight.delete(name);
            }
        }
    }
    
    /**
     * 执行安装（仅由 install 调用，受 installsInFlight 并发保护）
     */
    private async doInstall(
        name: string,
        config: { version: string; descriptionKey: string; estimatedSize: number }
    ): Promise<{ success: boolean; error?: string }> {
        this.emitProgress({
            type: 'start',
            dependency: name,
            message: t('modules.dependencies.progress.installing', { name })
        });
        
        // 每次安装使用独立临时目录，避免并发安装（不同依赖）互相删除/覆盖。
        // scoped 包（如 @napi-rs/canvas）名称含 `/`：直接拼接会生成带子目录的路径
        //（deps-temp-@napi-rs/canvas-...），mkdir 后 npm 在错误 cwd 执行、node_modules 检查失败。
        // 把 `/` 替换为 `-` 生成合法的单段目录名。
        const safeName = name.replace(/[\/]/g, '-');
        const tempDir = path.join(
            this.graycodeDir,
            `deps-temp-${safeName}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        );
        
        try {
            // 确保目录存在
            await this.initialize();
            
            // 创建临时 package.json
            const tempPackageJson = {
                name: 'graycode-deps',
                version: '1.0.5',
                dependencies: {
                    [name]: config.version
                }
            };
            
            const packageJsonPath = path.join(tempDir, 'package.json');
            
            // 创建临时目录
            await mkdir(tempDir, { recursive: true });
            await writeFile(packageJsonPath, JSON.stringify(tempPackageJson, null, 2));
            
            this.emitProgress({
                type: 'progress',
                dependency: name,
                message: t('modules.dependencies.progress.downloading', { name })
            });
            
            // 使用 npm 安装
            // argv 数组直传（crossSpawn 不经过 shell）：tempDir 来自可配置存储路径，
            // 字符串拼接进 shell 命令会受引号/$()/& 等特殊字符影响（注入面/命令异常）；
            // Windows 上 npm 实际是 npm.cmd，crossSpawn 会解析 .cmd 启动器并保持参数边界。
            // maxBuffer 放大到 64MB：npm 输出较多时不会被默认 1MB 上限误杀
            const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
            const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
                const child = crossSpawn(npmCommand, ['install', '--prefix', tempDir, '--no-save'], {
                    cwd: tempDir,
                    timeout: 300000,  // 5分钟超时
                    windowsHide: true
                });
                let stdout = '';
                let stderr = '';
                child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
                child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
                // maxBuffer 保护：输出超出上限时同样视为失败（Node 原生 execFile 行为）
                const MAX_BUFFER = 64 * 1024 * 1024;
                child.on('error', (err) => reject(err));
                child.on('close', (code) => {
                    if (code === 0) {
                        resolve({ stdout, stderr });
                    } else {
                        const err = new Error(`npm install exited with code ${code}`);
                        (err as any).stderr = stderr;
                        (err as any).stdout = stdout;
                        reject(err);
                    }
                });
                if (stdout.length > MAX_BUFFER || stderr.length > MAX_BUFFER) {
                    child.kill();
                    reject(new Error('npm output exceeded buffer limit'));
                }
            });
            
            // 只记摘要：npm 输出可达数十 MB，整体 console.log 会刷屏并拖慢 extension host
            console.log(`[deps] npm install ${name} finished (stdout ${stdout?.length ?? 0} chars, stderr ${stderr?.length ?? 0} chars)`);
            
            // 移动安装的依赖到目标目录
            // 需要复制整个 node_modules 目录，因为 sharp 等原生模块有平台依赖包
            const sourceNodeModules = path.join(tempDir, 'node_modules');
            
            // 检查源目录是否存在
            try {
                await statAsync(sourceNodeModules);
            } catch {
                throw new Error(t('modules.dependencies.errors.nodeModulesNotFound'));
            }
            
            // 检查主包是否存在
            const mainPackageDir = path.join(sourceNodeModules, name);
            try {
                await statAsync(mainPackageDir);
            } catch {
                throw new Error(t('modules.dependencies.errors.moduleNotFound', { name }));
            }
            
            // 获取 node_modules 下所有目录（包括主包和依赖包）
            const entries = await readdir(sourceNodeModules, { withFileTypes: true });

            // 复制阶段全局串行化：不同依赖的并行安装共享同一个 depsDir，
            // 若同时复制会互相 rm/覆盖对方刚写入的目录（尤其重叠的传递依赖），
            // 这里把整个复制阶段排进全局队列（本依赖复制期间其它依赖的复制必须等待）。
            const previousCopy = this.copyQueue;
            let releaseCopy!: () => void;
            this.copyQueue = new Promise<void>(resolve => {
                releaseCopy = resolve;
            });
            await previousCopy;
            try {
                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    
                    const sourcePath = path.join(sourceNodeModules, entry.name);
                    const targetPath = path.join(this.depsDir, entry.name);
                    
                    // 先复制到同目录临时名，再 rename 覆盖：避免「先删后拷」——复制中途失败时
                    // 旧版本已被删除且无法回滚。rename 无法覆盖已存在的非空目录：先尝试直接
                    // rename（目标不存在时成功），失败（目标已存在）再删旧目标重试；任一步失败
                    // 都清理临时目录，旧目标在 rename 成功前始终保留。
                    const tmpTarget = `${targetPath}.deps-install-tmp`;
                    try {
                        // 清理上次中断安装可能残留的临时目录
                        try {
                            await rm(tmpTarget, { recursive: true, force: true });
                        } catch {
                            // 忽略清理失败
                        }
                        await this.copyDirectory(sourcePath, tmpTarget);
                        try {
                            await fs.promises.rename(tmpTarget, targetPath);
                        } catch {
                            // 目标已存在（rename 无法覆盖非空目录）：先把旧目标改名为备份，
                            // 再 rename 到位——第二次 rename 失败时恢复备份，旧目标不丢失
                            //（「删旧目标后重试」在重试也失败时旧目标会永久丢失）。
                            const backupPath = `${targetPath}.deps-install-backup`;
                            let backupMoved = false;
                            try {
                                // 清理上次中断可能残留的备份目录
                                await rm(backupPath, { recursive: true, force: true });
                                await fs.promises.rename(targetPath, backupPath);
                                backupMoved = true;
                            } catch {
                                // 旧目标改名备份失败（目标已被并发删除等罕见情况）：
                                // 退回「删旧目标后重试」；此路径重试再失败时旧目标已丢失，
                                // 与旧行为一致且概率极低（备份失败说明目标状态已异常）
                                await rm(targetPath, { recursive: true, force: true });
                                await fs.promises.rename(tmpTarget, targetPath);
                            }
                            if (backupMoved) {
                                try {
                                    await fs.promises.rename(tmpTarget, targetPath);
                                } catch (error) {
                                    // 第二次 rename 失败：恢复备份，尽量保留旧目标
                                    try {
                                        await fs.promises.rename(backupPath, targetPath);
                                    } catch {
                                        console.error(`[deps] failed to restore backup ${backupPath} -> ${targetPath}`);
                                    }
                                    throw error;
                                }
                                // rename 成功：清理备份目录
                                try {
                                    await rm(backupPath, { recursive: true, force: true });
                                } catch {
                                    // 忽略备份清理失败
                                }
                            }
                        }
                    } catch (error) {
                        // 复制/替换失败：清理未完成的临时目录，旧目标在 rename 成功前始终保留
                        try {
                            await rm(tmpTarget, { recursive: true, force: true });
                        } catch {
                            // 忽略清理失败
                        }
                        throw error;
                    }
                }
            } finally {
                releaseCopy();
            }
            
            // 记录本次安装复制进 depsDir 的目录清单（主包 + 传递依赖），
            // 卸载时据此清理不再被引用的残留目录
            // 读-改-写整体入 manifest 串行队列：并发安装（不同依赖）不得交错覆盖
            const installedDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
            await this.updateManifest(manifest => {
                manifest[name] = installedDirs;
            });
            
            // 清除缓存并更新安装状态
            this.clearLoadedModules(name);
            this.installedCache.set(name, true);
            
            this.emitProgress({
                type: 'complete',
                dependency: name,
                message: t('modules.dependencies.progress.installSuccess', { name })
            });
            
            return { success: true };
            
        } catch (error) {
            // npm 失败时真实报错在 error.stderr（原生 execFile 只抛 "Command failed"）——
            // 必须取出来拼进错误信息，否则前端只能看到无意义的失败，无法定位根因
            const anyError = error as any;
            const stderrDetails = anyError?.stderr
                ? String(anyError.stderr).trim().split('\n').slice(-15).join('\n')
                : '';
            const errorMessage = error instanceof Error
                ? (error.message + (stderrDetails ? `\n${stderrDetails}` : ''))
                : String(error);
            
            this.emitProgress({
                type: 'error',
                dependency: name,
                error: t('modules.dependencies.errors.installFailed', { error: errorMessage })
            });
            
            return { success: false, error: t('modules.dependencies.errors.installFailed', { error: errorMessage }) };
        } finally {
            // 成功与失败路径都清理临时目录，避免残留
            try {
                await rm(tempDir, { recursive: true, force: true });
            } catch {
                // 忽略清理错误
            }
        }
    }
    
    /**
     * 卸载依赖
     *
     * 并发保护：同依赖的卸载通过 uninstallsInFlight 串行化——若同一依赖已有卸载进行中，
     * 后续调用直接复用其结果（卸载幂等）；同一依赖的安装进行中时，卸载会等待其完成
     * 后再执行（避免卸载残留清理误删安装复制中的目录），反之安装也会等待卸载完成。
     */
    async uninstall(name: string): Promise<{ success: boolean; error?: string }> {
        // 同依赖卸载进行中：复用其结果（卸载幂等，避免并发重复清理残留）
        const uninstallInFlight = this.uninstallsInFlight.get(name);
        if (uninstallInFlight) {
            return uninstallInFlight;
        }
        // 同依赖安装进行中：等待其完成后再卸载，避免卸载残留清理与安装复制互相干扰。
        // 等待期间同依赖卸载可能已由其他并发调用注册，复用其结果（不重复清理）
        const installInFlight = this.installsInFlight.get(name);
        if (installInFlight) {
            await installInFlight;
            const afterWait = this.uninstallsInFlight.get(name);
            if (afterWait) {
                return afterWait;
            }
        }
        const promise = this.doUninstall(name);
        this.uninstallsInFlight.set(name, promise);
        try {
            return await promise;
        } finally {
            // 仅当仍指向本次任务时删除，避免误删后续任务
            if (this.uninstallsInFlight.get(name) === promise) {
                this.uninstallsInFlight.delete(name);
            }
        }
    }
    
    /**
     * 执行卸载（仅由 uninstall 调用，受 uninstallsInFlight 并发保护）
     */
    private async doUninstall(name: string): Promise<{ success: boolean; error?: string }> {
        try {
            const targetDir = path.join(this.depsDir, name);
            await rm(targetDir, { recursive: true, force: true });
            
            // 清理传递依赖残留：安装时已快照每个包的传递依赖目录清单（见 doInstall）。
            // 卸载后删除不再被任何剩余已安装包引用的目录——只删顶层包会让传递依赖永久残留。
            // 清理条件：清单完好（能读出被卸载包记录）或仍存在其他包记录；清单缺失/损坏时
            // 无法区分残留与在用目录，保守跳过，避免误删仍被使用的目录（详见下方 mutate）。
            // 整个「读清单 → 删记录 → 清理 → 写清单」入 manifest 串行队列，
            // 避免与并发安装/卸载的读-改-写交错覆盖（见 updateManifest）。
            await this.updateManifest(async manifest => {
                // 被卸载包自身记录的传递依赖：其记录随本包删除，属「已知残留」可清理。
                // manifestIntact 记录本包记录是否可读出：undefined 说明清单缺失/损坏或本包
                // 从未被记录——仅在清单完好时才按 uninstalledDirs 清理已知残留；清单缺失/损坏
                // 时无法区分残留与在用目录，保守跳过，避免误删仍被使用的目录。
                const uninstalledDirs = manifest[name] ?? [];
                const manifestIntact = manifest[name] !== undefined;
                delete manifest[name];
                const remainingNames = Object.keys(manifest);
                // 清理条件：清单完好（能读出被卸载包记录）或仍有其他包记录。卸载最后一个包时
                // remainingNames 为空，但清单完好仍应按 uninstalledDirs 清理已知残留——
                // 只删顶层包会让传递依赖永久残留。
                if (manifestIntact || remainingNames.length > 0) {
                    const referenced = new Set<string>(remainingNames);
                    for (const dirs of Object.values(manifest)) {
                        for (const dir of dirs) referenced.add(dir);
                    }
                    try {
                        const entries = await readdir(this.depsDir, { withFileTypes: true });
                        // 第一遍：把「有 package.json 但从未被任何 manifest 记录（含被卸载包
                        // 自身记录）」的顶层目录视为未知引用根保留——仅凭清单判定会把清单功能
                        // 上线前安装/手动安装的包误删；被卸载包记录的传递依赖（uninstalledDirs）
                        // 不在此列，仍按残留清理。
                        for (const entry of entries) {
                            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
                            if (referenced.has(entry.name) || uninstalledDirs.includes(entry.name)) continue;
                            try {
                                await statAsync(path.join(this.depsDir, entry.name, 'package.json'));
                                referenced.add(entry.name);
                            } catch {
                                // 无 package.json：scoped 目录（@scope）本身不含 package.json，
                                // 但其中可能仍有在用包（@scope/pkg）。检查一层子目录——任一
                                // 下级目录含 package.json 即视为引用根保留，避免第二遍误删。
                                if (entry.name.startsWith('@')) {
                                    try {
                                        const subEntries = await readdir(
                                            path.join(this.depsDir, entry.name),
                                            { withFileTypes: true }
                                        );
                                        for (const sub of subEntries) {
                                            if (!sub.isDirectory()) continue;
                                            try {
                                                await statAsync(
                                                    path.join(this.depsDir, entry.name, sub.name, 'package.json')
                                                );
                                                referenced.add(entry.name);
                                                break;
                                            } catch {
                                                // 该子目录无 package.json：继续检查其余子目录
                                            }
                                        }
                                    } catch {
                                        // 无法读取 scoped 目录（已被删等）：保持可清理状态
                                    }
                                }
                            }
                        }
                        // 第二遍：删除仍未被引用的残留目录
                        for (const entry of entries) {
                            if (!entry.isDirectory()) continue;
                            // 系统目录（.bin 等）与仍被引用的目录保留
                            if (entry.name.startsWith('.')) continue;
                            // 安装复制阶段的临时/备份目录（.deps-install-tmp/.deps-install-backup）：
                            // 并发 install 正在写入，卸载清理跳过它们，避免删掉进行中安装的中间产物
                            if (entry.name.endsWith('.deps-install-tmp')
                                || entry.name.endsWith('.deps-install-backup')) {
                                continue;
                            }
                            if (referenced.has(entry.name)) continue;
                            try {
                                await rm(path.join(this.depsDir, entry.name), { recursive: true, force: true });
                            } catch {
                                // 忽略单个残留清理失败
                            }
                        }
                    } catch {
                        // depsDir 不存在等，忽略
                    }
                }
            });
            
            // 清除缓存并更新安装状态
            this.clearLoadedModules(name);
            this.installedCache.set(name, false);
            
            return { success: true };
        } catch (error) {
            console.error(t('modules.dependencies.errors.uninstallFailed', { name }), error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMessage };
        }
    }
    
    /**
     * 清除某个依赖的全部已加载模块缓存（含带子路径的缓存键，如 pdfjs-dist#legacy/build/pdf.mjs）。
     */
    private clearLoadedModules(name: string): void {
        for (const key of [...this.loadedModules.keys()]) {
            if (key === name || key.startsWith(`${name}#`)) {
                this.loadedModules.delete(key);
            }
        }
    }

    /**
     * 获取某个可选依赖的安装目录。
     *
     * ESM 依赖（例如 pdfjs-dist）需要用绝对路径动态 import；路径由管理器
     * 统一提供，避免调用方重新拼接自定义依赖目录。
     */
    getDependencyPath(name: string): string {
        return path.join(this.depsDir, name);
    }

    /**
     * 动态加载依赖
     * 
     * @param name 依赖名称
     * @returns 加载的模块，如果未安装则返回 null
     */
    async load<T = any>(name: string, subpath?: string): Promise<T | null> {
        // 缓存键：带子路径时区分多个入口（如 pdfjs-dist 的 build/ 与 legacy/build/）
        const cacheKey = subpath ? `${name}#${subpath}` : name;
        // 检查缓存
        if (this.loadedModules.has(cacheKey)) {
            return this.loadedModules.get(cacheKey);
        }
        
        // 检查是否已安装
        if (!await this.isInstalled(name)) {
            // 未安装：同步更新安装状态缓存，避免 isInstalledSync（缓存）与磁盘状态不一致
            //（与 require 失败路径同口径）
            this.installedCache.set(name, false);
            return null;
        }
        
        try {
            const modulePath = subpath
                ? path.join(this.getDependencyPath(name), subpath)
                : this.getDependencyPath(name);
            let mod: any;

            // 优先使用 CommonJS，兼容现有 sharp 等依赖。
            try {
                // 卸载后重装同一路径时，Node 的 require.cache 仍缓存旧版本模块
                //（loadedModules 缓存已随卸载/安装清除，但 require.cache 不会自动失效）。
                delete require.cache[require.resolve(modulePath)];
                mod = require(modulePath);
            } catch {
                // pdfjs-dist 4.x 是 ESM。使用原生 import() 加载，不能让 TypeScript
                // 把它降级为 require()，因此通过 Function 保留 Node 的原生动态 import。
                const resolvedPath = require.resolve(modulePath);
                const nativeImport = new Function('specifier', 'return import(specifier);') as
                    (specifier: string) => Promise<any>;
                mod = await nativeImport(pathToFileURL(resolvedPath).href);
            }

            this.loadedModules.set(cacheKey, mod);
            // 加载成功：同步更新安装状态缓存，避免 isInstalledSync（缓存）与磁盘状态不一致
            this.installedCache.set(name, true);
            return mod;
        } catch (error) {
            console.error(t('modules.dependencies.errors.loadFailed', { name }), error);
            // require/import 失败（模块损坏/平台不兼容/安装被删除）：同步置 false，与磁盘状态对齐
            this.installedCache.set(name, false);
            return null;
        }
    }
    
    /**
     * 订阅安装进度事件
     */
    onProgress(listener: (event: InstallProgressEvent) => void): () => void {
        this.progressListeners.add(listener);
        return () => {
            this.progressListeners.delete(listener);
        };
    }
    
    /**
     * 发送进度事件
     */
    private emitProgress(event: InstallProgressEvent): void {
        for (const listener of this.progressListeners) {
            try {
                listener(event);
            } catch (e) {
                console.error('Progress listener error:', e);
            }
        }
    }
    
    /**
     * 递归复制目录
     *
     * 使用 fs.promises.cp 替代手写递归：verbatimSymlinks 把符号链接（如
     * node_modules/.bin 下的链接）原样复制为链接，避免 copyFile 跟随目录符号链接
     * 抛 EISDIR；force 覆盖同名已存在文件。
     */
    private async copyDirectory(source: string, target: string): Promise<void> {
        await fs.promises.cp(source, target, { recursive: true, verbatimSymlinks: true, force: true });
    }
}

/**
 * 获取安装目录下的依赖路径（如果 DependencyManager 已初始化）。
 */
export function getDependencyPath(name: string): string | null {
    try {
        return DependencyManager.getInstance().getDependencyPath(name);
    } catch {
        return null;
    }
}

/**
 * 获取 sharp 模块（如果已安装）
 */
export async function getSharp(): Promise<any | null> {
    try {
        const manager = DependencyManager.getInstance();
        return await manager.load('sharp');
    } catch {
        // 如果 DependencyManager 未初始化，返回 null
        return null;
    }
}

/** 获取 pdfjs-dist 模块（如果已安装）。 */
export async function getPdfjs(): Promise<any | null> {
    try {
        const manager = DependencyManager.getInstance();
        // pdfjs-dist 4.x 的默认入口 build/pdf.mjs 是浏览器构建：在多处使用 DOM API
        // （如 document.createElement）测量/排版字体，Node 环境渲染时抛
        // "Cannot read properties of undefined (reading 'createElement')"；
        // legacy/build/pdf.mjs 是 Node 专用构建，官方推荐 Node 环境使用。
        // 少数旧本版未提供 legacy/build/pdf.mjs 时回退主入口。
        const legacyEntry = 'legacy/build/pdf.mjs';
        const legacyPath = path.join(manager.getDependencyPath('pdfjs-dist'), legacyEntry);
        try {
            if (fs.existsSync(legacyPath)) {
                return await manager.load('pdfjs-dist', legacyEntry);
            }
        } catch {
            // legacy 构建存在但加载失败（罕见）：回退主入口，交由调用方报错
        }
        return await manager.load('pdfjs-dist');
    } catch {
        return null;
    }
}

/** 获取 @napi-rs/canvas 模块（如果已安装）。 */
export async function getCanvas(): Promise<any | null> {
    try {
        const manager = DependencyManager.getInstance();
        return await manager.load('@napi-rs/canvas');
    } catch {
        return null;
    }
}