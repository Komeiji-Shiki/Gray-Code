/**
 * 渠道 formatter 消息角色一致性回归测试（H1-3 / BR-07）
 *
 * 背景：总结功能（SummarizeService）会把总结消息以 role:'user' 插入历史，可能紧随
 * functionResponse（tool_result）之后或与真实 user 消息相邻，形成连续两条 user 消息；
 * Anthropic Messages API 对同角色相邻消息敏感（部分端点要求严格交替）。防御性修复：
 *
 * - AnthropicFormatter.convertHistoryFunctionCallMode / convertHistoryTextMode：
 *   相邻同角色消息合并为一条消息（content block 数组拼接），tool_result 与 text 允许
 *   共存于同一条 user 消息，语义不变；不跨 tool_use/tool_result 边界（角色不同，天然交替）。
 * - ConversationManager.formatHistoryForAPI：按 functionCall id 配对过滤孤儿
 *   functionResponse（被截断/reroll 后残留），无 id 的 functionResponse 保守保留。
 */

import { AnthropicFormatter } from '../../modules/channel/formatters/anthropic';
import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import type { AnthropicConfig } from '../../modules/config/configs/anthropic';
import type { Content, ContentPart } from '../../modules/conversation/types';

function createConfig(overrides: Partial<AnthropicConfig> = {}): AnthropicConfig {
    return {
        id: 'anthropic-merge-test',
        name: 'Anthropic Merge Test',
        type: 'anthropic',
        enabled: true,
        url: 'https://api.anthropic.com/v1',
        apiKey: 'test-key',
        model: 'claude-sonnet-4-20250514',
        preferStream: false,
        timeout: 30000,
        toolMode: 'function_call',
        anthropicUserIdEnabled: false,
        ...overrides
    } as AnthropicConfig;
}

function buildRequest(formatter: AnthropicFormatter, history: Content[], toolMode = 'function_call') {
    return formatter.buildRequest({
        configId: 'anthropic-merge-test',
        history
    }, createConfig({ toolMode } as any));
}

function fcPart(id: string, name = 'read_file'): ContentPart {
    return { functionCall: { id, name, args: {} } };
}

function frPart(id: string, name = 'read_file'): ContentPart {
    return { functionResponse: { id, name, response: { success: true } } };
}

function userTextMessage(text: string, extra: Record<string, unknown> = {}): Content {
    return { role: 'user', parts: [{ text }], ...extra } as Content;
}

