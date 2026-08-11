/**
 * appendHistory（append-only 尾段写入，HIS-01）与段级缓存（HIS-05/HIS-06）测试。
 *
 * 使用内存版 workspace.fs（键为规范化 fsPath）验证：
 * - 普通追加只修改尾段与 index，不重写全部段；
 * - 尾段满 200 条后新建下一段；
 * - append 中途失败（写临时尾段失败 / 写临时 index 失败）不破坏旧 index（index 是提交点）；
 * - 段级缓存命中跳过读盘、写后失效；
 * - getHistoryIndexInfo 只读 index，不解析段消息。
 */

import { FileSystemStorageAdapter } from '../../modules/conversation/storage';
import type { ConversationHistory, Content } from '../../modules/conversation/types';
import { Uri, FileType } from 'vscode';
import { makeContent, makeHistory } from '../__fixtures__/conversationFixtures';

interface FakeFsStats {
    readCalls: string[];
    writeCalls: string[];
    deleteCalls: string[];
    renameCalls: string[];
    files: Map<string, string>;
    dirs: Set<string>;
    /** 稳定的每文件 mtime（首次 stat 分配、写入/重命名时递增），供 M5 外部变更失效测试手动 bump */
    mtimes: Map<string, number>;
}

function normPath(p: string): string {
    return p.replace(/\\/g, '/');
}

