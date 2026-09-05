/**
 * FileUsageIndexStore 并发与原子写测试（HIS-08 高项回归）
 *
 * 覆盖：
 * - 并行 appendUsageMessages（并行子代理归集）不丢失更新（丢失更新回归）；
 * - 并行 appendUsage（主会话增量）不丢失更新；
 * - 全量重建 write 与并发子代理归集不互覆、不重复（subagent 条目队列内合并兜底）；
 * - 原子写：只写 tmp + rename 提交，线上文件始终完整可读，无 tmp 残留；
 * - 写临时文件失败：线上保持旧版、抛错；rename 失败：抛错、tmp 清理（自愈为 missing）。
 */

import { FileUsageIndexStore } from '../../modules/conversation';
import type { UsageIndex, UsageIndexMessage } from '../../modules/conversation/usageStats';
import { buildConversationUsageIndex } from '../../modules/conversation/usageStats';
import type { Content } from '../../modules/conversation';
import { Uri } from 'vscode';

const BASE_DIR = 'file:///c%3A/data/graycode';

/** 与 FileUsageIndexStore 同一套 Uri 解析派生路径（mock 解析依赖平台/当前盘符，不能硬编码） */
function usageFilePath(conversationId: string): string {
    return normPath(Uri.joinPath(Uri.parse(BASE_DIR), 'conversations', `${conversationId}.usage.json`).fsPath);
}

function usageTmpPath(conversationId: string): string {
    return normPath(Uri.joinPath(Uri.parse(BASE_DIR), 'conversations', `${conversationId}.usage.json.tmp`).fsPath);
}

interface FakeFsState {
    files: Map<string, string>;
    writeCalls: string[];
    renameCalls: string[];
    deleteCalls: string[];
}

function normPath(p: string): string {
    return p.replace(/\\/g, '/');
}

function createFakeFs(options: {
    failWriteMatching?: (normPath: string) => boolean;
    failRenameMatching?: (normPath: string) => boolean;
} = {}): { fs: any; state: FakeFsState } {
    const files = new Map<string, string>();
    const writeCalls: string[] = [];
    const renameCalls: string[] = [];
    const deleteCalls: string[] = [];
    const fs: any = {
        async stat(uri: any) {
            const p = normPath(uri.fsPath);
            if (!files.has(p)) {
                const err: any = new Error('EntryNotFound');
                err.code = 'EntryNotFound';
                throw err;
            }
            return { mtime: 1, size: files.get(p)!.length };
        },
        async readFile(uri: any) {
            const p = normPath(uri.fsPath);
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
        },
        async delete(uri: any) {
            const p = normPath(uri.fsPath);
            deleteCalls.push(p);
            files.delete(p);
        },
        async rename(src: any, dest: any, opts?: any) {
            const s = normPath(src.fsPath);
            const d = normPath(dest.fsPath);
            renameCalls.push(`${s} -> ${d}`);
            if (options.failRenameMatching?.(d)) {
                throw new Error(`simulated rename failure: ${d}`);
            }
            if (opts?.overwrite) files.delete(d);
            if (!files.has(s)) {
                const err: any = new Error('EntryNotFound');
                err.code = 'EntryNotFound';
                throw err;
            }
            files.set(d, files.get(s)!);
            files.delete(s);
        }
    };
    return { fs, state: { files, writeCalls, renameCalls, deleteCalls } };
}

function createStore(options: {
    failWriteMatching?: (normPath: string) => boolean;
    failRenameMatching?: (normPath: string) => boolean;
} = {}): { store: FileUsageIndexStore; state: FakeFsState } {
    const { fs, state } = createFakeFs(options);
    const vscode = { Uri, workspace: { fs } };
    const store = new FileUsageIndexStore(vscode as any, BASE_DIR);
    return { store, state };
}