describe('AnthropicFormatter 相邻同角色消息合并（function_call 模式）', () => {
    const formatter = new AnthropicFormatter();

    it('tool_result 后紧跟总结(user) 合并为一条 user 消息（tool_result + text）', () => {
        const request = buildRequest(formatter, [
            { role: 'model', parts: [fcPart('toolu_1')] },
            { role: 'user', parts: [frPart('toolu_1')], isFunctionResponse: true },
            userTextMessage('（总结）之前的对话摘要', { isSummary: true })
        ]);

        const messages = request.body.messages as any[];
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe('assistant');
        expect(messages[0].content).toHaveLength(1);
        expect(messages[0].content[0].type).toBe('tool_use');

        // 合并后只有一条 user 消息，tool_result 与 text 共存
        expect(messages[1].role).toBe('user');
        expect(messages[1].content.map((c: any) => c.type)).toEqual(['tool_result', 'text']);
        expect(messages[1].content[0].tool_use_id).toBe('toolu_1');
        expect(messages[1].content[1].text).toBe('（总结）之前的对话摘要');
    });

    it('总结(user) 后紧跟真实 user 消息同样合并', () => {
        const request = buildRequest(formatter, [
            userTextMessage('（总结）之前的对话摘要', { isSummary: true }),
            userTextMessage('继续处理')
        ]);

        const messages = request.body.messages as any[];
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('user');
        expect(messages[0].content.map((c: any) => c.type)).toEqual(['text', 'text']);
        expect(messages[0].content.map((c: any) => c.text)).toEqual(['（总结）之前的对话摘要', '继续处理']);
    });

    it('连续 tool_result 消息合并为一条 user 消息', () => {
        const request = buildRequest(formatter, [
            { role: 'model', parts: [fcPart('toolu_1'), fcPart('toolu_2')] },
            { role: 'user', parts: [frPart('toolu_1')], isFunctionResponse: true },
            { role: 'user', parts: [frPart('toolu_2')], isFunctionResponse: true }
        ]);

        const messages = request.body.messages as any[];
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe('assistant');
        expect(messages[1].role).toBe('user');
        expect(messages[1].content.map((c: any) => c.type)).toEqual(['tool_result', 'tool_result']);
    });

    it('不跨 tool_use 边界合并：assistant(tool_use) 与 user(tool_result) 保持交替', () => {
        const request = buildRequest(formatter, [
            { role: 'model', parts: [fcPart('toolu_1')] },
            { role: 'user', parts: [frPart('toolu_1')], isFunctionResponse: true },
            { role: 'model', parts: [fcPart('toolu_2')] },
            { role: 'user', parts: [frPart('toolu_2')], isFunctionResponse: true }
        ]);

        const messages = request.body.messages as any[];
        expect(messages.map((m: any) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
        expect(messages[0].content[0].type).toBe('tool_use');
        expect(messages[1].content[0].type).toBe('tool_result');
    });

    it('连续 assistant 消息合并（防御，很少发生）', () => {
        const request = buildRequest(formatter, [
            { role: 'model', parts: [fcPart('toolu_1')] },
            { role: 'model', parts: [fcPart('toolu_2')] }
        ]);

        const messages = request.body.messages as any[];
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('assistant');
        expect(messages[0].content.map((c: any) => c.type)).toEqual(['tool_use', 'tool_use']);
        expect(messages[0].content.map((c: any) => c.id)).toEqual(['toolu_1', 'toolu_2']);
    });
});

describe('AnthropicFormatter 相邻同角色消息合并（XML/JSON 文本模式）', () => {
    const formatter = new AnthropicFormatter();

    it('xml 模式：tool_result 文本后紧跟总结(user) 合并为一条 user 消息', () => {
        const request = buildRequest(formatter, [
            { role: 'model', parts: [fcPart('toolu_1')] },
            { role: 'user', parts: [frPart('toolu_1')], isFunctionResponse: true },
            userTextMessage('（总结）之前的对话摘要', { isSummary: true })
        ], 'xml');

        const messages = request.body.messages as any[];
        expect(messages).toHaveLength(2);
        expect(messages[0].role).toBe('assistant');
        expect(messages[1].role).toBe('user');
        expect(messages[1].content.map((c: any) => c.type)).toEqual(['text', 'text']);
        expect(messages[1].content[1].text).toBe('（总结）之前的对话摘要');
    });

    it('json 模式：连续 user 消息合并', () => {
        const request = buildRequest(formatter, [
            userTextMessage('第一条'),
            userTextMessage('第二条')
        ], 'json');

        const messages = request.body.messages as any[];
        expect(messages).toHaveLength(1);
        expect(messages[0].content.map((c: any) => c.text)).toEqual(['第一条', '第二条']);
    });
});

describe('ConversationManager.formatHistoryForAPI 孤儿 functionResponse 过滤（BR-07）', () => {
    const manager = new ConversationManager(new MemoryStorageAdapter());

    it('无前置 functionCall 的孤儿 functionResponse 被剔除，消息整体跳过', () => {
        const forApi = manager.getHistoryForAPIFrom([
            { role: 'user', parts: [frPart('toolu_orphan')], isFunctionResponse: true },
            { role: 'user', parts: [{ text: 'hello' }] }
        ]);

        expect(forApi).toHaveLength(1);
        expect(forApi[0].role).toBe('user');
        expect(forApi[0].parts).toEqual([{ text: 'hello' }]);
    });

    it('id 匹配的 functionResponse 正常保留（tool_use 后跟 tool_result）', () => {
        const forApi = manager.getHistoryForAPIFrom([
            { role: 'user', parts: [{ text: 'do it' }] },
            { role: 'model', parts: [fcPart('toolu_1')] },
            { role: 'user', parts: [frPart('toolu_1')], isFunctionResponse: true }
        ]);

        expect(forApi).toHaveLength(3);
        expect(forApi[2].parts[0]).toMatchObject({ functionResponse: { id: 'toolu_1' } });
    });

    it('被截断（startIndex 裁剪掉 functionCall）后的孤儿 functionResponse 被剔除', () => {
        const history: Content[] = [
            { role: 'user', parts: [{ text: 'do it' }] },
            { role: 'model', parts: [fcPart('toolu_1')] },
            { role: 'user', parts: [frPart('toolu_1')], isFunctionResponse: true }
        ];

        // 从 functionResponse 开始裁剪：前置 functionCall 被裁掉，functionResponse 变成孤儿
        const forApi = manager.getHistoryForAPIFrom(history, { startIndex: 2 });
        expect(forApi).toHaveLength(0);
    });

    it('无 id 的 functionResponse 保守保留（不做激进过滤）', () => {
        const forApi = manager.getHistoryForAPIFrom([
            { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { success: true } } }], isFunctionResponse: true }
        ]);

        expect(forApi).toHaveLength(1);
        expect(forApi[0].parts[0].functionResponse?.id).toBeUndefined();
    });

    it('混合消息：孤儿 functionResponse part 剔除，同消息文本保留', () => {
        const forApi = manager.getHistoryForAPIFrom([
            {
                role: 'user',
                parts: [
                    { text: '这是文本' },
                    frPart('toolu_orphan')
                ],
                isFunctionResponse: true
            }
        ]);

        expect(forApi).toHaveLength(1);
        expect(forApi[0].parts).toEqual([{ text: '这是文本' }]);
    });

    it('拒绝的工具调用（rejected functionCall 在历史中）不误伤对应 functionResponse', () => {
        const forApi = manager.getHistoryForAPIFrom([
            { role: 'user', parts: [{ text: 'do it' }] },
            { role: 'model', parts: [{ functionCall: { id: 'toolu_1', name: 'read_file', args: {}, rejected: true } }] },
            { role: 'user', parts: [frPart('toolu_1')], isFunctionResponse: true }
        ]);

        expect(forApi).toHaveLength(3);
        // rejected 标记被清理，functionResponse 保留（内容被改写为拒绝状态）
        expect(forApi[1].parts[0]).toMatchObject({ functionCall: { id: 'toolu_1' } });
        expect(forApi[1].parts[0].functionCall?.rejected).toBeUndefined();
        expect(forApi[2].parts[0].functionResponse?.id).toBe('toolu_1');
        expect(forApi[2].parts[0].functionResponse?.response).toMatchObject({ success: false, rejected: true });
    });
});
