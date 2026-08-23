/**
 * 动态依赖管理器
 *
 * 可选依赖统一安装在独立的 node_modules 中。每次变更都会根据受管直接依赖集合
 * 重新生成一棵完整 staging 树，再通过同目录 rename 整体切换，避免逐目录覆盖造成
 * 新旧传递依赖混杂，也避免安装与卸载并发修改同一棵依赖树。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as childProcess from 'child_process';
import { promisify } from 'util';
import { pathToFileURL } from 'url';
import { t } from '../../i18n';

// Windows 上 npm 实际为 npm.cmd；cross-spawn 能在 shell:false 下正确解析启动器并保持参数边界。
const crossSpawn = require('cross-spawn') as typeof childProcess.spawn;

const mkdir = promisify(fs.mkdir);
const statAsync = promisify(fs.stat);
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const rm = promisify(fs.rm);

/** npm stdout + stderr 各自允许的最大累计字节数。 */
export const NPM_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 依赖信息
 */
export interface DependencyInfo {
    name: string;
    version: string;
    description: string;
    installed: boolean;
    installedVersion?: string;
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

interface OptionalDependencyConfig {
    version: string;
    descriptionKey: string;
    estimatedSize: number;
}

interface NpmInstallOutput {
    stdout: string;
    stderr: string;
}

/**
 * 依赖管理器
 */
export class DependencyManager {
    private static instance: DependencyManager;

    /** GrayCode 依赖根目录（默认 ~/.graycode 或自定义路径） */
    private readonly graycodeDir: string;

    /** 当前生效的完整依赖树 */
    private readonly depsDir: string;

    /** 进度事件监听器 */
    private readonly progressListeners = new Set<(event: InstallProgressEvent) => void>();

    /** 已加载模块缓存；子路径入口使用 name#subpath 键。 */
    private readonly loadedModules = new Map<string, any>();

    /** 依赖安装状态缓存（用于同步检查） */
    private readonly installedCache = new Map<string, boolean>();

    /** 同依赖并发调用复用同一个结果。 */
    private readonly installsInFlight = new Map<string, Promise<{ success: boolean; error?: string }>>();
    private readonly uninstallsInFlight = new Map<string, Promise<{ success: boolean; error?: string }>>();

    /**
     * 全部依赖变更共用一条队列。安装/卸载都会替换完整 node_modules，不能按依赖名并行。
     */
    private mutationQueue: Promise<void> = Promise.resolve();

    /** 支持的可选依赖配置（唯一白名单）。 */
    private readonly optionalDependencies: Record<string, OptionalDependencyConfig> = {
        sharp: {
            version: '^0.33.5',
            descriptionKey: 'modules.dependencies.descriptions.sharp',
            estimatedSize: 30
        },
        'pdfjs-dist': {
            version: '^4.10.38',
            descriptionKey: 'modules.dependencies.descriptions.pdfjsDist',
            estimatedSize: 18
        },
        '@napi-rs/canvas': {
            version: '^1.0.7',
            descriptionKey: 'modules.dependencies.descriptions.napiCanvas',
            estimatedSize: 12
        }
    };

    private constructor(private readonly context: vscode.ExtensionContext, customDepsPath?: string) {
        this.graycodeDir = customDepsPath || path.join(os.homedir(), '.graycode');
        this.depsDir = path.join(this.graycodeDir, 'node_modules');
    }

    /**
     * 获取单例实例。
     */
    static getInstance(context?: vscode.ExtensionContext, customDepsPath?: string): DependencyManager {
        const current = DependencyManager.instance;
        const needsRebuild = current
            && customDepsPath !== undefined
            && customDepsPath !== current.graycodeDir;

        if (needsRebuild) {
            if (!context) {
                throw new Error(t('modules.dependencies.errors.requiresContext'));
            }
            DependencyManager.instance = new DependencyManager(context, customDepsPath);
        } else if (!current) {
            if (!context) {
                throw new Error(t('modules.dependencies.errors.requiresContext'));
            }
            DependencyManager.instance = new DependencyManager(context, customDepsPath);
        }

        return DependencyManager.instance;
    }