/** 构造一条可区分的用量索引条目（timestamp/prompt 随 seq 变化，保证去重键互异） */
function entry(seq: number, source: 'main' | 'subagent' = 'subagent'): UsageIndexMessage {
    return {
        timestamp: 1000 + seq,
        modelVersion: 'model-x',
        prompt: 10 + seq,
        candidates: 5,
        thoughts: 1,
        cacheCreation: 0,
        cacheRead: 0,
        source
    };
}

function seedIndex(conversationId: string, messages: UsageIndexMessage[]): UsageIndex {
    return { version: 1, conversationId, updatedAt: 0, messages };
}


describe('FileUsageIndexStore 并发写（per-conversation 队列）', () => {
    test('重建先读到已落盘消息时，排队的增量追加不重复计费', async () => {
        const { store, state } = createStore();
        const id = 'conv-rebuild-then-append';
        const message: Content = {
            id: 'm1', role: 'model', parts: [{ text: 'answer' }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 }
        };
        let release!: () => void;
        let entered!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const rebuilt = store.rebuild(id, async () => {
            entered();
            await gate;
            return buildConversationUsageIndex(id, [message]);
        });
        await ready;
        const appended = store.appendUsage(id, [message]);
        release();
        await Promise.all([rebuilt, appended]);

        const index = (await store.read(id))!;
        expect(index.messages.map(item => item.id)).toEqual(['m1']);
        expect(index.messages.reduce((total, item) => total + item.prompt + item.candidates, 0)).toBe(150);
        expect(state.writeCalls).toHaveLength(1);
    });

    test('同批稳定 ID 去重，无 ID 且 token 相同的两条旧消息均保留', async () => {
        const { store } = createStore();
        const id = 'conv-append-idempotent';
        await store.write(id, seedIndex(id, []));
        const message: Content = {
            role: 'model', parts: [{ text: 'answer' }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 }
        };
        await store.appendUsage(id, [{ ...message, id: 'm1' }, { ...message, id: 'm1' }, message, message]);
        await store.appendUsage(id, [{ ...message, id: 'm1' }]);
        expect((await store.read(id))!.messages.map(item => item.id)).toEqual(['m1', undefined, undefined]);
    });

    test('并行 appendUsageMessages（并行子代理归集）不丢失更新', async () => {
        const { store, state } = createStore();
        const id = 'conv-parallel';
        await store.write(id, seedIndex(id, [entry(0, 'main')]));
        state.writeCalls.length = 0;

        // 20 个并行子代理归集：旧实现 read-modify-write 无锁时互相覆盖，最后只剩 1 条
        const results = await Promise.all(
            Array.from({ length: 20 }, (_, i) => store.appendUsageMessages(id, [entry(i + 1)]))
        );
        expect(results.every(r => r === true)).toBe(true);

        const index = await store.read(id);
        expect(index?.messages).toHaveLength(21); // 1 条 seed + 20 条归集，无丢失
        expect(new Set(index!.messages.map(m => m.prompt)).size).toBe(21); // 无重复
    });

    test('并行 appendUsage（主会话增量）不丢失更新', async () => {
        const { store } = createStore();
        const id = 'conv-append';
        await store.write(id, seedIndex(id, []));

        const makeModel = (prompt: number): Content => ({
            role: 'model',
            parts: [{ text: 'x' }],
            timestamp: 2000 + prompt,
            usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: 1 } as Content['usageMetadata']
        });
        const results = await Promise.all(
            Array.from({ length: 20 }, (_, i) => store.appendUsage(id, [makeModel(100 + i)]))
        );
        expect(results.every(r => r === true)).toBe(true);

        const index = await store.read(id);
        expect(index?.messages).toHaveLength(20);
    });

    test('appendUsage 与 appendUsageMessages 混合并发不互覆', async () => {
        const { store } = createStore();
        const id = 'conv-mixed';
        await store.write(id, seedIndex(id, []));

        const makeModel = (prompt: number): Content => ({
            role: 'model',
            parts: [{ text: 'x' }],
            timestamp: 3000 + prompt,
            usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: 1 } as Content['usageMetadata']
        });
        await Promise.all([
            store.appendUsage(id, [makeModel(1)]),
            store.appendUsageMessages(id, [entry(1)]),
            store.appendUsage(id, [makeModel(2)]),
            store.appendUsageMessages(id, [entry(2)])
        ]);

        const index = await store.read(id);
        expect(index?.messages).toHaveLength(4);
    });

    test('全量重建 write 与并发子代理归集不互覆、不重复', async () => {
        const { store } = createStore();
        const id = 'conv-race';
        const s1 = entry(1);
        await store.write(id, seedIndex(id, [s1]));

        // 模拟调用方（ConversationManager.updateUsageIndex / usageStats 重建）在队列外
        // 读到含 s1 的旧索引后构造全量重建（main 条目 + 旧 subagent 条目），
        // 与新的子代理归集 s2 并发提交：s2 不能被重建覆盖，s1 不能因队列内合并重复出现。
        const rebuilt = seedIndex(id, [entry(0, 'main'), s1]);
        const s2 = entry(2);
        await Promise.all([
            store.write(id, rebuilt),
            store.appendUsageMessages(id, [s2])
        ]);

        const index = await store.read(id);
        const prompts = index!.messages.map(m => m.prompt).sort((a, b) => a - b);
        expect(prompts).toEqual([10, 11, 12]);
    });

    test('rebuild 在队列内原子执行：与并发子代理归集不互覆、不丢条目（R2 1.1）', async () => {
        const { store } = createStore();
        const id = 'conv-rebuild-race';
        const s1 = entry(1);
        await store.write(id, seedIndex(id, [s1]));

        // rebuild 的 build 回调在队列内执行：期间并发提交的归集排在其后，不会被重建覆盖
        let buildStartedResolve: () => void = () => {};
        const buildStarted = new Promise<void>(r => { buildStartedResolve = r; });
        let releaseBuild: () => void = () => {};
        const rebuildPromise = store.rebuild(id, async (previous) => {
            buildStartedResolve();
            await new Promise<void>(r => { releaseBuild = r; });
            // 模拟调用方重建：main 条目 + 从 previous（队列内最新盘面）合并 subagent
            const rebuilt = seedIndex(id, [entry(0, 'main')]);
            if (previous && Array.isArray(previous.messages)) {
                rebuilt.messages.push(...previous.messages.filter(m => m.source === 'subagent'));
            }
            return rebuilt;
        });
        await buildStarted;
        // rebuild 已进入队列（build 挂起），此时并发提交子代理归集
        const appendPromise = store.appendUsageMessages(id, [entry(2)]);
        releaseBuild();
        const [rebuilt, appendOk] = await Promise.all([rebuildPromise, appendPromise]);

        expect(appendOk).toBe(true);
        // 队列顺序：rebuild 先执行并落盘，append 随后追加 → 无丢失
        const index = await store.read(id);
        const prompts = index!.messages.map(m => m.prompt).sort((a, b) => a - b);
        expect(prompts).toEqual([10, 11, 12]); // main10 + subagent11（rebuild 合并）+ subagent12（并发追加）
        expect(rebuilt.messages.map(m => m.prompt).sort((a, b) => a - b)).toEqual([10, 11]);
    });

    test('不同会话的写互不阻塞（队列按 conversationId 隔离）', async () => {
        const { store } = createStore();
        const results = await Promise.all([
            store.appendUsageMessages('conv-a', [entry(1)]),
            store.appendUsageMessages('conv-b', [entry(2)])
        ]);
        expect(results.every(r => r === false)).toBe(true); // 索引不存在，均返回 false
    });
});

