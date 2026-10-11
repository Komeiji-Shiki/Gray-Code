/** 保留原事件总线用例中由平台继续使用的 manifest 和 transcript 断言。 */
import type { Content } from '../../modules/conversation/types';
import type { SubAgentTranscriptData } from '../../modules/conversation/storage';
import { toManifest } from '../../tools/subagents/eventBus/protocol';
import { buildLastSentHistoryProjection, restoreLastSentHistory } from '../../tools/subagents/eventBus/transcript';
import type { SubAgentRunSnapshot } from '../../tools/subagents/eventBus/types';
import { getSubAgentTranscriptIndex } from '../../tools/subagents/executor/historyMetadata';

function textContent(role: Content['role'], text: string): Content {
    return { role, parts: [{ text }] } as Content;
}

function snapshot(runId: string, contents: Content[]): SubAgentRunSnapshot {
    return { runId, agentName: 'Agent', status: 'completed', createdAt: 1, updatedAt: 2,
        contentRevision: 1, eventSequence: 1, contents, events: [], contextCompactions: [] };
}

describe('共享 manifest 预览', () => {
    test('预览按上限截断，且超长单条消息不会被完整拼接', () => {
        const manifest = toManifest(snapshot('run_preview', [textContent('model', 'x'.repeat(10000))]));
        expect(manifest).toBeDefined();
        // 160 字上限 + 省略号
        expect(manifest.preview!.length).toBeLessThanOrEqual(161);
        expect(manifest.preview!.endsWith('…')).toBe(true);
    });

    test('多个 part 拼接后仍按上限截断', () => {
        const preview = toManifest(snapshot('run_preview_parts', [{
            role: 'model',
            parts: [{ text: 'a'.repeat(100) }, { text: 'b'.repeat(100) }, { text: 'c'.repeat(100) }]
        }])).preview!;
        expect(preview.length).toBeLessThanOrEqual(161);
        expect(preview.startsWith('a')).toBe(true);
    });

    test('没有可预览文本时返回 undefined', () => {
        expect(toManifest(snapshot('run_preview_empty', [{ role: 'model', parts: [] }])).preview).toBeUndefined();
    });

    test('functionCall / functionResponse 也能生成预览', () => {
        const manifest = toManifest(snapshot('run_preview_tool', [{
            role: 'model',
            parts: [{ functionCall: { name: 'read_file', args: {} } }]
        } as Content]));
        expect(manifest.preview).toContain('read_file');
    });
});

test('终态 transcript 用 contents 索引去重 provider history，并可在惰性加载时还原', () => {
    const largeToolResult = textContent('model', 'image:' + 'x'.repeat(20_000));
    const contents = [textContent('user', '# SubAgent Invocation'), largeToolResult];
    const lastSentHistory = [textContent('user', 'actual provider prompt'), largeToolResult];
    const persisted: SubAgentTranscriptData = {
        contents,
        lastSentHistoryProjection: buildLastSentHistoryProjection(contents, lastSentHistory)
    };
    expect(persisted.lastSentHistory).toBeUndefined();
    expect(persisted.lastSentHistoryProjection?.entries).toEqual([
        { content: textContent('user', 'actual provider prompt') },
        { contentIndex: 1 }
    ]);

    const restoredHistory = restoreLastSentHistory(persisted) || [];
    expect(restoredHistory.map(content => ({ role: content.role, parts: content.parts }))).toEqual([
        textContent('user', 'actual provider prompt'),
        largeToolResult
    ]);
    expect(getSubAgentTranscriptIndex(restoredHistory[1])).toBe(1);
});