    getInstallPath(): string {
        return this.graycodeDir;
    }

    /** 确保依赖根目录存在并刷新状态。真实 I/O 错误向上传递，不伪装成“目录已存在”。 */
    async initialize(): Promise<void> {
        await mkdir(this.graycodeDir, { recursive: true });
        await mkdir(this.depsDir, { recursive: true });
        await this.refreshInstalledCache();
    }

    async refreshInstalledCache(): Promise<void> {
        for (const name of Object.keys(this.optionalDependencies)) {
            this.installedCache.set(name, await this.isInstalled(name));
        }
    }

    isInstalledSync(name: string): boolean {
        return this.installedCache.get(name) ?? false;
    }

    async listDependencies(): Promise<DependencyInfo[]> {
        const result: DependencyInfo[] = [];
        for (const [name, config] of Object.entries(this.optionalDependencies)) {
            const installed = await this.isInstalled(name);
            result.push({
                name,
                version: config.version,
                description: t(config.descriptionKey as any),
                installed,
                installedVersion: installed ? await this.getInstalledVersion(name) : undefined,
                estimatedSize: config.estimatedSize
            });
        }
        return result;
    }

    async isInstalled(name: string): Promise<boolean> {
        if (!this.isSupportedDependency(name)) {
            return false;
        }
        try {
            const packageJsonPath = this.resolveManagedPackagePath(name, 'package.json');
            const stat = await statAsync(packageJsonPath);
            return stat.isFile();
        } catch {
            return false;
        }
    }

    async getInstalledVersion(name: string): Promise<string | undefined> {
        if (!this.isSupportedDependency(name)) {
            return undefined;
        }
        try {
            const packageJsonPath = this.resolveManagedPackagePath(name, 'package.json');
            const content = await readFile(packageJsonPath, 'utf-8');
            const pkg = JSON.parse(content);
            return typeof pkg?.version === 'string' ? pkg.version : undefined;
        } catch {
            return undefined;
        }
    }

    /** 安装受管依赖；同名请求复用结果，所有依赖树变更在全局队列中串行。 */
    async install(name: string): Promise<{ success: boolean; error?: string }> {
        const config = this.optionalDependencies[name];
        if (!config) {
            const error = t('modules.dependencies.errors.unknownDependency', { name });
            this.emitProgress({ type: 'error', dependency: name, error });
            return { success: false, error };
        }

        const existing = this.installsInFlight.get(name);
        if (existing) {
            return existing;
        }

        const promise = this.enqueueMutation(() => this.doInstall(name));
        this.installsInFlight.set(name, promise);
        try {
            return await promise;
        } finally {
            if (this.installsInFlight.get(name) === promise) {
                this.installsInFlight.delete(name);
            }
        }
    }

    private async doInstall(name: string): Promise<{ success: boolean; error?: string }> {
        this.emitProgress({
            type: 'start',
            dependency: name,
            message: t('modules.dependencies.progress.installing', { name })
        });

        try {
            await this.ensureRootDirectory();
            const desired = new Set(await this.getInstalledManagedDependencies());
            desired.add(name);

            this.emitProgress({
                type: 'progress',
                dependency: name,
                message: t('modules.dependencies.progress.downloading', { name })
            });

            await this.rebuildDependencyTree([...desired].sort(), name);
            this.refreshCachesAfterTreeSwap(desired);

            this.emitProgress({
                type: 'complete',
                dependency: name,
                message: t('modules.dependencies.progress.installSuccess', { name })
            });
            return { success: true };
        } catch (error) {
            const errorMessage = this.formatOperationError(error);
            const translated = t('modules.dependencies.errors.installFailed', { error: errorMessage });
            this.emitProgress({ type: 'error', dependency: name, error: translated });
            return { success: false, error: translated };
        }
    }

