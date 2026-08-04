/**
 * BCP-06 测试：deleteCheckpointsByNodeIds（引用计数删除）+ computeForcedKeepIds（CP-05 闭包抽取）。
 *
 * 覆盖（任务 BCP-06 §2/§3 + 研究 §5.4 + BCP-08 场景 18-21、23）：
 * - 候选按 messageNodeId 过滤；refCount===0 → 删除（元数据移除 + 备份目录删除）；
 * - refCount>0 → rejectedIds；force 覆盖引用计数闸门；
 * - referenceCounts 缺省 → 跳过引用计数闸门（退化为 nodeId 清理语义，仅链保护）；
 * - 旧存档无 messageNodeId → 不误删；
 * - CP-05 祖先闭包合并：候选 refCount 0 但被保留存档引用为 base → rejected
 *   （BCP-07 联动：增量链 base 保护不因引用计数删除破坏）；
 * - unsafe backupDir → rejected（CP-DEL-1）；
 * - 空 nodeIds → 成功且无操作；
 * - computeForcedKeepIds 纯函数（直接/间接祖先闭包、空 keep、断链终止、多保留节点合并）。
 *
 * 存储：CheckpointManager 走 mock ConversationManager（多对话模式，与 CheckpointManager.test.ts
 * 同 harness 模式）；引用计数只由传入的 Map 驱动，不依赖真实 sidecar。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

jest.mock('../../tools/file/diffManager', () => ({
    getDiffManager: () => ({
        cancelAllPending: jest.fn().mockResolvedValue({ cancelled: [] })
    })
}));

import {
    CheckpointManager,
    computeForcedKeepIds,
    type CheckpointRecord,
} from '../../modules/checkpoint/CheckpointManager';

async function createTempDirectory(prefix: string): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(rootDir: string, relativePath: string, content: string = ''): Promise<void> {
    const fullPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
}

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

/** 构造测试存档记录（默认带 messageNodeId） */
function makeRecord(overrides: Partial<CheckpointRecord> & { id: string; conversationId: string }): CheckpointRecord {
    return {
        messageIndex: 0,
        toolName: 'apply_diff',
        phase: 'after',
        timestamp: Date.now(),
        backupDir: overrides.id,
        fileCount: 1,
        contentHash: 'hash',
        type: 'full',
        ...overrides,
    };
}

interface Harness {
    manager: CheckpointManager;
    storageRoot: string;
    records: (conversationId: string) => CheckpointRecord[];
}

