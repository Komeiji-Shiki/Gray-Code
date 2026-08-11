/**
 * 读侧一致性（双 rename 提交窗口）测试。
 *
 * writeSegmentedHistory 的目录 rename 与 index rename 是两次独立操作，读侧可能短暂看到
 * “新段文件 + 旧 index”。本测试锁定：
 * - Σsegments.count !== totalMessages（错位/损坏 index）→ 读侧报 segment_missing 而非静默截断；
 * - 旧 index 引用不存在的段文件（历史变短窗口）→ 重试后仍缺失则失败；
 * - 提交窗口是瞬时的 → 重试后读到一致的新状态；
 * - appendHistory 提交前重算 totalMessages = Σsegments.count（异常态 index.count > 段实际行数）；
 * - M4 自愈优先从可读段重建（保留分段后的追加），无任何可读段时才用 legacy。
 */

import { FileSystemStorageAdapter } from '../../modules/conversation/storage';
import type { ConversationHistory, Content } from '../../modules/conversation/types';
import { Uri } from 'vscode';
import { createAdapter, normPath } from './helpers/fakeVscodeFs';
import { makeContent, makeHistory } from '../__fixtures__/conversationFixtures';

const SEGMENT_SIZE = (FileSystemStorageAdapter as any).HISTORY_SEGMENT_SIZE as number;
const BASE = 'file:///c%3A/data/graycode';
const CONVERSATIONS_DIR = `${(Uri.parse(BASE) as any).fsPath}/conversations`;


describe('双 rename 提交窗口：读侧一致性校验（不静默返回错位历史）', () => {
    test('Σsegments.count !== totalMessages（新段+旧 index 错位/损坏 index）→ 重试后仍不一致时报 segment_missing', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv', makeHistory(SEGMENT_SIZE)); // 200 条 1 段
        // 模拟“新段 + 旧 index”错位：totalMessages 超前于 Σcount（如保存历史从 200 变 300 的提交窗口内）
        const indexPath = [...fake.files.keys()].find(p => p.includes('history.index.json'))!;
        expect(indexPath).toBeTruthy();
        const index = JSON.parse(fake.files.get(indexPath)!);
        index.totalMessages = SEGMENT_SIZE + 100;
        fake.files.set(indexPath, JSON.stringify(index));

        const result = await adapter.loadHistoryWithStatus('conv');
        // 不静默返回被截断/错位的历史：报 segment_missing（重试后仍不一致）
        expect(result.value).toBeNull();
        expect(result.errorCode).toBe('segment_missing');
        expect(result.errorMessage).toContain('totalMessages');

        // 分页路径同样拒绝错位 index
        const page = await adapter.loadHistoryPage('conv', { limit: 100 });
        expect(page.value).toBeNull();
        expect(page.errorCode).toBe('segment_missing');
    });

    test('旧 index 引用不存在的段文件（历史变短窗口）→ 重试后仍缺失则失败（not_found）', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv', makeHistory(SEGMENT_SIZE + 50)); // 250 条 2 段
        // 模拟目录已换成只有 1 段的新目录（历史 250→200），index 仍是旧的 2 段
        const segPath = [...fake.files.keys()].find(p => p.endsWith('000001.ndjson'))!;
        expect(segPath).toBeTruthy();
        fake.files.delete(segPath);
        fake.mtimes.delete(segPath);

        const result = await adapter.loadHistoryWithStatus('conv');
        expect(result.value).toBeNull();
        expect(result.errorCode).toBe('not_found');
    });

    test('提交窗口是瞬时的：重试后读到一致的新状态（不误报）', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv', makeHistory(SEGMENT_SIZE));
        const indexPath = [...fake.files.keys()].find(p => p.includes('history.index.json'))!;
        const index = JSON.parse(fake.files.get(indexPath)!);
        index.totalMessages = SEGMENT_SIZE + 100;
        fake.files.set(indexPath, JSON.stringify(index));

        // 30ms 后第二个 rename 完成：index 被修复为一致状态（读侧重试间隔 50ms，落在修复之后）
        setTimeout(() => {
            const fixed = JSON.parse(fake.files.get(indexPath)!);
            fixed.totalMessages = SEGMENT_SIZE;
            fake.files.set(indexPath, JSON.stringify(fixed));
        }, 30);

        const result = await adapter.loadHistoryWithStatus('conv');
        expect(result.value).toHaveLength(SEGMENT_SIZE); // 重试后读到完整一致历史
    });
});