describe('FileUsageIndexStore 原子写（tmp + rename）', () => {
    test('只写临时文件再 rename 提交，线上文件完整可读，无 tmp 残留', async () => {
        const { store, state } = createStore();
        const id = 'conv-atomic';
        const index = seedIndex(id, [entry(1)]);

        await store.write(id, index);

        const finalPath = usageFilePath(id);
        const tmpPath = usageTmpPath(id);
        expect(state.writeCalls).toEqual([tmpPath]); // 只写临时文件
        expect(state.renameCalls).toEqual([`${tmpPath} -> ${finalPath}`]); // rename 提交
        expect(state.files.has(tmpPath)).toBe(false); // tmp 已被 rename 移走
        expect(state.files.get(finalPath)).toBe(JSON.stringify(index)); // 落盘内容完整
        expect(await store.read(id)).toEqual(index);
    });

    test('写临时文件失败：抛错、线上保持旧版', async () => {
        let failNext = false;
        const { store, state } = createStore({
            failWriteMatching: () => failNext
        });
        const id = 'conv-wfail';
        const old = seedIndex(id, [entry(1)]);
        await store.write(id, old); // 首次写成功
        state.writeCalls.length = 0;

        failNext = true; // 仅第二次写失败
        await expect(store.write(id, seedIndex(id, [entry(2)]))).rejects.toThrow('simulated write failure');
        // 线上仍是旧版（rename 未发生）
        expect((await store.read(id))?.messages).toHaveLength(1);
        expect(state.files.has(usageTmpPath(id))).toBe(false);
    });

    test('rename 失败：抛错、tmp 清理、索引自愈为 missing（下次重建兜底）', async () => {
        let failNext = false;
        const { store, state } = createStore({
            failRenameMatching: () => failNext
        });
        const id = 'conv-rfail';
        await store.write(id, seedIndex(id, [entry(1)])); // 首次写成功
        state.writeCalls.length = 0;
        state.deleteCalls.length = 0;

        failNext = true; // 仅第二次 rename 失败
        await expect(store.write(id, seedIndex(id, [entry(2)]))).rejects.toThrow('simulated rename failure');
        // 临时文件被清理，不残留半截 JSON
        expect(state.files.has(usageTmpPath(id))).toBe(false);
        // 线上索引缺失 → freshness=missing → 统计侧重建自愈
        expect(await store.read(id)).toBeNull();
        expect(await store.getFreshness(id)).toBe('missing');
    });
});

