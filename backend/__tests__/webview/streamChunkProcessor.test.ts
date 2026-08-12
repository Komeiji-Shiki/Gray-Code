/**
 * StreamChunkProcessor.processChunk 增量类型判定回归测试。
 *
 * 背景：2c93ad4e（agent-sweep 04 修复 16）曾把文本增量判定从 truthy 收紧为
 * `typeof chunk.chunk === 'string'`，而后端各渠道 formatter 统一发送对象
 * `{ delta: ContentPart[], done }`（backend/modules/channel/types.ts 的 StreamChunk；
 * anthropic/openai/openai-responses/gemini formatter 均按此构造），导致对象增量
 * 全部落入 unknown 分支被丢弃——前端收不到逐 token 更新，只在 complete 到达时
 * 一次性替换内容（「非流式」回归；1.5.3 的 truthy 判定正常）。
 *
 * 本文件锁定三类输入：
 * - 对象增量（主路径，回归保护）
 * - 字符串/空串增量（兼容路径，修复 16 的初衷：空串合法）
 * - 未知类型（应丢弃）
 */

import { StreamChunkProcessor } from '../../../webview/stream/StreamChunkProcessor';
import { PUSH_MESSAGE_NAMES } from '../../../shared/protocol';

jest.mock('../../modules/activity', () => ({
    markAiActive: jest.fn(),
}));

function createProcessor(): { processor: StreamChunkProcessor; postMessage: jest.Mock } {
    const postMessage = jest.fn().mockReturnValue(true);
    const processor = new StreamChunkProcessor(
        () => ({ webview: { postMessage } as any }),
        'conv-1',
        'stream-1'
    );
    return { processor, postMessage };
}

function lastPosted(postMessage: jest.Mock): any {
    expect(postMessage).toHaveBeenCalled();
    const calls = postMessage.mock.calls;
    return calls[calls.length - 1][0];
}

describe('StreamChunkProcessor.processChunk 增量类型判定', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    test('对象增量 { chunk: { delta } } 应发送（回归：2c93ad4e 曾把对象增量丢进 unknown）', () => {
        const { processor, postMessage } = createProcessor();
        const isError = processor.processChunk({
            conversationId: 'conv-1',
            streamId: 'stream-1',
            type: 'chunk',
            chunk: { delta: [{ text: 'hello' }], done: false },
            createdAt: 1,
        });
        expect(isError).toBe(false);
        const msg = lastPosted(postMessage);
        expect(msg.type).toBe(PUSH_MESSAGE_NAMES.streamChunk);
        expect(msg.data.type).toBe('chunk');
        expect(msg.data.conversationId).toBe('conv-1');
        expect(msg.data.streamId).toBe('stream-1');
        // 对象原样透传（前端 handleChunkType 读 chunk.chunk.delta）
        expect(msg.data.chunk).toEqual({ delta: [{ text: 'hello' }], done: false });
    });

    test('空数组增量 { chunk: { delta: [] } } 应发送', () => {
        const { processor, postMessage } = createProcessor();
        processor.processChunk({
            conversationId: 'conv-1',
            streamId: 'stream-1',
            type: 'chunk',
            chunk: { delta: [], done: false },
            createdAt: 1,
        });
        expect(postMessage).toHaveBeenCalled();
    });

    test('字符串增量 { chunk: "text" } 应发送（兼容路径）', () => {
        const { processor, postMessage } = createProcessor();
        processor.processChunk({
            conversationId: 'conv-1',
            streamId: 'stream-1',
            type: 'chunk',
            chunk: 'hi',
            createdAt: 1,
        });
        const msg = lastPosted(postMessage);
        expect(msg.data.type).toBe('chunk');
        expect(msg.data.chunk).toBe('hi');
    });

    test('空字符串增量 { chunk: "" } 应发送（修复 16 初衷：空串合法，不落 unknown）', () => {
        const { processor, postMessage } = createProcessor();
        processor.processChunk({
            conversationId: 'conv-1',
            streamId: 'stream-1',
            type: 'chunk',
            chunk: '',
            createdAt: 1,
        });
        const msg = lastPosted(postMessage);
        expect(msg.data.type).toBe('chunk');
        expect(msg.data.chunk).toBe('');
    });

    test('complete（content 对象）走 complete 分支并立即发送', () => {
        const { processor, postMessage } = createProcessor();
        processor.processChunk({
            conversationId: 'conv-1',
            streamId: 'stream-1',
            type: 'complete',
            content: { id: 'm1', parts: [{ text: 'final' }] },
            createdAt: 1,
        });
        const msg = lastPosted(postMessage);
        expect(msg.data.type).toBe('complete');
        expect(msg.data.content).toEqual({ id: 'm1', parts: [{ text: 'final' }] });
    });

    test('未知类型不发送、不抛错', () => {
        const { processor, postMessage } = createProcessor();
        const isError = processor.processChunk({ foo: 'bar' });
        expect(isError).toBe(false);
        expect(postMessage).not.toHaveBeenCalled();
    });

    test('视图不可达时不发送并返回 false（isViewUnreachable 命中）', () => {
        const processor = new StreamChunkProcessor(() => undefined, 'conv-1', 'stream-1');
        const isError = processor.processChunk({
            chunk: { delta: [{ text: 'a' }], done: false },
        });
        expect(isError).toBe(false);
        expect(processor.isViewUnreachable()).toBe(true);
    });
});