/** 多对话模式的 CheckpointManager harness（与 CheckpointManager.test.ts 同模式） */
async function createHarness(seed: Record<string, CheckpointRecord[]>): Promise<Harness> {
    const workspaceRoot = await createTempDirectory('bcp06-delete-workspace-');
    const storageRoot = await createTempDirectory('bcp06-delete-storage-');
    (vscode.workspace as any).workspaceFolders = [
        { uri: { fsPath: workspaceRoot, scheme: 'file', path: workspaceRoot } }
    ];
    (vscode.workspace as any).textDocuments = [];
    (vscode as any).window = {
        setStatusBarMessage: jest.fn(),
        showTextDocument: jest.fn(),
        tabGroups: { all: [], close: jest.fn() },
    };
    (vscode.commands.executeCommand as jest.Mock).mockResolvedValue(undefined);

    const metadataByConversation = new Map<string, { custom: Record<string, unknown> }>();
    for (const [id, cps] of Object.entries(seed)) {
        metadataByConversation.set(id, { custom: { checkpoints: [...cps] } });
    }
    let writeChain: Promise<unknown> = Promise.resolve();
    const conversationManager = {
        getMetadata: jest.fn().mockImplementation(async (conversationId: string) => {
            return metadataByConversation.get(conversationId) ?? null;
        }),
        getCustomMetadata: jest.fn().mockImplementation(async (conversationId: string, key: string) => {
            return (metadataByConversation.get(conversationId)?.custom ?? {})[key];
        }),
        setCustomMetadata: jest.fn().mockImplementation(async (conversationId: string, key: string, value: unknown) => {
            let m = metadataByConversation.get(conversationId);
            if (!m) {
                m = { custom: {} };
                metadataByConversation.set(conversationId, m);
            }
            m.custom[key] = value;
        }),
        updateCustomMetadata: jest.fn().mockImplementation(
            (conversationId: string, key: string, updater: (current: unknown) => unknown | Promise<unknown>) => {
                const run = writeChain.then(async () => {
                    let m = metadataByConversation.get(conversationId);
                    if (!m) {
                        m = { custom: {} };
                        metadataByConversation.set(conversationId, m);
                    }
                    const current = m.custom[key];
                    const next = await updater(current);
                    if (next !== current) {
                        m.custom[key] = next;
                    }
                    return next;
                });
                writeChain = run.catch(() => undefined);
                return run;
            }
        ),
        rejectAllPendingToolCalls: jest.fn().mockResolvedValue(undefined),
        listConversations: jest.fn().mockResolvedValue([]),
    };

    const settingsManager = {
        getCheckpointConfig: jest.fn().mockReturnValue({
            enabled: true,
            beforeTools: [],
            afterTools: [],
            messageCheckpoint: { beforeMessages: [], afterMessages: [] },
            maxCheckpoints: -1,
            customIgnorePatterns: [],
        }),
    };

    const manager = new CheckpointManager(
        settingsManager as any,
        conversationManager as any,
        { globalStorageUri: { fsPath: storageRoot } } as any
    );
    await manager.initialize();

    const records = (conversationId: string): CheckpointRecord[] => {
        const list = metadataByConversation.get(conversationId)?.custom?.checkpoints;
        return Array.isArray(list) ? list as CheckpointRecord[] : [];
    };

    return { manager, storageRoot, records };
}

describe('computeForcedKeepIds（BCP-06 CP-05 闭包抽取，纯函数）', () => {
    function rec(id: string, baseCheckpointId?: string): CheckpointRecord {
        return makeRecord({ id, conversationId: 'c', baseCheckpointId });
    }

    test('直接祖先闭包：keep {C} → C/B/A 全部强制保留', () => {
        const records = [rec('A'), rec('B', 'A'), rec('C', 'B')];
        const forced = computeForcedKeepIds(records, new Set(['C']));
        expect([...forced].sort()).toEqual(['A', 'B', 'C']);
    });

    test('keep {B} → B/A 保留，C 不在集合', () => {
        const records = [rec('A'), rec('B', 'A'), rec('C', 'B')];
        const forced = computeForcedKeepIds(records, new Set(['B']));
        expect([...forced].sort()).toEqual(['A', 'B']);
    });

    test('keep 为空 → 空集合', () => {
        const records = [rec('A'), rec('B', 'A'), rec('C', 'B')];
        expect(computeForcedKeepIds(records, new Set()).size).toBe(0);
    });

    test('断链（base 指向不存在的记录）→ 终止不抛', () => {
        const records = [rec('B', 'ghost-base'), rec('C', 'B')];
        const forced = computeForcedKeepIds(records, new Set(['C']));
        expect([...forced].sort()).toEqual(['B', 'C', 'ghost-base']);
    });

    test('多保留节点共享祖先 → 合并（不重复）', () => {
        const records = [rec('A'), rec('B', 'A'), rec('C', 'B'), rec('D', 'B')];
        const forced = computeForcedKeepIds(records, new Set(['C', 'D']));
        expect([...forced].sort()).toEqual(['A', 'B', 'C', 'D']);
    });

    test('删除集合内节点不算保留（keep 之外的记录不驱动闭包）', () => {
        const records = [rec('A'), rec('B', 'A'), rec('C', 'B')];
        // 只保留 C（A/B 在删除集合）：C 的祖先链仍全保留
        const forced = computeForcedKeepIds(records, new Set(['C']));
        expect(forced.has('A')).toBe(true);
    });
});