describe('FileUsageIndexStore 写队列挂起超时（R2 1.2 / SEC）', () => {
    test('挂起任务超时调用方 fail-fast，但链不前进：后续写等待底层任务真正结束', async () => {
        jest.useFakeTimers();
        try {
            const { store } = createStore();
            const id = 'conv-hang';
            await store.write(id, seedIndex(id, [entry(1)]));

            // build 挂起：任务长时间不结束（复用 storage.ts 的 withHangTimeout 模式，60s）
            let releaseHang: (() => void) | undefined;
            const hangPromise = store.rebuild(id, () => new Promise<UsageIndex>(resolve => {
                releaseHang = () => resolve(seedIndex(id, [entry(1), entry(2)]));
            }));
            // 先挂上断言再推进时钟：避免计时器触发 reject 时被当作未处理拒绝
            const rejection = expect(hangPromise).rejects.toThrow(/usageIndexWrite\(conv-hang\) hung for 60000ms/);
            await jest.advanceTimersByTimeAsync(60000);

            // 超时按失败处理（调用方 fail-fast，不无限等待）
            await rejection;

            // 修复语义（SEC）：链尾挂在底层任务上，挂起期间后续写不得并发启动——
            // 否则超时后的旧任务仍在 writeFileAtomic（.tmp + rename），新任务并发写会互相覆盖索引
            let queuedDone = false;
            const queued = store.appendUsageMessages(id, [entry(3)]).then(value => {
                queuedDone = true;
                return value;
            });
            await jest.advanceTimersByTimeAsync(5000);
            expect(queuedDone).toBe(false);

            // 底层任务真正结束后，队列才放行后续写
            releaseHang!();
            expect(await queued).toBe(true);
            const index = await store.read(id);
            expect(index?.messages).toHaveLength(3);
            // 队列 Map 已回收（任务完成后不再驻留）
            expect((store as any).writeQueues.has(id)).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });
});


/** branches.json 的完整路径（与 FileUsageIndexStore 同一套 Uri 解析派生路径） */
function branchesFilePath(conversationId: string): string {
    return normPath(Uri.joinPath(Uri.parse(BASE_DIR), 'conversations', conversationId, 'branches.json').fsPath);
}

describe('FileUsageIndexStore.readBranchGraph（TREE-08）', () => {
    test('无 sidecar：返回 null（线性模式）', async () => {
        const { store } = createStore();
        expect(await store.readBranchGraph('conv-a')).toBeNull();
    });

    test('有效 branches.json：返回分支图', async () => {
        const { store, state } = createStore();
        state.files.set(branchesFilePath('conv-a'), JSON.stringify({
            version: 1,
            rootNodeId: 'u1',
            activeTailNodeId: 'm2',
            activeChildId: 'm1',
            nodes: {
                u1: { id: 'u1', parentId: null, role: 'user', parts: [{ text: 'hi' }], kind: 'imported', createdAt: 1 },
                m1: { id: 'm1', parentId: 'u1', role: 'model', parts: [{ text: 'a' }], kind: 'imported', createdAt: 2 },
                m2: { id: 'm2', parentId: 'm1', role: 'model', parts: [{ text: 'b' }], kind: 'imported', createdAt: 3 },
            },
        }));
        const loaded = await store.readBranchGraph('conv-a');
        expect(loaded).not.toBeNull();
        expect(loaded!.rootNodeId).toBe('u1');
        expect(Object.keys(loaded!.nodes)).toHaveLength(3);
        expect(loaded!.nodes.m2.parentId).toBe('m1');
    });

    test('损坏（JSON 解析失败 / 结构不符）：返回 null', async () => {
        const { store, state } = createStore();
        state.files.set(branchesFilePath('conv-a'), '{ not json');
        expect(await store.readBranchGraph('conv-a')).toBeNull();

        // nodes 为数组：结构不符
        state.files.set(branchesFilePath('conv-a'), JSON.stringify({ version: 1, nodes: [] }));
        expect(await store.readBranchGraph('conv-a')).toBeNull();

        // 版本不符（0）
        state.files.set(branchesFilePath('conv-a'), JSON.stringify({ version: 0, nodes: {} }));
        expect(await store.readBranchGraph('conv-a')).toBeNull();
    });

    test('R8b-L3：shape 校验与 BranchGraphRepository 共用 isBranchGraphShape（非整数版本 / 缺失字段 → null）', async () => {
        const { store, state } = createStore();
        // 非整数版本（1.5）：共享实现要求 version 为 >=1 的整数
        state.files.set(branchesFilePath('conv-a'), JSON.stringify({ version: 1.5, nodes: {} }));
        expect(await store.readBranchGraph('conv-a')).toBeNull();
        // 缺失 nodes / version
        state.files.set(branchesFilePath('conv-a'), JSON.stringify({ version: 1 }));
        expect(await store.readBranchGraph('conv-a')).toBeNull();
        state.files.set(branchesFilePath('conv-a'), JSON.stringify({ nodes: {} }));
        expect(await store.readBranchGraph('conv-a')).toBeNull();
        // 合法图仍可读取
        state.files.set(branchesFilePath('conv-a'), JSON.stringify({ version: 1, nodes: {} }));
        expect(await store.readBranchGraph('conv-a')).not.toBeNull();
    });

    test('appendUsage 提取消息 id（TREE-08）', async () => {
        const { store, state } = createStore();
        const id = 'conv-id';
        state.files.set(usageFilePath(id), JSON.stringify(seedIndex(id, [])));
        const msg: Content = {
            role: 'model',
            id: 'mid-1',
            parts: [{ text: 'reply' }],
            timestamp: 1000,
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } as Content['usageMetadata'],
        };
        expect(await store.appendUsage(id, [msg])).toBe(true);
        const index = await store.read(id);
        expect(index!.messages).toHaveLength(1);
        expect(index!.messages[0].id).toBe('mid-1');
        expect(index!.messages[0].prompt).toBe(10);
    });
});
