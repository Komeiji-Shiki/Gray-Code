/**
 * 元数据（meta.json）损坏降级与原子写测试。
 *
 * 背景：saveMetadata 曾直接 writeFile 线上文件，写入中途崩溃/断电/被杀进程会留下
 * 截断的 meta.json（JSON.parse 报 Unterminated string → parse_error →
 * 调用方报 UNKNOWN_ERROR: Failed to load conversation metadata (parse_error)）。
 *
 * 修复（代码层，存量损坏文件由人工/主 agent 另行处理）：
 * 1) saveMetadata 改为原子写：同目录 {id}.meta.json.tmp → rename 覆盖
 *    （与 appendHistory/writeSegmentedHistory 的 renameOverwrite 提交模式一致），
 *    tmp 写失败不破坏原文件、不留 tmp 残留；
 * 2) getMetadata 在 parse_error 时把损坏文件改名备份为 {id}.meta.json.corrupt-{Date.now()}
 *    （只保留一份，改名失败不阻塞），返回从历史重建的 fallback 元数据（不抛 UNKNOWN_ERROR），
 *    后续写路径（updateSummary/loadMetadataForWrite）恢复正常覆盖。
 */

import { ConversationManager } from '../../modules/conversation/ConversationManager';
import type { ConversationMetadata, Content } from '../../modules/conversation/types';
import { Uri } from 'vscode';
import { createAdapter, normPath } from './helpers/fakeVscodeFs';

function makeContent(role: 'user' | 'model', text: string): Content {
    return { role, parts: [{ text }], timestamp: Date.now(), ...(role === 'model' ? { modelVersion: 'test' } : {}) } as Content;
}

const CONVERSATIONS_DIR = `${(Uri.parse('file:///c%3A/data/graycode') as any).fsPath}/conversations`;
const metaPath = (id: string) => normPath(`${CONVERSATIONS_DIR}/${id}.meta.json`);
const tmpMetaPath = (id: string) => normPath(`${CONVERSATIONS_DIR}/${id}.meta.json.tmp`);
const corruptPrefix = (id: string) => `${id}.meta.json.corrupt-`;

describe('getMetadata 损坏降级（parse_error → fallback + 备份，不抛 UNKNOWN_ERROR）', () => {
    test('损坏 meta.json：getMetadata 返回 fallback 不抛错，原文件被改名备份为 .corrupt-*', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);

        await manager.createConversation('conv-corrupt', 'Original Title');
        // 人为截断 meta.json（模拟非原子写崩溃残留：Unterminated string in JSON）
        fake.files.set(metaPath('conv-corrupt'), '{ "id": "conv-corrupt", "title": "Original Title"');
        // 清元数据缓存：损坏检测必须基于真实磁盘状态（LRU 缓存是 fork 增量）
        manager.clearCaches();

        const meta = await manager.getMetadata('conv-corrupt');

        // 返回 fallback（不抛 UNKNOWN_ERROR），id 保留
        expect(meta).not.toBeNull();
        expect(meta!.id).toBe('conv-corrupt');
        // integrityStatus 标出 meta 损坏（历史完好）
        expect(meta!.integrityStatus).toBe('meta_corrupt');
        // fallback 是重建的基础元数据，不携带原 title/custom
        expect(typeof meta!.title).toBe('string');
        expect(meta!.title).not.toBe('Original Title');
        expect(meta!.custom ?? {}).toEqual({});

        // 损坏文件被改名备份（.corrupt- 前缀），线上 meta.json 不再存在
        expect(fake.files.has(metaPath('conv-corrupt'))).toBe(false);
        const backups = [...fake.files.keys()].filter(p => p.includes(corruptPrefix('conv-corrupt')));
        expect(backups).toHaveLength(1);
        expect(backups[0]).toContain('.corrupt-');
    });

    test('只保留一份损坏备份：新备份前旧 .corrupt-* 被清理', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-corrupt2', 'T2');

        // 预置两个旧备份 + 一个损坏的线上 meta
        fake.files.set(metaPath('conv-corrupt2'), '{ "id": "conv-corrupt2"');
        fake.files.set(normPath(`${CONVERSATIONS_DIR}/conv-corrupt2.meta.json.corrupt-1000`), 'old backup 1');
        fake.files.set(normPath(`${CONVERSATIONS_DIR}/conv-corrupt2.meta.json.corrupt-2000`), 'old backup 2');
        // 清元数据缓存：损坏检测必须基于真实磁盘状态（LRU 缓存是 fork 增量）
        manager.clearCaches();

        await manager.getMetadata('conv-corrupt2');

        const backups = [...fake.files.keys()].filter(p => p.includes(corruptPrefix('conv-corrupt2')));
        expect(backups).toHaveLength(1);
        // 线上 meta 已改名（不再存在）
        expect(fake.files.has(metaPath('conv-corrupt2'))).toBe(false);
    });

    test('降级后写路径恢复正常：updateSummary 基于重建元数据成功覆盖', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-recover', 'R');
        await manager.addBatch('conv-recover', [makeContent('user', 'a'), makeContent('model', 'b')]);

        // 人为截断 meta.json（损坏）
        fake.files.set(metaPath('conv-recover'), '{ "id": "conv-recover"');

        const fallback = await manager.getMetadata('conv-recover');
        expect(fallback).not.toBeNull();

        // 写路径（loadMetadataForWrite 不再撞到损坏文件）→ 正常保存
        await manager.updateSummary('conv-recover', { messageCount: 1, preview: 'p' });

        const meta = await adapter.loadMetadata('conv-recover');
        expect(meta).not.toBeNull();
        expect(meta!.custom!.messageCount).toBe(1);
        expect(meta!.custom!.preview).toBe('p');
        // 线上 meta.json 是完整可解析 JSON
        expect(JSON.parse(fake.files.get(metaPath('conv-recover'))!)).toMatchObject({ id: 'conv-recover' });
        // 备份文件仍保留（损坏现场）
        expect([...fake.files.keys()].some(p => p.includes(corruptPrefix('conv-recover')))).toBe(true);
    });

    test('meta.json 损坏：getCustomMetadata 不抛错返回 undefined（与 getMetadataLight 降级一致）', async () => {
        const { adapter, fake } = createAdapter();
        const manager = new ConversationManager(adapter);
        await manager.createConversation('conv-custom-corrupt', 'C');
        await manager.setCustomMetadata('conv-custom-corrupt', 'todoList', [{ id: 't1', text: 'a' }]);

        // 人为截断 meta.json（损坏）→ loadMetadataWithStatus 返回 parse_error
        fake.files.set(metaPath('conv-custom-corrupt'), '{ "id": "conv-custom-corrupt"');

        // 缓存温态：写路径已回填 metaCache（setCustomMetadata → persistMetadata），
        // 损坏发生在写之后，命中缓存返回最后已知值（与 getMetadataLight 缓存语义一致）
        await expect(manager.getCustomMetadata('conv-custom-corrupt', 'todoList')).resolves.toEqual([{ id: 't1', text: 'a' }]);

        // 冷启动（清缓存）后：磁盘 parse_error 按缺失降级，不抛错返回 undefined
        manager.clearCaches();
        await expect(manager.getCustomMetadata('conv-custom-corrupt', 'todoList')).resolves.toBeUndefined();
    });
});