    /** 卸载受管依赖。未知名称在任何路径计算或 rm 之前即被拒绝。 */
    async uninstall(name: string): Promise<{ success: boolean; error?: string }> {
        if (!this.isSupportedDependency(name)) {
            const error = t('modules.dependencies.errors.unknownDependency', { name });
            this.emitProgress({ type: 'error', dependency: name, error });
            return { success: false, error };
        }

        const existing = this.uninstallsInFlight.get(name);
        if (existing) {
            return existing;
        }

        const promise = this.enqueueMutation(() => this.doUninstall(name));
        this.uninstallsInFlight.set(name, promise);
        try {
            return await promise;
        } finally {
            if (this.uninstallsInFlight.get(name) === promise) {
                this.uninstallsInFlight.delete(name);
            }
        }
    }

    private async doUninstall(name: string): Promise<{ success: boolean; error?: string }> {
        try {
            await this.ensureRootDirectory();
            const desired = new Set(await this.getInstalledManagedDependencies());
            if (!desired.delete(name)) {
                this.installedCache.set(name, false);
                this.clearLoadedModules(name);
                return { success: true };
            }

            await this.rebuildDependencyTree([...desired].sort(), name);
            this.refreshCachesAfterTreeSwap(desired);
            return { success: true };
        } catch (error) {
            console.error(t('modules.dependencies.errors.uninstallFailed', { name }), error);
            return {
                success: false,
                error: this.formatOperationError(error)
            };
        }
    }