function createFakeFs(options: { failWriteMatching?: (normPath: string) => boolean } = {}): FakeFsStats & { fs: any } {
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

function createAdapter(options: { failWriteMatching?: (p: string) => boolean } = {}): {
    adapter: FileSystemStorageAdapter;
    fake: FakeFsStats;
} {
    const fake = createFakeFs(options);
    const vscode = { Uri, workspace: { fs: fake.fs }, FileType };
    const adapter = new FileSystemStorageAdapter(vscode as any, 'file:///c%3A/data/graycode');
    return { adapter, fake };
}


const SEGMENT_SIZE = (FileSystemStorageAdapter as any).HISTORY_SEGMENT_SIZE as number;

describe('FileSystemStorageAdapter.appendHistory（HIS-01）', () => {
    test('普通追加只修改尾段与 index：不重写全部段、不删 history 目录', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv1', makeHistory(50));

        fake.writeCalls.length = 0;
        fake.deleteCalls.length = 0;
        fake.renameCalls.length = 0;

        await adapter.appendHistory('conv1', makeHistory(3, 'append'));

        // 完整历史 = 50 + 3
        const full = await adapter.loadHistory('conv1');
        expect(full).toHaveLength(53);

        // 写盘只涉及：临时尾段 + 临时 index（两个 writeFile），
        // 段文件与 index 通过 rename 原子替换，且没有删除 history 目录（未全量重写）。
        const tmpSegmentWrites = fake.writeCalls.filter(p => p.includes('history.append.tmp.ndjson'));
        const tmpIndexWrites = fake.writeCalls.filter(p => p.includes('history.index.json.tmp'));
        expect(tmpSegmentWrites).toHaveLength(1);
        expect(tmpIndexWrites).toHaveLength(1);
        expect(fake.renameCalls.some(r => r.includes('history.append.tmp.ndjson'))).toBe(true);
        expect(fake.deleteCalls.some(p => p.includes('/history'))).toBe(false);
    });

    test('尾段满 200 条后新建下一段，index 正确记录两个段', async () => {
        const { adapter } = createAdapter();
        await adapter.saveHistory('conv1', makeHistory(SEGMENT_SIZE));

        await adapter.appendHistory('conv1', makeHistory(1, 'extra'));

        const full = await adapter.loadHistory('conv1');
        expect(full).toHaveLength(SEGMENT_SIZE + 1);

        // 分页读取第二段内容
        const page = await adapter.loadHistoryPage('conv1', { offset: SEGMENT_SIZE, limit: 10 });
        expect(page.value).not.toBeNull();
        expect(page.value!.total).toBe(SEGMENT_SIZE + 1);
        expect(page.value!.messages).toHaveLength(1);
        expect((page.value!.messages[0].parts[0] as any).text).toBe('extra0');

        // index 有两个段
        const info = await adapter.getHistoryIndexInfo('conv1');
        expect(info.segmentCount).toBe(2);
        expect(info.totalMessages).toBe(SEGMENT_SIZE + 1);
    });

    test('批量追加超过段大小会拆分写入多个段', async () => {
        const { adapter } = createAdapter();
        await adapter.saveHistory('conv1', makeHistory(SEGMENT_SIZE - 10));

        // 一次追加 20 条：10 条填入尾段、10 条进入新段
        await adapter.appendHistory('conv1', makeHistory(20, 'bulk'));

        const full = await adapter.loadHistory('conv1');
        expect(full).toHaveLength(SEGMENT_SIZE + 10);

        const info = await adapter.getHistoryIndexInfo('conv1');
        expect(info.segmentCount).toBe(2);
        expect(info.totalMessages).toBe(SEGMENT_SIZE + 10);
    });

    test('写临时尾段失败：append 抛错且旧历史与旧 index 完全不变', async () => {
        const { adapter, fake } = createAdapter({
            failWriteMatching: p => p.includes('history.append.tmp.ndjson')
        });
        await adapter.saveHistory('conv1', makeHistory(5));

        await expect(adapter.appendHistory('conv1', makeHistory(2))).rejects.toThrow(/simulated write failure/);

        const full = await adapter.loadHistory('conv1');
        expect(full).toHaveLength(5);
        const info = await adapter.getHistoryIndexInfo('conv1');
        expect(info.totalMessages).toBe(5);
        expect(info.segmentCount).toBe(1);
        expect(fake.renameCalls.filter(r => r.includes('history.append.tmp.ndjson'))).toHaveLength(0);
    });

    test('index 是提交点：临时 index 写失败后，段文件多出的行不会进入完整历史', async () => {
        // 只在 append 阶段注入 index 写失败（初始 saveHistory 不受影响）
        let armFailure = false;
        const { adapter } = createAdapter({
            failWriteMatching: p => armFailure && p.includes('history.index.json.tmp')
        });
        await adapter.saveHistory('conv1', makeHistory(3));
        armFailure = true;

        await expect(adapter.appendHistory('conv1', makeHistory(2))).rejects.toThrow(/simulated write failure/);

        // 旧 index 仍是 3 条：完整历史与分页都只看到 3 条（多出的段行被 index.count 截断）
        const full = await adapter.loadHistory('conv1');
        expect(full).toHaveLength(3);
        const page = await adapter.loadHistoryPage('conv1', { limit: 100 });
        expect(page.value!.total).toBe(3);
        expect(page.value!.messages).toHaveLength(3);
        const info = await adapter.getHistoryIndexInfo('conv1');
        expect(info.totalMessages).toBe(3);
    });

    test('追加到已删除/不存在索引的历史：合并 legacy 后全量重写（罕见路径）', async () => {
        const { adapter, fake } = createAdapter();
        // legacy 单文件历史
        const legacy: ConversationHistory = makeHistory(2);
        fake.files.set(
            normPath(`${(Uri.parse('file:///c%3A/data/graycode') as any).fsPath}/conversations/conv_legacy.json`),
            JSON.stringify(legacy)
        );

        await adapter.appendHistory('conv_legacy', makeHistory(2, 'new'));

        const full = await adapter.loadHistory('conv_legacy');
        expect(full).toHaveLength(4);
    });

    test('H1：index 写失败后再次 append：totalMessages == Σcount 且残留不泄漏', async () => {
        let armFailure = false;
        const { adapter, fake } = createAdapter({
            failWriteMatching: p => armFailure && p.includes('history.index.json.tmp')
        });
        await adapter.saveHistory('conv1', makeHistory(3));
        armFailure = true;

        // 第一次 append：尾段 rename 成功（段文件写入 5 行），index 写失败 → 抛错
        await expect(adapter.appendHistory('conv1', makeHistory(2, 'stale'))).rejects.toThrow(/simulated write failure/);

        // 尾段文件确实残留了 2 行未提交内容（证明 H1 场景成立）
        const segPath = [...fake.files.keys()].find(p => p.endsWith('000000.ndjson'))!;
        expect(segPath).toBeTruthy();
        expect(fake.files.get(segPath)!.split('\n').filter(l => l.trim())).toHaveLength(5);
        // 读取时按 index.count 截断：完整历史仍只有 3 条
        const afterFail = await adapter.loadHistory('conv1');
        expect(afterFail).toHaveLength(3);

        // 解除失败，再次 append 1 条：必须按提交点截断残留，不能把残留算进 count
        armFailure = false;
        await adapter.appendHistory('conv1', makeHistory(1, 'retry'));

        const full = await adapter.loadHistory('conv1');
        expect(full).toHaveLength(4);
        // 残留的 2 条（stale0/stale1）不得进入历史，只有新追加的 retry0
        expect(full!.some(m => (m.parts[0] as any).text === 'stale0')).toBe(false);
        expect(full!.some(m => (m.parts[0] as any).text === 'stale1')).toBe(false);
        expect(full!.some(m => (m.parts[0] as any).text === 'retry0')).toBe(true);

        // totalMessages == Σcount，且分页与全量口径一致（末段 endIndex 不超界）
        const info = await adapter.getHistoryIndexInfo('conv1');
        expect(info.totalMessages).toBe(4);
        expect(info.segmentCount).toBe(1);
        const page = await adapter.loadHistoryPage('conv1', { limit: 100 });
        expect(page.value!.total).toBe(4);
        expect(page.value!.messages).toHaveLength(4);
        expect((page.value!.messages[3].parts[0] as any).text).toBe('retry0');
    });

    test('M4：index 存在但尾段文件缺失：append 回退全量重写自愈（不抛错）', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv1', makeHistory(5));
        // 删除尾段文件（模拟缺失/损坏）
        const segPath = [...fake.files.keys()].find(p => p.endsWith('000000.ndjson'))!;
        expect(segPath).toBeTruthy();
        fake.files.delete(segPath!);
        fake.mtimes.delete(segPath!);

        await adapter.appendHistory('conv1', makeHistory(2, 'new'));

        const full = await adapter.loadHistory('conv1');
        expect(full).toHaveLength(2); // 损坏段被丢弃，只保留新追加
        expect((full![0].parts[0] as any).text).toBe('new0');
        const info = await adapter.getHistoryIndexInfo('conv1');
        expect(info.totalMessages).toBe(2);
        expect(info.segmentCount).toBe(1);
    });
});