describe('saveMetadata 原子写（tmp → rename 覆盖）', () => {
    test('成功路径：先写 tmp 再 rename 提交，线上文件完整且无 tmp 残留', async () => {
        const { adapter, fake } = createAdapter();
        const meta: ConversationMetadata = { id: 'conv-atomic', title: 'A', createdAt: 1, updatedAt: 2, custom: {} };

        await adapter.saveMetadata(meta);

        expect(fake.files.has(metaPath('conv-atomic'))).toBe(true);
        expect(fake.files.has(tmpMetaPath('conv-atomic'))).toBe(false);
        // rename 提交：tmp -> 线上
        expect(fake.renameCalls).toContain(`${tmpMetaPath('conv-atomic')} -> ${metaPath('conv-atomic')}`);
        // 线上内容完整可解析
        expect(JSON.parse(fake.files.get(metaPath('conv-atomic'))!)).toMatchObject({ id: 'conv-atomic', title: 'A' });
    });

    test('tmp 写入失败不破坏原文件，且清理 tmp 残留', async () => {
        const matcher: { fail: boolean } = { fail: false };
        const { adapter, fake } = createAdapter({
            failWriteMatching: p => matcher.fail && p.endsWith('.meta.json.tmp')
        });

        const meta1: ConversationMetadata = { id: 'conv-atomic2', title: 'V1', createdAt: 1, updatedAt: 1, custom: {} };
        await adapter.saveMetadata(meta1);

        // 让 tmp 写入失败（模拟磁盘满/进程被杀/断电）
        matcher.fail = true;
        const meta2: ConversationMetadata = { id: 'conv-atomic2', title: 'V2', createdAt: 1, updatedAt: 2, custom: {} };
        await expect(adapter.saveMetadata(meta2)).rejects.toThrow(/simulated write failure/);

        // 原文件未被破坏（仍是 V1 完整内容），无 tmp 残留，且未发生 rename
        expect(JSON.parse(fake.files.get(metaPath('conv-atomic2'))!)).toMatchObject({ title: 'V1' });
        expect(fake.files.has(tmpMetaPath('conv-atomic2'))).toBe(false);
        expect(fake.renameCalls.filter(r => r.includes('conv-atomic2.meta.json'))).toHaveLength(1); // 只有第一次成功的 rename

        // 故障恢复后再次保存正常覆盖（V1 → V2）
        matcher.fail = false;
        await adapter.saveMetadata(meta2);
        expect(JSON.parse(fake.files.get(metaPath('conv-atomic2'))!)).toMatchObject({ title: 'V2' });
    });
});