describe('CheckpointManager.deleteCheckpointsByNodeIds（BCP-06 引用计数删除联动）', () => {
    const CONV = 'conv-refcount-delete';

    async function seedBackupDirs(storageRoot: string, ids: string[]): Promise<void> {
        for (const id of ids) {
            await writeFile(path.join(storageRoot, 'checkpoints', id), 'x.txt', 'x\n');
        }
    }

    test('refCount===0 的候选删除（元数据移除 + 备份目录删除）；refCount>0 拒绝', async () => {
        const harness = await createHarness({
            [CONV]: [
                makeRecord({ id: 'cp-gone', conversationId: CONV, messageNodeId: 'node-del' }),
                makeRecord({ id: 'cp-kept', conversationId: CONV, messageNodeId: 'node-shared' }),
            ],
        });
        await seedBackupDirs(harness.storageRoot, ['cp-gone', 'cp-kept']);

        // cp-gone 引用归零 → 删；cp-kept 仍被一个存活节点引用 → 拒绝
        const result = await harness.manager.deleteCheckpointsByNodeIds(
            CONV,
            ['node-del', 'node-shared'],
            { referenceCounts: new Map([['cp-gone', 0], ['cp-kept', 1]]) }
        );

        expect(result.success).toBe(true);
        expect(result.deletedIds).toEqual(['cp-gone']);
        expect(result.rejectedIds).toEqual(['cp-kept']);
        expect(harness.records(CONV).map(r => r.id)).toEqual(['cp-kept']);
        await expect(pathExists(path.join(harness.storageRoot, 'checkpoints', 'cp-gone'))).resolves.toBe(false);
        await expect(pathExists(path.join(harness.storageRoot, 'checkpoints', 'cp-kept'))).resolves.toBe(true);
        await fs.rm(harness.storageRoot, { recursive: true, force: true });
    });

    test('force 覆盖引用计数闸门（refCount>0 也删；CP-05 链保护仍生效）', async () => {
        const harness = await createHarness({
            [CONV]: [
                makeRecord({ id: 'cp-shared', conversationId: CONV, messageNodeId: 'node-del' }),
            ],
        });
        await seedBackupDirs(harness.storageRoot, ['cp-shared']);

        const result = await harness.manager.deleteCheckpointsByNodeIds(
            CONV,
            ['node-del'],
            { force: true, referenceCounts: new Map([['cp-shared', 3]]) }
        );

        expect(result.deletedIds).toEqual(['cp-shared']);
        expect(result.rejectedIds).toEqual([]);
        expect(harness.records(CONV)).toEqual([]);
        await fs.rm(harness.storageRoot, { recursive: true, force: true });
    });

    test('referenceCounts 缺省 → 跳过引用计数闸门（退化为 nodeId 清理，仅 CP-05）', async () => {
        const harness = await createHarness({
            [CONV]: [
                makeRecord({ id: 'cp-shared', conversationId: CONV, messageNodeId: 'node-del' }),
            ],
        });
        await seedBackupDirs(harness.storageRoot, ['cp-shared']);

        const result = await harness.manager.deleteCheckpointsByNodeIds(CONV, ['node-del']);

        expect(result.deletedIds).toEqual(['cp-shared']);
        expect(harness.records(CONV)).toEqual([]);
        await fs.rm(harness.storageRoot, { recursive: true, force: true });
    });

    test('旧存档无 messageNodeId → 不误删（候选为空，成功无操作）', async () => {
        const harness = await createHarness({
            [CONV]: [
                makeRecord({ id: 'cp-legacy', conversationId: CONV }), // 无 messageNodeId
            ],
        });
        await seedBackupDirs(harness.storageRoot, ['cp-legacy']);

        const result = await harness.manager.deleteCheckpointsByNodeIds(CONV, ['some-node']);

        expect(result.success).toBe(true);
        expect(result.deletedIds).toEqual([]);
        expect(harness.records(CONV).map(r => r.id)).toEqual(['cp-legacy']);
        await expect(pathExists(path.join(harness.storageRoot, 'checkpoints', 'cp-legacy'))).resolves.toBe(true);
        await fs.rm(harness.storageRoot, { recursive: true, force: true });
    });

    test('CP-05 合并：候选 refCount 0 但被保留存档引用为 base → rejected（BCP-07 增量链 base 保护）', async () => {
        const harness = await createHarness({
            [CONV]: [
                // 链：cp-base(full) ← cp-tail(incremental, base=cp-base)
                makeRecord({ id: 'cp-base', conversationId: CONV, messageNodeId: 'node-del' }),
                makeRecord({
                    id: 'cp-tail', conversationId: CONV, messageNodeId: 'node-alive',
                    type: 'incremental', baseCheckpointId: 'cp-base',
                }),
            ],
        });
        await seedBackupDirs(harness.storageRoot, ['cp-base', 'cp-tail']);

        // 只删除 node-del：cp-base refCount 0（可删），但 cp-tail 保留且 base=cp-base → 闭包强制保留
        const result = await harness.manager.deleteCheckpointsByNodeIds(
            CONV,
            ['node-del'],
            { referenceCounts: new Map([['cp-base', 0]]) }
        );

        expect(result.deletedIds).toEqual([]);
        expect(result.rejectedIds).toEqual(['cp-base']);
        expect(harness.records(CONV).map(r => r.id)).toEqual(['cp-base', 'cp-tail']);
        await expect(pathExists(path.join(harness.storageRoot, 'checkpoints', 'cp-base'))).resolves.toBe(true);
        await fs.rm(harness.storageRoot, { recursive: true, force: true });
    });

    test('同链全部候选 → 整链可删（无保留节点引用 base，闭包不命中）', async () => {
        const harness = await createHarness({
            [CONV]: [
                makeRecord({ id: 'cp-base', conversationId: CONV, messageNodeId: 'node-a' }),
                makeRecord({
                    id: 'cp-tail', conversationId: CONV, messageNodeId: 'node-b',
                    type: 'incremental', baseCheckpointId: 'cp-base',
                }),
            ],
        });
        await seedBackupDirs(harness.storageRoot, ['cp-base', 'cp-tail']);

        const result = await harness.manager.deleteCheckpointsByNodeIds(
            CONV,
            ['node-a', 'node-b'],
            { referenceCounts: new Map([['cp-base', 0], ['cp-tail', 0]]) }
        );

        expect(result.deletedIds.sort()).toEqual(['cp-base', 'cp-tail']);
        expect(result.rejectedIds).toEqual([]);
        expect(harness.records(CONV)).toEqual([]);
        await fs.rm(harness.storageRoot, { recursive: true, force: true });
    });

    test('unsafe backupDir 候选 → rejected（CP-DEL-1，绝不删除越界目录）', async () => {
        const harness = await createHarness({
            [CONV]: [
                makeRecord({ id: 'cp-evil', conversationId: CONV, messageNodeId: 'node-del', backupDir: '../../victim' }),
            ],
        });

        const result = await harness.manager.deleteCheckpointsByNodeIds(
            CONV,
            ['node-del'],
            { referenceCounts: new Map([['cp-evil', 0]]) }
        );

        expect(result.deletedIds).toEqual([]);
        expect(result.rejectedIds).toEqual(['cp-evil']);
        expect(harness.records(CONV).map(r => r.id)).toEqual(['cp-evil']);
        await fs.rm(harness.storageRoot, { recursive: true, force: true });
    });

    test('空 nodeIds → 成功且无操作；nodeIds 中无匹配 → 成功无操作', async () => {
        const harness = await createHarness({
            [CONV]: [makeRecord({ id: 'cp-1', conversationId: CONV, messageNodeId: 'node-1' })],
        });

        const empty = await harness.manager.deleteCheckpointsByNodeIds(CONV, []);
        expect(empty).toEqual({ conversationId: CONV, deletedIds: [], rejectedIds: [], success: true });

        const noMatch = await harness.manager.deleteCheckpointsByNodeIds(CONV, ['no-such-node']);
        expect(noMatch.success).toBe(true);
        expect(noMatch.deletedIds).toEqual([]);
        expect(harness.records(CONV).map(r => r.id)).toEqual(['cp-1']);
        await fs.rm(harness.storageRoot, { recursive: true, force: true });
    });
});