    /**
     * 根据受管直接依赖集合构建完整 staging node_modules，并整体原子切换。
     * staging 与目标位于同一父目录，rename 不跨卷。
     */
    private async rebuildDependencyTree(desiredNames: string[], operationName: string): Promise<void> {
        const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const tempDir = path.join(this.graycodeDir, `deps-tree-temp-${nonce}`);
        const stagedNodeModules = path.join(tempDir, 'node_modules');
        const backupDir = path.join(this.graycodeDir, `node_modules.deps-backup-${nonce}`);

        await mkdir(tempDir, { recursive: true });
        try {
            if (desiredNames.length > 0) {
                const dependencies = Object.fromEntries(
                    desiredNames.map(name => [name, this.optionalDependencies[name].version])
                );
                await writeFile(
                    path.join(tempDir, 'package.json'),
                    JSON.stringify({ name: 'graycode-managed-dependencies', version: '1.0.0', private: true, dependencies }, null, 2)
                );

                const output = await this.runNpmInstall(tempDir);
                console.log(
                    `[deps] npm rebuild for ${operationName} finished `
                    + `(stdout ${output.stdout.length} chars, stderr ${output.stderr.length} chars)`
                );

                for (const name of desiredNames) {
                    const packageJsonPath = this.resolvePackagePathInside(stagedNodeModules, name, 'package.json');
                    try {
                        const stat = await statAsync(packageJsonPath);
                        if (!stat.isFile()) throw new Error('not a file');
                    } catch {
                        throw new Error(t('modules.dependencies.errors.moduleNotFound', { name }));
                    }
                }
            } else {
                await mkdir(stagedNodeModules, { recursive: true });
            }

            await this.swapDependencyTree(stagedNodeModules, backupDir);
        } finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    /** 运行 npm，并在数据到达时实时执行字节上限检查。 */
    private async runNpmInstall(tempDir: string): Promise<NpmInstallOutput> {
        const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        return new Promise<NpmInstallOutput>((resolve, reject) => {
            const child = crossSpawn(npmCommand, ['install', '--prefix', tempDir, '--no-save'], {
                cwd: tempDir,
                timeout: 300000,
                windowsHide: true
            });

            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let settled = false;

            const rejectOnce = (error: Error): void => {
                if (settled) return;
                settled = true;
                child.kill();
                reject(error);
            };

            const collect = (target: Buffer[], chunk: Buffer | string, stream: 'stdout' | 'stderr'): void => {
                if (settled) return;
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                if (stream === 'stdout') {
                    stdoutBytes += buffer.length;
                    if (stdoutBytes > NPM_OUTPUT_MAX_BYTES) {
                        rejectOnce(new Error(`npm stdout exceeded ${NPM_OUTPUT_MAX_BYTES} bytes`));
                        return;
                    }
                } else {
                    stderrBytes += buffer.length;
                    if (stderrBytes > NPM_OUTPUT_MAX_BYTES) {
                        rejectOnce(new Error(`npm stderr exceeded ${NPM_OUTPUT_MAX_BYTES} bytes`));
                        return;
                    }
                }
                target.push(buffer);
            };

            child.stdout?.on('data', chunk => collect(stdoutChunks, chunk, 'stdout'));
            child.stderr?.on('data', chunk => collect(stderrChunks, chunk, 'stderr'));
            child.on('error', (error: Error) => rejectOnce(error));
            child.on('close', (code, signal) => {
                if (settled) return;
                settled = true;
                const stdout = Buffer.concat(stdoutChunks).toString();
                const stderr = Buffer.concat(stderrChunks).toString();
                if (code === 0) {
                    resolve({ stdout, stderr });
                    return;
                }
                const error = new Error(
                    `npm install exited with code ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}`
                ) as Error & { stdout?: string; stderr?: string };
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
            });
        });
    }

    /**
     * 整树提交：旧树先改名为备份，staging 再改名到正式位置；第二步失败时恢复旧树。
     */
    private async swapDependencyTree(stagedNodeModules: string, backupDir: string): Promise<void> {
        await rm(backupDir, { recursive: true, force: true });
        let oldTreeMoved = false;
        let newTreeCommitted = false;
        try {
            try {
                await fs.promises.rename(this.depsDir, backupDir);
                oldTreeMoved = true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }

            await fs.promises.rename(stagedNodeModules, this.depsDir);
            newTreeCommitted = true;
        } catch (error) {
            if (newTreeCommitted) {
                await rm(this.depsDir, { recursive: true, force: true }).catch(() => undefined);
            }
            if (oldTreeMoved) {
                await fs.promises.rename(backupDir, this.depsDir).catch(restoreError => {
                    console.error('[deps] failed to restore dependency tree after swap failure:', restoreError);
                });
            }
            throw error;
        }

        if (oldTreeMoved) {
            await rm(backupDir, { recursive: true, force: true }).catch(error => {
                console.warn('[deps] committed dependency tree but failed to remove previous tree:', error);
            });
        }
    }

    private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.mutationQueue.then(operation, operation);
        this.mutationQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    private async ensureRootDirectory(): Promise<void> {
        await mkdir(this.graycodeDir, { recursive: true });
        await mkdir(this.depsDir, { recursive: true });
    }

    private async getInstalledManagedDependencies(): Promise<string[]> {
        const installed: string[] = [];
        for (const name of Object.keys(this.optionalDependencies)) {
            if (await this.isInstalled(name)) installed.push(name);
        }
        return installed;
    }

    private refreshCachesAfterTreeSwap(installedNames: ReadonlySet<string>): void {
        this.clearAllLoadedModules();
        for (const name of Object.keys(this.optionalDependencies)) {
            this.installedCache.set(name, installedNames.has(name));
        }
    }

    private clearLoadedModules(name: string): void {
        for (const key of [...this.loadedModules.keys()]) {
            if (key === name || key.startsWith(`${name}#`)) {
                this.loadedModules.delete(key);
            }
        }
        this.clearRequireCacheUnder(this.resolveManagedPackagePath(name));
    }

    private clearAllLoadedModules(): void {
        this.loadedModules.clear();
        this.clearRequireCacheUnder(this.depsDir);
    }

    private clearRequireCacheUnder(rootPath: string): void {
        const root = `${path.resolve(rootPath)}${path.sep}`;
        for (const cachePath of Object.keys(require.cache)) {
            const resolved = path.resolve(cachePath);
            if (resolved === path.resolve(rootPath) || resolved.startsWith(root)) {
                delete require.cache[cachePath];
            }
        }
    }

    private isSupportedDependency(name: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.optionalDependencies, name);
    }

    /** 构造受管包路径并验证最终路径仍位于 node_modules 内。 */
    private resolveManagedPackagePath(name: string, ...segments: string[]): string {
        if (!this.isSupportedDependency(name)) {
            throw new Error(t('modules.dependencies.errors.unknownDependency', { name }));
        }
        return this.resolvePackagePathInside(this.depsDir, name, ...segments);
    }

