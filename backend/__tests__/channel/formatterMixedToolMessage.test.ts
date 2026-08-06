/**
 * 回归测试：同一历史消息同时携带 functionCall + functionResponse 的混合形态
 *
 * 背景（真实事故）：中断/修复数据可能产生「一条 model 消息既有 tool_calls 又有
 * functionResponse parts」的混合形态。formatter 原先用 if/else-if 互斥分支，
 * functionCall 分支优先 → functionResponse 被吞 → assistant tool_calls 后没有
 * 对应 tool 消息 → OpenAI 400 "insufficient tool messages" / Anthropic 400。
 *
 * 修复：functionResponse 改为独立分支生成，混合形态也能拆分出 tool 消息。
 */

import { OpenAIFormatter } from '../../modules/channel/formatters/openai';
import { AnthropicFormatter } from '../../modules/channel/formatters/anthropic';
import type { Content } from '../../modules/conversation/types';
import type { OpenAIConfig, AnthropicConfig } from '../../modules/config/types';

function createOpenAIConfig(): OpenAIConfig {
    return {
        id: 'openai-test',
        name: 'OpenAI Test',
        type: 'openai',
        enabled: true,
        url: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'test-model',
        preferStream: false,
        timeout: 30000,
        toolMode: 'function_call'
    } as OpenAIConfig;
}

function createAnthropicConfig(): AnthropicConfig {
    return {
        id: 'anthropic-test',
        name: 'Anthropic Test',
        type: 'anthropic',
        enabled: true,
        url: 'https://example.test/v1',
        apiKey: 'test-key',
        model: 'test-model',
        preferStream: false,
        timeout: 30000,
        toolMode: 'function_call'
    } as AnthropicConfig;
}

/** 构造一条「混合形态」model 消息：text + 2 个 functionCall + 2 个 functionResponse */
function buildMixedModelMessage(): Content {
    return {
        role: 'model',
        parts: [
            { text: '分析文本' },
            { functionCall: { id: 'call_1', name: 'read_file', args: { path: 'a.txt' } } },
            { functionCall: { id: 'call_2', name: 'todo_write', args: { todos: [] } } },
            { functionResponse: { id: 'call_1', name: 'read_file', response: { success: true, data: '内容A' } } },
            { functionResponse: { id: 'call_2', name: 'todo_write', response: { success: true, data: { total: 1 } } } }
        ]
    };
}

describe('OpenAIFormatter: 混合形态消息（call + response 同消息）', () => {
    it('拆分出 assistant(tool_calls) + 每条 tool 消息，tool_call_id 与 call 一一对应', () => {
        const formatter = new OpenAIFormatter();
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history: [buildMixedModelMessage()],
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, createOpenAIConfig());

        const messages = request.body.messages as any[];
        const assistant = messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
        expect(assistant).toBeDefined();
        expect(assistant.tool_calls).toHaveLength(2);
        expect(assistant.tool_calls.map((t: any) => t.id)).toEqual(['call_1', 'call_2']);
        // 文本并入 assistant 消息
        expect(assistant.content).toBe('分析文本');

        const tools = messages.filter((m: any) => m.role === 'tool');
        expect(tools).toHaveLength(2);
        expect(tools.map((t: any) => t.tool_call_id).sort()).toEqual(['call_1', 'call_2']);
                // tool 消息必须紧跟 assistant 之后（OpenAI 协议：tool 消息紧跟 tool_calls 消息）
        const assistantIdx = messages.indexOf(assistant);
        expect(messages[assistantIdx + 1]?.role).toBe('tool');
        expect(messages[assistantIdx + 2]?.role).toBe('tool');
    });

    it('回归：text + functionCall 同消息（无 response，最普通形态）不得重复输出文本', () => {
        const formatter = new OpenAIFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [
                    { text: '我来处理这个任务' },
                    { functionCall: { id: 'call_t1', name: 'read_file', args: { path: 'a.txt' } } }
                ]
            },
            {
                role: 'user',
                isFunctionResponse: true,
                parts: [
                    { functionResponse: { id: 'call_t1', name: 'read_file', response: { success: true, data: '内容' } } }
                ]
            }
        ];
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history,
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, createOpenAIConfig());

        const messages = request.body.messages as any[];
        // 关键断言：assistant(tool_calls) 之后必须紧跟 tool 消息，中间不得再出现 assistant 文本消息
        const assistantIdx = messages.findIndex((m: any) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
        expect(assistantIdx).toBeGreaterThanOrEqual(0);
        expect(messages[assistantIdx].content).toBe('我来处理这个任务');
        expect(messages[assistantIdx + 1]?.role).toBe('tool');
        expect(messages[assistantIdx + 1]?.tool_call_id).toBe('call_t1');
        // 全文只有一条 assistant 含 tool_calls 的消息，没有把文本重复输出成独立消息
        const assistantTextMsgs = messages.filter((m: any) => m.role === 'assistant' && !m.tool_calls && typeof m.content === 'string' && m.content.includes('我来处理'));
        expect(assistantTextMsgs).toHaveLength(0);
    });

    it('回归：纯文本消息不受影响', () => {
        const formatter = new OpenAIFormatter();
        const history: Content[] = [
            { role: 'user', parts: [{ text: '你好' }] },
            { role: 'model', parts: [{ text: '你好！' }] }
        ];
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history,
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, createOpenAIConfig());

        const messages = request.body.messages as any[];
        expect(messages.filter((m: any) => m.role === 'user')).toHaveLength(1);
        expect(messages.filter((m: any) => m.role === 'assistant')).toHaveLength(1);
    });

    it('回归：独立消息形态（model: CALL / user isFR: RESP）行为不变', () => {
        const formatter = new OpenAIFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [
                    { functionCall: { id: 'call_x', name: 'read_file', args: { path: 'b.txt' } } }
                ]
            },
            {
                role: 'user',
                isFunctionResponse: true,
                parts: [
                    { functionResponse: { id: 'call_x', name: 'read_file', response: { success: true, data: '内容B' } } }
                ]
            }
        ];
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history,
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, createOpenAIConfig());

        const messages = request.body.messages as any[];
        expect(messages.filter((m: any) => m.role === 'assistant' && m.tool_calls)).toHaveLength(1);
        const tools = messages.filter((m: any) => m.role === 'tool');
        expect(tools).toHaveLength(1);
        expect(tools[0].tool_call_id).toBe('call_x');
    });
});

