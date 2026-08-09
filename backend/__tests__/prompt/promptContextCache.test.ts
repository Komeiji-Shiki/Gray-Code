/**
 * promptContextCache 序列化往返测试。
 *
 * 思考内容（thought part，如预设 fakeThought）必须与正文分离保存并无损恢复，
 * 使「回合开始的直发路径」与「回合继续/回插的缓存路径」产出结构一致的消息，
 * 避免同一条消息字节翻转破坏提示词前缀缓存。
 */
import { deserializePromptContextCache, serializePromptContextCache } from '../../modules/prompt/promptContextCache';

describe('promptContextCache thought preservation', () => {
    it('preserves thought parts through serialize/deserialize round-trip', () => {
        const cache = serializePromptContextCache({
            beforeHistoryMessages: [
                { role: 'user', parts: [{ text: 'seed user' }] },
                { role: 'model', parts: [{ text: 'fake chain', thought: true }, { text: 'seed body' }] }
            ],
            afterHistoryMessages: [],
            dynamicSnapshotBeforeHistoryMessages: [],
            dynamicSnapshotAfterHistoryMessages: [],
            messages: [],
            dynamicSnapshotMessages: []
        });

        const restored = deserializePromptContextCache(cache);
        expect(restored.beforeHistoryMessages).toHaveLength(2);
        expect(restored.beforeHistoryMessages[0].parts).toEqual([{ text: 'seed user' }]);
        expect(restored.beforeHistoryMessages[1].parts).toEqual([
            { text: 'fake chain', thought: true },
            { text: 'seed body' }
        ]);
    });

    it('keeps plain messages unchanged through round-trip', () => {
        const cache = serializePromptContextCache({
            messages: [{ role: 'user', parts: [{ text: 'plain ctx' }] }],
            dynamicSnapshotMessages: [{ role: 'user', parts: [{ text: 'plain ctx' }] }]
        });

        const restored = deserializePromptContextCache(cache);
        expect(restored.beforeHistoryMessages[0].parts).toEqual([{ text: 'plain ctx' }]);
        expect(restored.dynamicSnapshotMessages[0].parts).toEqual([{ text: 'plain ctx' }]);
    });

    it('restores thought-only messages without fabricating an empty text part', () => {
        const cache = serializePromptContextCache({
            messages: [{ role: 'model', parts: [{ text: 'only thinking', thought: true }] }],
            dynamicSnapshotMessages: []
        });

        const restored = deserializePromptContextCache(cache);
        expect(restored.beforeHistoryMessages[0].parts).toEqual([{ text: 'only thinking', thought: true }]);
    });

    it('merges multiple thought parts into one thoughtText that re-emits identical joined text', () => {
        const cache = serializePromptContextCache({
            messages: [
                {
                    role: 'model',
                    parts: [
                        { text: 'part A', thought: true },
                        { text: 'part B', thought: true },
                        { text: 'body' }
                    ]
                }
            ],
            dynamicSnapshotMessages: []
        });

        const restored = deserializePromptContextCache(cache);
        // 与 formatter 的 thoughtParts.map(text).join('\n') 语义一致
        expect(restored.beforeHistoryMessages[0].parts).toEqual([
            { text: 'part A\npart B', thought: true },
            { text: 'body' }
        ]);
    });

    it('stays compatible with legacy plain-text caches', () => {
        const restored = deserializePromptContextCache('legacy ctx text');
        expect(restored.beforeHistoryMessages[0].parts).toEqual([{ text: 'legacy ctx text' }]);
    });

    it('stays compatible with v2 caches that lack thoughtText', () => {
        const legacyV2 = JSON.stringify({
            version: 2,
            beforeHistoryMessages: [{ role: 'model', text: 'flattened old content' }],
            afterHistoryMessages: [],
            dynamicSnapshotBeforeHistoryMessages: [],
            dynamicSnapshotAfterHistoryMessages: []
        });

        const restored = deserializePromptContextCache(legacyV2);
        expect(restored.beforeHistoryMessages[0].parts).toEqual([{ text: 'flattened old content' }]);
    });
});
