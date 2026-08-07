/**
 * SummarizeService.cleanMessagesForSummarize 回归测试。
 *
 * 背景：总结请求曾把用户消息里的内联图片（inlineData）连同字节原样发给总结模型，
 * 既浪费输入 token，也让不支持多模态的总结渠道直接报错。
 *
 * 修复：inlineData / fileData 统一替换为文本占位符（[Image: ...] / [File: ...]），
 * 总结模型只感知"这里有图片/文件"，不需要真实载荷。
 */

import { SummarizeService } from '../../modules/api/chat/services/SummarizeService';

function createService(): SummarizeService {
    return new SummarizeService({} as any, {} as any, {} as any, {} as any);
}

describe('SummarizeService.cleanMessagesForSummarize - no images to summarize model', () => {
    const config = { type: 'gemini' } as any;

    it('inlineData（内联图片）替换为 [Image: ...] 文本占位符', () => {
        const service = createService();
        const cleaned = (service as any).cleanMessagesForSummarize([
            {
                role: 'user',
                parts: [
                    { text: '请看这张图' },
                    { inlineData: { mimeType: 'image/png', data: 'base64-bytes...', displayName: 'screenshot.png' } }
                ]
            }
        ], config);

        expect(cleaned).toHaveLength(1);
        expect(cleaned[0].parts).toEqual([
            { text: '请看这张图' },
            { text: '[Image: screenshot.png]' }
        ]);
        expect(JSON.stringify(cleaned)).not.toContain('base64-bytes');
        expect(JSON.stringify(cleaned)).not.toContain('inlineData');
    });

    it('inlineData 无 displayName 时回退到 mimeType 占位符', () => {
        const service = createService();
        const cleaned = (service as any).cleanMessagesForSummarize([
            { role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'xx' } }] }
        ], config);

        expect(cleaned[0].parts).toEqual([{ text: '[Image: image/jpeg]' }]);
    });

    it('fileData（文件引用）替换为 [File: ...] 文本占位符', () => {
        const service = createService();
        const cleaned = (service as any).cleanMessagesForSummarize([
            { role: 'user', parts: [{ fileData: { fileUri: 'file:///a/b.png', displayName: 'b.png' } }] }
        ], config);

        expect(cleaned[0].parts).toEqual([{ text: '[File: b.png]' }]);
    });

    it('纯文本消息与 functionCall/functionResponse 清理行为保持原样', () => {
        const service = createService();
        const cleaned = (service as any).cleanMessagesForSummarize([
            { role: 'user', parts: [{ text: 'plain' }] },
            {
                role: 'model',
                parts: [
                    { functionCall: { id: 'call-1', name: 'read_file', args: {}, rejected: true } },
                    { thought: true, text: 'thinking...' }
                ]
            },
            {
                role: 'user',
                isFunctionResponse: true,
                parts: [{ functionResponse: { id: 'call-1', name: 'read_file', response: { success: true, diffId: 'd1' } } }]
            }
        ], config);

        expect(cleaned).toHaveLength(3);
        // functionCall：rejected 字段被移除
        expect(cleaned[1].parts[0]).toEqual({ functionCall: { id: 'call-1', name: 'read_file', args: {} } });
        // thought part 被过滤
        expect(cleaned[1].parts).toHaveLength(1);
        // functionResponse：内部 diff 字段被移除
        expect(cleaned[2].parts[0].functionResponse.response).toEqual({ success: true });
    });

    it('中断残留（rejected 且无配对响应）的 functionCall 整体丢弃', () => {
        const service = createService();
        const cleaned = (service as any).cleanMessagesForSummarize([
            { role: 'user', parts: [{ text: '继续' }] },
            {
                role: 'model',
                parts: [
                    { text: '正在处理…' },
                    { functionCall: { id: 'call-rej-orphan', name: 'subagents', args: {}, rejected: true } }
                ]
            }
        ], config);

        // model 消息只保留文本，rejected 孤儿调用被丢弃
        expect(cleaned).toHaveLength(2);
        expect(cleaned[1].parts).toEqual([{ text: '正在处理…' }]);
        expect(JSON.stringify(cleaned)).not.toContain('call-rej-orphan');
    });
});