describe('FileSystemStorageAdapter 段级缓存（HIS-06）', () => {
    test('重复读取命中缓存跳过读盘；append 提交后写后失效', async () => {
        const { adapter, fake } = createAdapter();
        // 210 条 → 2 个段（200 + 10）；最后一页（limit 120）跨越两个段
        await adapter.saveHistory('conv1', makeHistory(SEGMENT_SIZE + 10));

        // 首次分页读取：读 2 个段文件
        fake.readCalls.length = 0;
        await adapter.loadHistoryPage('conv1', { limit: 120 });
        const readsAfterFirst = fake.readCalls.filter(p => p.includes('.ndjson')).length;
        expect(readsAfterFirst).toBe(2);
        expect(adapter.getHistorySegmentCacheSize()).toBe(2);

        // 第二次分页读取：缓存命中，不再读盘
        fake.readCalls.length = 0;
        await adapter.loadHistoryPage('conv1', { limit: 120 });
        expect(fake.readCalls.filter(p => p.includes('.ndjson')).length).toBe(0);

        // 全量读取：两段都命中缓存，不读盘
        fake.readCalls.length = 0;
        const full = await adapter.loadHistory('conv1');
        expect(full).toHaveLength(SEGMENT_SIZE + 10);
        expect(fake.readCalls.filter(p => p.includes('.ndjson')).length).toBe(0);
        expect(adapter.getHistorySegmentCacheSize()).toBe(2);

        // append 提交后：该会话缓存全部失效
        await adapter.appendHistory('conv1', makeHistory(1));
        expect(adapter.getHistorySegmentCacheSize()).toBe(0);

        // 再次读取会重新读盘并重建缓存
        fake.readCalls.length = 0;
        await adapter.loadHistoryPage('conv1', { limit: 120 });
        expect(fake.readCalls.filter(p => p.includes('.ndjson')).length).toBe(2);
    });

    test('deleteHistory 清理该会话缓存', async () => {
        const { adapter } = createAdapter();
        await adapter.saveHistory('conv1', makeHistory(10));
        await adapter.loadHistory('conv1');
        expect(adapter.getHistorySegmentCacheSize()).toBe(1);

        await adapter.deleteHistory('conv1');
        expect(adapter.getHistorySegmentCacheSize()).toBe(0);
    });

    test('saveHistory 全量重写后缓存失效（M6）', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv1', makeHistory(10));
        await adapter.loadHistory('conv1');
        expect(adapter.getHistorySegmentCacheSize()).toBe(1);

        await adapter.saveHistory('conv1', makeHistory(15));
        expect(adapter.getHistorySegmentCacheSize()).toBe(0);

        fake.readCalls.length = 0;
        const full = await adapter.loadHistory('conv1');
        expect(full).toHaveLength(15);
        expect(fake.readCalls.filter(p => p.includes('.ndjson')).length).toBe(1);
    });

    test('M2：返回的元素是浅拷贝——调用方原地赋值不污染缓存', async () => {
        const { adapter } = createAdapter();
        await adapter.saveHistory('conv1', makeHistory(3));
        // 首次读取填充缓存
        const first = await adapter.loadHistory('conv1');
        expect(first).toHaveLength(3);
        // 模拟 ContextTrimService 对 fullHistory[index].tokenCountByChannel 的原地赋值
        first![0].tokenCountByChannel = { gemini: 42 };
        // 二次读取命中缓存：元素不应被污染，且每次返回独立元素副本
        const second = await adapter.loadHistory('conv1');
        expect(second).toHaveLength(3);
        expect(second![0].tokenCountByChannel).toBeUndefined();
        expect(second![0]).not.toBe(first![0]);
    });

    test('M5：外部进程改段文件（mtime 变化）→ 缓存失效重读', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv1', makeHistory(2));
        fake.readCalls.length = 0;
        await adapter.loadHistory('conv1');
        expect(fake.readCalls.filter(p => p.includes('.ndjson')).length).toBe(1);

        // 外部进程直接改写段文件内容（绕过 writeFile）+ mtime 变化
        const segPath = [...fake.files.keys()].find(p => p.endsWith('000000.ndjson'))!;
        const external: ConversationHistory = [
            makeContent('user', 'external-1'),
            makeContent('user', 'external-2')
        ];
        fake.files.set(segPath, external.map(m => JSON.stringify(m)).join('\n'));
        fake.mtimes.set(segPath, (fake.mtimes.get(segPath) ?? 0) + 1);

        fake.readCalls.length = 0;
        const full = await adapter.loadHistory('conv1');
        expect(fake.readCalls.filter(p => p.includes('.ndjson')).length).toBe(1); // 缓存失效重读
        expect(full).toHaveLength(2);
        expect((full![0].parts[0] as any).text).toBe('external-1');
    });
});

