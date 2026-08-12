/**
 * 性能基准共享工具（MIG-09）。
 *
 * 提供：
 * - withTiming：墙钟时间（hrtime 高精度）+ 堆内存增量（--expose-gc 时先 GC 再采样）
 * - 报告打印：分区标题 / 指标行（耗时 / 内存 / 附加数据）
 * - 真实文件系统版 vscode shim：FileSystemStorageAdapter / FileUsageIndexStore
 *   依赖 vscode.Uri + workspace.fs（stat/readFile/writeFile/createDirectory/delete/
 *   rename/readDirectory），这里用 fs/promises 落到真实临时目录，测真实磁盘 IO。
 * - 临时目录管理（基准绝不触碰真实数据目录）。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileUriToFilePath } from '../../shared/uriParseShim';

export interface BenchmarkData {
    [key: string]: number | string;
}

export interface BenchmarkMetric {
    label: string;
    ms: number;
    heapDeltaMB: number;
    data?: BenchmarkData;
}

export interface TimedResult<T> {
    result: T;
    ms: number;
    heapDeltaMB: number;
}

function tryGc(): void {
    const g = (globalThis as unknown as { gc?: () => void }).gc;
    if (typeof g === 'function') {
        try {
            g();
        } catch {
            // 忽略：未以 --expose-gc 启动时不可用
        }
    }
}

/** 当前进程是否可调用全局 gc（--expose-gc 启动）。 */
function isGcAvailable(): boolean {
    return typeof (globalThis as unknown as { gc?: unknown }).gc === 'function';
}

let harnessBannerPrinted = false;

/**
 * 打印 harness 提示首行（每进程只打印一次）：GC 是否可用（F7）。
 * 无 --expose-gc 时 heapDelta 仅作参考，printMetric 会以 `~` 标记。
 */
export function printHarnessBanner(): void {
    if (harnessBannerPrinted) {
        return;
    }
    harnessBannerPrinted = true;
    console.log(`[harness] GC available: ${isGcAvailable() ? 'true' : 'false'}（无 --expose-gc 时 heapDelta 以 ~ 标记，仅作参考）`);
}

/** 运行 fn 并测量墙钟时间与堆内存增量（若可用）。 */
export async function withTiming<T>(fn: () => Promise<T>): Promise<TimedResult<T>> {
    tryGc();
    const heapBefore = process.memoryUsage().heapUsed;
    const start = process.hrtime.bigint();
    const result = await fn();
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    tryGc();
    const heapAfter = process.memoryUsage().heapUsed;
    return { result, ms, heapDeltaMB: (heapAfter - heapBefore) / 1048576 };
}