describe('R2 3.1 双 rename 窗口：段读取后重读 index 复核', () => {
    test('段读取后 index 变为新版本（新段+旧 index 窗口）：复核拦截 → 重试后读到一致新状态', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv-w', makeHistory(SEGMENT_SIZE)); // 200 条 1 段
        const indexPath = [...fake.files.keys()].find(p => p.includes('history.index.json'))!;
        const oldIndex = JSON.parse(fake.files.get(indexPath)!);

        // 模拟目录 rename 已完成（新段就位）：新增第二段 100 条
        const historyDir = normPath(indexPath.replace('history.index.json', 'history'));
        fake.files.set(
            `${historyDir}/000001.ndjson`,
            makeHistory(100, 'new').map(m => JSON.stringify(m)).join('\n')
        );
        // 模拟 index rename 稍后才完成：磁盘上 index 已是新版，但读取侧第一次读到旧版
        const newIndex = {
            ...oldIndex,
            totalMessages: SEGMENT_SIZE + 100,
            segments: [
                ...oldIndex.segments,
                { file: '000001.ndjson', startIndex: SEGMENT_SIZE, endIndex: SEGMENT_SIZE + 99, count: 100 }
            ]
        };
        fake.files.set(indexPath, JSON.stringify(newIndex));

        // 拦截 index 读取：第 1 次读返回旧版（提交窗口内的读取），之后返回新版（第二次 rename 完成）
        let indexReads = 0;
        const fakeFs = (fake as any).fs as any;
        const originalReadFile = fakeFs.readFile.bind(fakeFs);
        fakeFs.readFile = async (uri: any) => {
            const p = normPath(uri.fsPath);
            if (p === normPath(indexPath)) {
                indexReads++;
                return Buffer.from(JSON.stringify(indexReads === 1 ? oldIndex : newIndex), 'utf8');
            }
            return originalReadFile(uri);
        };

        const result = await adapter.loadHistoryWithStatus('conv-w');
        // 第一次尝试读到混合状态被复核拦截 → 重试后读到一致新状态（300 条）
        expect(indexReads).toBeGreaterThan(2);
        expect(result.value).toHaveLength(SEGMENT_SIZE + 100);
        expect((result.value![0].parts[0] as any).text).toBe('m0');

        // 分页路径同样复核：重试后读到新版本分页
        const page = await adapter.loadHistoryPage('conv-w', { limit: 100 });
        expect(page.value!.total).toBe(SEGMENT_SIZE + 100);
        expect(page.value!.messages).toHaveLength(100);
    });

    test('复核始终不一致（提交窗口持续）：重试耗尽后报 segment_missing（可重试错误）', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv-w2', makeHistory(SEGMENT_SIZE));
        const indexPath = [...fake.files.keys()].find(p => p.includes('history.index.json'))!;
        const oldIndex = JSON.parse(fake.files.get(indexPath)!);
        const newIndex = {
            ...oldIndex,
            totalMessages: SEGMENT_SIZE + 100,
            segments: [
                ...oldIndex.segments,
                { file: '000001.ndjson', startIndex: SEGMENT_SIZE, endIndex: SEGMENT_SIZE + 99, count: 100 }
            ]
        };
        fake.files.set(indexPath, JSON.stringify(newIndex));

        // 每次尝试都先读到旧版、复核时读到新版 → 每次都判不一致（模拟写入持续进行）
        let indexReads = 0;
        const fakeFs = (fake as any).fs as any;
        const originalReadFile = fakeFs.readFile.bind(fakeFs);
        fakeFs.readFile = async (uri: any) => {
            const p = normPath(uri.fsPath);
            if (p === normPath(indexPath)) {
                indexReads++;
                return Buffer.from(JSON.stringify(indexReads % 2 === 1 ? oldIndex : newIndex), 'utf8');
            }
            return originalReadFile(uri);
        };

        const result = await adapter.loadHistoryWithStatus('conv-w2');
        expect(result.value).toBeNull();
        expect(result.errorCode).toBe('segment_missing');
        expect(result.errorMessage).toContain('changed during segment read');
    });
});

describe('R2 3.3 读侧重试：双格式都不存在不重试', () => {
    test('legacy+segmented 双缺失：只尝试一次直接返回 not_found（不空转退避重试）', async () => {
        const { adapter } = createAdapter();
        let attempts = 0;
        const original = (adapter as any).tryLoadHistoryWithStatus.bind(adapter);
        (adapter as any).tryLoadHistoryWithStatus = async (id: string) => {
            attempts++;
            return original(id);
        };

        const result = await adapter.loadHistoryWithStatus('no-such-conv');
        expect(result.value).toBeNull();
        expect(result.errorCode).toBe('not_found');
        expect(attempts).toBe(1); // 双缺失：不重试

        attempts = 0;
        const page = await adapter.loadHistoryPage('no-such-conv', { limit: 100 });
        expect(page.value).toBeNull();
        expect(page.errorCode).toBe('not_found');
        expect(attempts).toBe(1); // 分页路径同样不重试
    });

    test('index 在但段缺失（提交窗口）：仍按可重试错误重试', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv-seg-missing', makeHistory(5));
        // 删除唯一段文件：index 在、段缺失
        const segPath = [...fake.files.keys()].find(p => p.endsWith('000000.ndjson'))!;
        expect(segPath).toBeTruthy();
        fake.files.delete(segPath);
        fake.mtimes.delete(segPath);

        let attempts = 0;
        const original = (adapter as any).tryLoadHistoryWithStatus.bind(adapter);
        (adapter as any).tryLoadHistoryWithStatus = async (id: string) => {
            attempts++;
            return original(id);
        };

        const result = await adapter.loadHistoryWithStatus('conv-seg-missing');
        expect(result.value).toBeNull();
        expect(attempts).toBeGreaterThan(1); // 提交窗口错误仍重试
    });
});