describe('FileSystemStorageAdapter.getHistoryIndexInfo（HIS-11）', () => {
    test('只读 index，不解析段消息内容', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv1', makeHistory(10));

        fake.readCalls.length = 0;
        const info = await adapter.getHistoryIndexInfo('conv1');
        expect(info.exists).toBe(true);
        expect(info.readable).toBe(true);
        expect(info.totalMessages).toBe(10);
        expect(info.segmentCount).toBe(1);

        // 没有读任何 .ndjson 段文件
        expect(fake.readCalls.filter(p => p.includes('.ndjson'))).toHaveLength(0);
    });

    test('legacy 历史：存在且可解析 → 可读（M1(a) 做一次 JSON.parse 探测）', async () => {
        const { adapter, fake } = createAdapter();
        const legacy: ConversationHistory = makeHistory(2);
        fake.files.set(
            normPath(`${(Uri.parse('file:///c%3A/data/graycode') as any).fsPath}/conversations/conv_legacy2.json`),
            JSON.stringify(legacy)
        );

        const info = await adapter.getHistoryIndexInfo('conv_legacy2');
        expect(info.exists).toBe(true);
        expect(info.readable).toBe(true);
        // M1(a)：legacy 分支至少读一次做 JSON.parse 探测（旧行为只 stat 会把损坏 JSON 误报为 ok）
        expect(fake.readCalls).toHaveLength(1);
        expect(fake.readCalls[0].includes('conv_legacy2.json')).toBe(true);
    });

    test('M1(a)：legacy 历史 JSON 损坏 → readable=false（parse_error）', async () => {
        const { adapter, fake } = createAdapter();
        fake.files.set(
            normPath(`${(Uri.parse('file:///c%3A/data/graycode') as any).fsPath}/conversations/conv_corrupt.json`),
            '{ definitely not valid json'
        );

        const info = await adapter.getHistoryIndexInfo('conv_corrupt');
        expect(info.exists).toBe(true);
        expect(info.readable).toBe(false);
        expect(info.errorCode).toBe('parse_error');
    });

    test('M1(b)：index 完好但段文件缺失 → readable=false（segment_missing），不解析段内容', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv1', makeHistory(10));
        // 删除段文件（保留 index）
        const segPath = [...fake.files.keys()].find(p => p.endsWith('.ndjson'))!;
        expect(segPath).toBeTruthy();
        fake.files.delete(segPath!);
        fake.mtimes.delete(segPath!);

        fake.readCalls.length = 0;
        const info = await adapter.getHistoryIndexInfo('conv1');
        expect(info.exists).toBe(true);
        expect(info.readable).toBe(false);
        expect(info.errorCode).toBe('segment_missing');
        // 只 stat，不 read 任何 .ndjson 段文件
        expect(fake.readCalls.filter(p => p.includes('.ndjson'))).toHaveLength(0);
    });

    test('不存在的对话：exists=false', async () => {
        const { adapter } = createAdapter();
        const info = await adapter.getHistoryIndexInfo('conv_missing');
        expect(info.exists).toBe(false);
        expect(info.readable).toBe(false);
    });
});