describe('AnthropicFormatter: 混合形态消息（call + response 同消息）', () => {
    it('拆分出 assistant(tool_use) + user(tool_result)，tool_use_id 与 call 一一对应', () => {
        const formatter = new AnthropicFormatter();
        const request = formatter.buildRequest({
            configId: 'anthropic-test',
            dynamicSystemPrompt: 'system prompt',
            history: [buildMixedModelMessage()],
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, createAnthropicConfig());

        const messages = request.body.messages as any[];
        const assistant = messages.find((m: any) => m.role === 'assistant');
        expect(assistant).toBeDefined();
        const toolUses = assistant.content.filter((c: any) => c.type === 'tool_use');
        expect(toolUses).toHaveLength(2);
        expect(toolUses.map((t: any) => t.id).sort()).toEqual(['call_1', 'call_2']);
        // 文本仍保留在 assistant 消息内
        expect(assistant.content.some((c: any) => c.type === 'text' && c.text === '分析文本')).toBe(true);

        const user = messages.find((m: any) => m.role === 'user');
        const toolResults = user.content.filter((c: any) => c.type === 'tool_result');
        expect(toolResults).toHaveLength(2);
        expect(toolResults.map((t: any) => t.tool_use_id).sort()).toEqual(['call_1', 'call_2']);
    });

    it('回归：text + functionCall 同消息（无 response）不重复输出文本、tool_result 紧跟 tool_use', () => {
        const formatter = new AnthropicFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [
                    { text: '我来处理这个任务' },
                    { functionCall: { id: 'call_t1', name: 'read_file', args: { path: 'a.txt' } } }
                ]
            },
            {
                role: 'user',
                isFunctionResponse: true,
                parts: [
                    { functionResponse: { id: 'call_t1', name: 'read_file', response: { success: true, data: '内容' } } }
                ]
            }
        ];
        const request = formatter.buildRequest({
            configId: 'anthropic-test',
            dynamicSystemPrompt: 'system prompt',
            history,
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, createAnthropicConfig());

        const messages = request.body.messages as any[];
        const assistant = messages.find((m: any) => m.role === 'assistant');
        expect(assistant).toBeDefined();
        // 文本只并入 assistant 消息，不重复输出
        const textBlocks = assistant.content.filter((c: any) => c.type === 'text');
        expect(textBlocks.filter((c: any) => c.text === '我来处理这个任务')).toHaveLength(1);
        const user = messages.find((m: any) => m.role === 'user');
        const toolResults = user.content.filter((c: any) => c.type === 'tool_result');
        expect(toolResults.map((t: any) => t.tool_use_id)).toEqual(['call_t1']);
    });
});
