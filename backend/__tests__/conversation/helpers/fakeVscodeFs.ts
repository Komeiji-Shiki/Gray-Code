/**
 * 测试辅助：内存版 vscode.workspace.fs（键为规范化 fsPath）。
 *
 * 供 storageAppend.test.ts / ConversationManager.appendAndMetadata.test.ts 等
 * 验证 FileSystemStorageAdapter 的真实读写路径（写临时文件、原子 rename 等）。
 */

import { Uri, FileType } from 'vscode';
import { FileSystemStorageAdapter } from '../../../modules/conversation/storage';

export interface FakeFsStats {
    readCalls: string[];
    writeCalls: string[];
    deleteCalls: string[];
    renameCalls: string[];
    files: Map<string, string>;
    dirs: Set<string>;
    /** 稳定的每文件 mtime（首次 stat 分配、写入/重命名时递增），供 M5 外部变更失效测试手动 bump */
    mtimes: Map<string, number>;
}

export function normPath(p: string): string {
    return p.replace(/\\/g, '/');
}

export function createFakeFs(options: { failWriteMatching?: (normPath: string) => boolean } = {}): FakeFsStats & { fs: any } {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    const mtimes = new Map<string, number>();
    let mtimeClock = 1;
    const readCalls: string[] = [];
    const writeCalls: string[] = [];
    const deleteCalls: string[] = [];
    const renameCalls: string[] = [];

    const assignMtime = (p: string): number => {
        const m = mtimeClock++;
        mtimes.set(p, m);
        return m;
    };

    const ensureParents = (p: string): void => {
        const parts = p.split('/');
        parts.pop();
        let acc = '';
        for (const part of parts) {
            acc = acc ? `${acc}/${part}` : part;
            if (acc) dirs.add(acc);
        }
    };

    const fs: any = {
        async stat(uri: any) {
            const p = normPath(uri.fsPath);
            if (files.has(p)) return { type: FileType.File, size: files.get(p)!.length, mtime: mtimes.get(p) ?? assignMtime(p) };
            if (dirs.has(p)) return { type: FileType.Directory, size: 0, mtime: mtimes.get(p) ?? assignMtime(p) };
            const err: any = new Error('EntryNotFound');
            err.code = 'EntryNotFound';
            throw err;
        },
        async readFile(uri: any) {
            const p = normPath(uri.fsPath);
            readCalls.push(p);
            if (!files.has(p)) {
                const err: any = new Error('EntryNotFound');
                err.code = 'EntryNotFound';
                throw err;
            }
            return Buffer.from(files.get(p)!, 'utf8');
        },
        async writeFile(uri: any, content: Uint8Array) {
            const p = normPath(uri.fsPath);
            if (options.failWriteMatching?.(p)) {
                throw new Error(`simulated write failure: ${p}`);
            }
            writeCalls.push(p);
            files.set(p, Buffer.from(content).toString('utf8'));
            mtimes.set(p, mtimeClock++);
            ensureParents(p);
        },
        async createDirectory(uri: any) {
            const p = normPath(uri.fsPath);
            dirs.add(p);
            ensureParents(p);
        },
        async delete(uri: any, opts?: any) {
            const p = normPath(uri.fsPath);
            deleteCalls.push(p);
            if (opts?.recursive) {
                for (const key of Array.from(files.keys())) {
                    if (key.startsWith(p + '/')) files.delete(key);
                }
                for (const d of Array.from(dirs)) {
                    if (d === p || d.startsWith(p + '/')) dirs.delete(d);
                }
            } else {
                files.delete(p);
                dirs.delete(p);
                mtimes.delete(p);
            }
        },
        async rename(src: any, dest: any, opts?: any) {
            const s = normPath(src.fsPath);
            const d = normPath(dest.fsPath);
            renameCalls.push(`${s} -> ${d}`);
            if (opts?.overwrite) {
                files.delete(d);
                dirs.delete(d);
            }
            if (dirs.has(s)) {
                for (const key of Array.from(files.keys())) {
                    if (key.startsWith(s + '/')) {
                        files.set(d + key.slice(s.length), files.get(key)!);
                        files.delete(key);
                        if (mtimes.has(key)) {
                            mtimes.set(d + key.slice(s.length), mtimes.get(key)!);
                            mtimes.delete(key);
                        }
                    }
                }
                dirs.delete(s);
                dirs.add(d);
                ensureParents(d);
                return;
            }
            if (!files.has(s)) {
                const err: any = new Error('EntryNotFound');
                err.code = 'EntryNotFound';
                throw err;
            }
            files.set(d, files.get(s)!);
            files.delete(s);
            if (mtimes.has(s)) {
                mtimes.set(d, mtimes.get(s)!);
                mtimes.delete(s);
            } else {
                mtimes.set(d, mtimeClock++);
            }
            ensureParents(d);
        },
        async readDirectory(uri: any) {
            const p = normPath(uri.fsPath);
            const result: Array<[string, number]> = [];
            const seen = new Set<string>();
            for (const key of files.keys()) {
                if (!key.startsWith(p + '/')) continue;
                const rest = key.slice(p.length + 1);
                const top = rest.split('/')[0];
                if (seen.has(top)) continue;
                seen.add(top);
                result.push([top, FileType.File]);
            }
            for (const d of dirs) {
                if (!d.startsWith(p + '/')) continue;
                const rest = d.slice(p.length + 1);
                const top = rest.split('/')[0];
                if (seen.has(top)) continue;
                seen.add(top);
                result.push([top, FileType.Directory]);
            }
            return result;
        }
    };

    return { fs, files, dirs, mtimes, readCalls, writeCalls, deleteCalls, renameCalls };
}

export function createAdapter(
    options: { failWriteMatching?: (p: string) => boolean } = {},
    baseDir = 'file:///c%3A/data/graycode'
): { adapter: FileSystemStorageAdapter; fake: FakeFsStats } {
    const fake = createFakeFs(options);
    const vscode = { Uri, workspace: { fs: fake.fs }, FileType };
    const adapter = new FileSystemStorageAdapter(vscode as any, baseDir);
    return { adapter, fake };
}

export { Uri };
