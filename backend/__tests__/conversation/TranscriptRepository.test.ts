/**
 * TranscriptRepository 返回值语义与 saveAndReload 测试
 *
 * 覆盖：
 * - appendContents 返回“本次已追加内容”的独立副本（接口注释显式声明的语义），
 *   无 append 委托的回退路径返回完整历史（两条路径行为差异已在接口注释声明）；
 * - saveContents 返回落盘形态时 saveAndReload 跳过写后全量回读；
 * - saveContents 返回 void（既有适配器）时保持写后回读，向后兼容。
 */

import { DelegatingTranscriptRepository } from '../../modules/conversation/TranscriptRepository';
import type { TranscriptRepositoryDelegate } from '../../modules/conversation/TranscriptRepository';
import type { Content } from '../../modules/conversation/types';

function content(text: string): Content {
    return { role: 'user', parts: [{ text }], timestamp: 1 } as Content;
}

function textOf(c: Content): string {
    return (c.parts[0] as any).text as string;
}

describe('DelegatingTranscriptRepository.appendContents 返回值语义', () => {
    test('有 append 委托：返回“本次已追加内容”的独立副本，而非完整历史', async () => {
        let stored: Content[] = [content('existing')];
        const appendedCalls: Content[][] = [];
        const delegate: TranscriptRepositoryDelegate = {
            async loadContents() { return stored; },
            async saveContents(contents) { stored = contents; },
            async appendContents(contents) {
                appendedCalls.push(contents);
                stored = stored.concat(contents);
            }
        };
        const repo = new DelegatingTranscriptRepository(delegate);

        const added = [content('new1'), content('new2')];
        const result = await repo.appendContents(added);

        // 返回值 = 已追加内容（不是完整历史）
        expect(result).toHaveLength(2);
        expect(result.map(textOf)).toEqual(['new1', 'new2']);
        // 与传入内容不共享引用（独立副本）
        expect(result[0]).not.toBe(added[0]);
        expect(appendedCalls).toHaveLength(1);
        expect(stored).toHaveLength(3); // 底层确实追加
    });

    test('无 append 委托：回退 get→push→save，返回完整历史（语义差异已写入接口注释）', async () => {
        let stored: Content[] = [content('existing')];
        const delegate: TranscriptRepositoryDelegate = {
            async loadContents() { return stored; },
            async saveContents(contents) { stored = contents; }
        };
        const repo = new DelegatingTranscriptRepository(delegate);

        const result = await repo.appendContents([content('new')]);
        expect(result).toHaveLength(2);
        expect(result.map(textOf)).toEqual(['existing', 'new']);
        expect(stored).toHaveLength(2);
    });
});

describe('DelegatingTranscriptRepository.saveAndReload', () => {
    test('saveContents 返回落盘形态：跳过写后全量回读', async () => {
        let loadCount = 0;
        const delegate: TranscriptRepositoryDelegate = {
            async loadContents() {
                loadCount++;
                return [content('on-disk')];
            },
            async saveContents() {
                return [{ role: 'model', parts: [{ text: 'persisted-with-index' }], timestamp: 99 } as Content];
            }
        };
        const repo = new DelegatingTranscriptRepository(delegate);

        const before = loadCount;
        const result = await repo.replaceContents([content('x')]);
        expect(loadCount).toBe(before); // 没有回读
        expect(result).toHaveLength(1);
        expect(textOf(result[0])).toBe('persisted-with-index'); // 采用委托返回的落盘形态
        // 返回独立副本
        const persisted = await (delegate.saveContents as any)([content('y')]);
        expect(result[0]).not.toBe(persisted[0]);
    });

    test('saveContents 返回 void：保持写后回读（向后兼容）', async () => {
        let loadCount = 0;
        const delegate: TranscriptRepositoryDelegate = {
            async loadContents() {
                loadCount++;
                return [content('reloaded')];
            },
            async saveContents() { /* void：旧适配器语义 */ }
        };
        const repo = new DelegatingTranscriptRepository(delegate);

        const result = await repo.replaceContents([content('x')]);
        expect(loadCount).toBe(1); // 回读一次
        expect(result.map(textOf)).toEqual(['reloaded']);
    });
});