    private resolvePackagePathInside(root: string, name: string, ...segments: string[]): string {
        const resolvedRoot = path.resolve(root);
        const resolved = path.resolve(resolvedRoot, name, ...segments);
        const relative = path.relative(resolvedRoot, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Dependency path escapes managed root: ${name}`);
        }
        return resolved;
    }

    private formatOperationError(error: unknown): string {
        const anyError = error as { stderr?: unknown };
        const stderrDetails = anyError?.stderr
            ? String(anyError.stderr).trim().split(/\r?\n/).slice(-15).join('\n')
            : '';
        const message = error instanceof Error ? error.message : String(error);
        return message + (stderrDetails ? `\n${stderrDetails}` : '');
    }

    /** 获取某个可选依赖的安装目录。 */
    getDependencyPath(name: string): string {
        return this.resolveManagedPackagePath(name);
    }

    /** 动态加载依赖；subpath 用于 pdfjs-dist 的 legacy ESM 入口。 */
    async load<T = any>(name: string, subpath?: string): Promise<T | null> {
        if (!this.isSupportedDependency(name)) {
            return null;
        }
        const cacheKey = subpath ? `${name}#${subpath}` : name;
        if (this.loadedModules.has(cacheKey)) {
            return this.loadedModules.get(cacheKey);
        }
        if (!await this.isInstalled(name)) {
            this.installedCache.set(name, false);
            return null;
        }

        try {
            const modulePath = subpath
                ? this.resolveManagedPackagePath(name, subpath)
                : this.resolveManagedPackagePath(name);
            let mod: any;
            try {
                delete require.cache[require.resolve(modulePath)];
                mod = require(modulePath);
            } catch {
                const resolvedPath = require.resolve(modulePath);
                const nativeImport = new Function('specifier', 'return import(specifier);') as
                    (specifier: string) => Promise<any>;
                mod = await nativeImport(pathToFileURL(resolvedPath).href);
            }
            this.loadedModules.set(cacheKey, mod);
            this.installedCache.set(name, true);
            return mod;
        } catch (error) {
            console.error(t('modules.dependencies.errors.loadFailed', { name }), error);
            this.installedCache.set(name, false);
            return null;
        }
    }

    onProgress(listener: (event: InstallProgressEvent) => void): () => void {
        this.progressListeners.add(listener);
        return () => this.progressListeners.delete(listener);
    }

    private emitProgress(event: InstallProgressEvent): void {
        for (const listener of this.progressListeners) {
            try {
                listener(event);
            } catch (error) {
                console.error('Progress listener error:', error);
            }
        }
    }
}

/** 获取安装目录下的依赖路径（如果 DependencyManager 已初始化）。 */
export function getDependencyPath(name: string): string | null {
    try {
        return DependencyManager.getInstance().getDependencyPath(name);
    } catch {
        return null;
    }
}

/** 获取 sharp 模块（如果已安装）。 */
export async function getSharp(): Promise<any | null> {
    try {
        return await DependencyManager.getInstance().load('sharp');
    } catch {
        return null;
    }
}

/** 获取 pdfjs-dist 模块（如果已安装）。 */
export async function getPdfjs(): Promise<any | null> {
    try {
        const manager = DependencyManager.getInstance();
        const legacyEntry = 'legacy/build/pdf.mjs';
        const legacyPath = path.join(manager.getDependencyPath('pdfjs-dist'), legacyEntry);
        if (fs.existsSync(legacyPath)) {
            const legacy = await manager.load('pdfjs-dist', legacyEntry);
            if (legacy) return legacy;
        }
        return await manager.load('pdfjs-dist');
    } catch {
        return null;
    }
}

/** 获取 @napi-rs/canvas 模块（如果已安装）。 */
export async function getCanvas(): Promise<any | null> {
    try {
        return await DependencyManager.getInstance().load('@napi-rs/canvas');
    } catch {
        return null;
    }
}