export function formatMs(ms: number): string {
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

export function formatMB(mb: number): string {
    return `${mb.toFixed(1)} MB`;
}

export function printSection(title: string): void {
    console.log('\n' + '='.repeat(72));
    console.log(`  ${title}`);
    console.log('='.repeat(72));
}

export function printMetric(metric: BenchmarkMetric): void {
    const dataStr = metric.data && Object.keys(metric.data).length > 0
        ? ` | ${Object.entries(metric.data).map(([k, v]) => `${k}=${v}`).join(', ')}`
        : '';
    // F7：无 --expose-gc 时堆增量采样时机不定，以 ~ 标记仅供参考
    const heapMark = isGcAvailable() ? (metric.heapDeltaMB >= 0 ? '+' : '') : '~';
    console.log(
        `  ${metric.label.padEnd(44)} ${formatMs(metric.ms).padStart(10)}  heap ${heapMark}${formatMB(metric.heapDeltaMB).padStart(8)}${dataStr}`
    );
}

// ==================== 真实文件系统 vscode shim ====================

interface ShimUri {
    fsPath: string;
    scheme: string;
    path: string;
}

interface ShimFileStat {
    type: number;
    size: number;
    mtime: number;
    ctime: number;
}

interface ShimFileSystem {
    stat(uri: ShimUri): Promise<ShimFileStat>;
    readFile(uri: ShimUri): Promise<Uint8Array>;
    writeFile(uri: ShimUri, content: Uint8Array): Promise<void>;
    createDirectory(uri: ShimUri): Promise<void>;
    delete(uri: ShimUri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void>;
    rename(source: ShimUri, target: ShimUri): Promise<void>;
    readDirectory(uri: ShimUri): Promise<Array<[string, number]>>;
}

export interface VscodeShim {
    Uri: {
        parse(value: string): ShimUri;
        file(value: string): ShimUri;
        joinPath(base: ShimUri, ...segments: string[]): ShimUri;
    };
    workspace: { fs: ShimFileSystem };
    FileType: { File: number; Directory: number; SymbolicLink: number; Unknown: number };
}

/**
 * 用 fs/promises 落盘的真实 vscode shim。
 *
 * 覆盖 FileSystemStorageAdapter / FileUsageIndexStore 用到的 API 面：
 * Uri.parse / Uri.joinPath / workspace.fs.{stat, readFile, writeFile,
 * createDirectory, delete, rename, readDirectory}。rename 不做 overwrite 兜底——
 * 适配器自身的 renameOverwrite 会处理目标存在的情况。
 */
export function createRealFsVscodeShim(): VscodeShim {
    const FileType = { File: 1, Directory: 2, SymbolicLink: 64, Unknown: 0 };
    const uriCache = new Map<string, ShimUri>();

    const toUri = (fsPath: string): ShimUri => {
        const norm = path.normalize(fsPath);
        let uri = uriCache.get(norm);
        if (!uri) {
            uri = { fsPath: norm, scheme: 'file', path: norm.split(path.sep).join('/') };
            uriCache.set(norm, uri);
        }
        return uri;
    };

    const Uri = {
        parse: (value: string): ShimUri => {
            // E-21：与 backend/__tests__/__mocks__/vscode.ts 共用 shared/uriParseShim.ts
            // 的 file:// 归一化逻辑，防两处 shim 各自演化漂移。
            const filePath = fileUriToFilePath(value);
            if (filePath !== null) {
                return toUri(filePath);
            }
            return toUri(value);
        },
        file: (value: string): ShimUri => toUri(value),
        joinPath: (base: ShimUri, ...segments: string[]): ShimUri => toUri(path.join(base.fsPath, ...segments)),
    };

    const fsShim: ShimFileSystem = {
        async stat(uri: ShimUri) {
            const st = await fs.stat(uri.fsPath);
            return {
                type: st.isDirectory() ? FileType.Directory : FileType.File,
                size: st.size,
                mtime: st.mtimeMs,
                ctime: st.ctimeMs,
            };
        },
        async readFile(uri: ShimUri): Promise<Uint8Array> {
            return await fs.readFile(uri.fsPath);
        },
        async writeFile(uri: ShimUri, content: Uint8Array): Promise<void> {
            await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
            await fs.writeFile(uri.fsPath, content);
        },
        async createDirectory(uri: ShimUri): Promise<void> {
            await fs.mkdir(uri.fsPath, { recursive: true });
        },
        async delete(uri: ShimUri, opts?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
            await fs.rm(uri.fsPath, { recursive: opts?.recursive === true, force: true });
        },
        async rename(src: ShimUri, dest: ShimUri): Promise<void> {
            await fs.rename(src.fsPath, dest.fsPath);
        },
        async readDirectory(uri: ShimUri): Promise<Array<[string, number]>> {
            const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
            return entries.map(entry => [
                entry.name,
                entry.isDirectory() ? FileType.Directory : FileType.File,
            ]);
        },
    };

    return { Uri, workspace: { fs: fsShim }, FileType };
}

// ==================== 临时目录 ====================

export async function makeTempDir(prefix: string): Promise<string> {
    return await fs.mkdtemp(path.join(os.tmpdir(), `graycode-bench-${prefix}-`));
}

export async function removeTempDir(dir: string): Promise<void> {
    await fs.rm(dir, { recursive: true, force: true });
}

/**
 * 递归统计目录内文件数与总字节数（F9）。
 * 符号链接按目标 stat：目标是目录则继续遍历，是文件则计入；断链按 0 字节文件计。
 * visitedDirs（realpath 去重）防止符号链接目录环导致死循环。
 */
export async function countFilesAndBytes(dir: string): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    const visitedDirs = new Set<string>();
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop()!;
        let real: string;
        try {
            real = await fs.realpath(current);
        } catch {
            real = current;
        }
        if (visitedDirs.has(real)) {
            continue;
        }
        visitedDirs.add(real);
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.isFile()) {
                files++;
                bytes += (await fs.stat(full)).size;
            } else if (entry.isSymbolicLink()) {
                try {
                    const st = await fs.stat(full);
                    if (st.isDirectory()) {
                        stack.push(full);
                    } else {
                        files++;
                        bytes += st.size;
                    }
                } catch {
                    files++; // 断链符号链接：仍算一个条目，0 字节
                }
            }
        }
    }
    return { files, bytes };
}