describe('appendHistory 提交前重算 totalMessages = Σsegments.count', () => {
    test('异常态（index.count > 段实际行数）：追加后分页 total 与完整历史长度一致', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv', makeHistory(5));
        const segPath = [...fake.files.keys()].find(p => p.endsWith('000000.ndjson'))!;
        expect(segPath).toBeTruthy();
        // 段文件实际只有 3 行（模拟外部截断/异常态），index.count 仍为 5
        const lines = fake.files.get(segPath)!.split('\n').filter(l => l.trim());
        expect(lines).toHaveLength(5);
        fake.files.set(segPath, lines.slice(0, 3).join('\n'));

        await adapter.appendHistory('conv', makeHistory(1, 'new'));

        // 修复前：totalMessages = 旧 index 5 + 1 = 6，与 Σcount=4 不一致（分页 total 错位）。
        // 修复后：提交前重算 totalMessages = 3 + 1 = 4。
        const page = await adapter.loadHistoryPage('conv', { limit: 100 });
        expect(page.value!.total).toBe(4);
        expect(page.value!.messages).toHaveLength(4);
        const full = await adapter.loadHistory('conv');
        expect(full).toHaveLength(4);
        expect((full![3].parts[0] as any).text).toBe('new0');
        const info = await adapter.getHistoryTotalMessages('conv');
        expect(info).toBe(4);
    });
});

describe('M4 自愈优先从可读段重建（不丢分段后的追加）', () => {
    test('尾段损坏但前段可读：从段重建保留 200 条，legacy 旧快照不被使用', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv-m4b', makeHistory(SEGMENT_SIZE + 10)); // 2 段：200 + 10
        // 制造 legacy 旧快照（崩溃窗口残留：index rename 完成但 legacy 尚未删除）→ 只有第一段 200 条
        fake.files.set(
            normPath(`${CONVERSATIONS_DIR}/conv-m4b.json`),
            JSON.stringify(makeHistory(SEGMENT_SIZE, 'legacy'))
        );
        // 删除尾段（000001.ndjson）触发 M4
        const tailPath = [...fake.files.keys()].find(p => p.endsWith('000001.ndjson'))!;
        expect(tailPath).toBeTruthy();
        fake.files.delete(tailPath);
        fake.mtimes.delete(tailPath);

        await adapter.appendHistory('conv-m4b', makeHistory(1, 'after'));

        const full = await adapter.loadHistory('conv-m4b');
        // 前段 200 条保留 + 新追加 1 条 = 201（而不是 legacy 200 条 + 丢 10 条分段追加）
        expect(full).toHaveLength(SEGMENT_SIZE + 1);
        expect((full![0].parts[0] as any).text).toBe('m0');
        expect((full![SEGMENT_SIZE - 1].parts[0] as any).text).toBe(`m${SEGMENT_SIZE - 1}`);
        expect((full![SEGMENT_SIZE].parts[0] as any).text).toBe('after0');
    });

    test('没有任何段可读时才回退 legacy 快照', async () => {
        const { adapter, fake } = createAdapter();
        await adapter.saveHistory('conv-m4a', makeHistory(5));
        // 制造 legacy 旧快照（崩溃窗口残留）
        fake.files.set(normPath(`${CONVERSATIONS_DIR}/conv-m4a.json`), JSON.stringify(makeHistory(3, 'legacy')));
        // 删除唯一段文件（尾段即唯一段）→ M4 触发且无任何可读段
        const segPath = [...fake.files.keys()].find(p => p.endsWith('000000.ndjson'))!;
        expect(segPath).toBeTruthy();
        fake.files.delete(segPath);
        fake.mtimes.delete(segPath);

        await adapter.appendHistory('conv-m4a', makeHistory(1, 'after'));

        const full = await adapter.loadHistory('conv-m4a');
        expect(full).toHaveLength(4); // legacy 3 条 + after
        expect((full![0].parts[0] as any).text).toBe('legacy0');
    });
});
