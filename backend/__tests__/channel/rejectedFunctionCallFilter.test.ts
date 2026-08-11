/**
 * 回归测试：rejected functionCall（中断/取消/超时残留）不发给 API
 *
 * 背景（真实事故）：会话被中断时模型已输出的 functionCall 无对应 functionResponse，
 * ConversationManager.normalizeHistoryForDisplay 会将其标记为 rejected:true（有意孤儿）。
 * 但 formatter 序列化时不过滤 rejected → OpenAI 收到 assistant tool_calls 却无对应
 * tool 消息 → 400 "An assistant message with 'tool_calls' must be followed by tool
 * messages responding to each 'tool_call_id'"；HistoryIntegrityValidator 也误报
 * orphan_function_call。
 *
 * 修复：formatter 序列化 functionCall 时过滤 rejected:true（原生模式不生成 tool_calls，
 * prompt 模式不转文本）；校验器 orphan 检测跳过 rejected。
 */

import { OpenAIFormatter } from '../../modules/channel';
import { AnthropicFormatter } from '../../modules/channel';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import { GeminiFormatter } from '../../modules/channel';
import { ConversationManager } from '../../modules/conversation/ConversationManager';
import { MemoryStorageAdapter } from '../../modules/conversation/storage';
import { validateHistoryIntegrity } from '../../modules/channel/HistoryIntegrityValidator';
import type { Content } from '../../modules/conversation/types';
import type { OpenAIConfig, AnthropicConfig } from '../../modules/config/types';
import type { GeminiConfig } from '../../modules/config/configs/gemini';

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

function createGeminiConfig(overrides: Partial<GeminiConfig> = {}): GeminiConfig {
    return {
        id: 'gemini-test',
        name: 'Gemini Test',
        type: 'gemini',
        enabled: true,
        url: 'https://generativelanguage.googleapis.com/v1',
        apiKey: 'test-key',
        model: 'gemini-test-model',
        preferStream: false,
        timeout: 30000,
        toolMode: 'function_call',
        ...overrides
    } as GeminiConfig;
}

function buildGeminiRequest(formatter: GeminiFormatter, history: Content[], toolMode: string) {
    return formatter.buildRequest({
        configId: 'gemini-test',
        dynamicSystemPrompt: 'system prompt',
        history,
        promptContext: {
            beforeHistoryMessages: [],
            afterHistoryMessages: [],
            historyPlacement: 'legacy'
        },
        dynamicContextStrategy: 'single'
    }, createGeminiConfig({ toolMode } as any));
}

/** 模拟中断残留：model 消息 = 文本 + 2 个 rejected functionCall（无响应） */
function buildRejectedModelMessage(): Content {
    return {
        role: 'model',
        parts: [
            { text: '正在处理…' },
            { functionCall: { id: 'call_rej_1', name: 'read_file', args: { path: 'a.png' }, rejected: true } },
            { functionCall: { id: 'call_rej_2', name: 'subagents', args: { agentName: 'A' }, rejected: true } }
        ]
    };
}

/** 正常响应过的 functionCall（rejected 未设置，且后面有 functionResponse）——不受影响 */
function buildNormalCallAndResponse(): Content[] {
    return [
        {
            role: 'model',
            parts: [
                { text: '继续' },
                { functionCall: { id: 'call_ok_1', name: 'read_file', args: { path: 'b.txt' } } }
            ]
        },
        {
            role: 'user',
            isFunctionResponse: true,
            parts: [
                { functionResponse: { id: 'call_ok_1', name: 'read_file', response: { success: true, data: '内容' } } }
            ]
        }
    ];
}

describe('OpenAIFormatter: rejected functionCall 过滤（function_call 模式）', () => {
    test('rejected 调用不生成 tool_calls，文本正常输出，无孤儿 tool_calls', () => {
        const formatter = new OpenAIFormatter();
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history: [buildRejectedModelMessage()],
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, createOpenAIConfig());

        const messages = request.body.messages as any[];
        // 没有带 tool_calls 的 assistant 消息（rejected 调用被过滤）
        const assistantWithTools = messages.filter((m: any) => m.role === 'assistant' && m.tool_calls);
        expect(assistantWithTools).toHaveLength(0);
        // 文本仍以普通 assistant 消息发送
        const assistant = messages.find((m: any) => m.role === 'assistant');
        expect(assistant).toBeDefined();
        expect(assistant.content).toBe('正在处理…');
        // 无 tool 消息
        expect(messages.filter((m: any) => m.role === 'tool')).toHaveLength(0);
    });

    test('正常 functionCall + functionResponse 配对不受影响', () => {
        const formatter = new OpenAIFormatter();
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history: buildNormalCallAndResponse(),
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
        expect(assistant.tool_calls).toHaveLength(1);
        expect(assistant.tool_calls[0].id).toBe('call_ok_1');
        expect(messages.filter((m: any) => m.role === 'tool')).toHaveLength(1);
    });
});

describe('AnthropicFormatter: rejected functionCall 过滤（function_call 模式）', () => {
    test('rejected 调用不生成 tool_use block', () => {
        const formatter = new AnthropicFormatter();
        const request = formatter.buildRequest({
            configId: 'anthropic-test',
            dynamicSystemPrompt: 'system prompt',
            history: [buildRejectedModelMessage()],
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
        // 文本保留
        const texts = JSON.stringify(assistant.content);
        expect(texts).toContain('正在处理…');
        // 没有 tool_use block
        expect(texts).not.toContain('tool_use');
        // 没有 tool_result 消息
        expect(messages.filter((m: any) => JSON.stringify(m.content).includes('tool_result'))).toHaveLength(0);
    });
});

describe('OpenAIResponsesFormatter: rejected functionCall 过滤', () => {
    test('rejected 调用不生成 function_call item', () => {
        const formatter = new OpenAIResponsesFormatter();
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history: [buildRejectedModelMessage()],
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, { ...createOpenAIConfig(), type: 'openai-responses' } as any);

        const body = request.body as any;
        const input = body.input as any[];
        const fcItems = input.filter((i: any) => i?.type === 'function_call');
        expect(fcItems).toHaveLength(0);
        // 文本 item 保留
        const textItems = input.filter((i: any) => i?.type === 'message' || i?.role === 'user' || i?.role === 'assistant');
        expect(textItems.length).toBeGreaterThan(0);
    });
});

describe('validateHistoryIntegrity: rejected functionCall 不构成孤儿', () => {
    test('detectOrphanFunctionCall 开启时 rejected 调用不报 orphan_function_call', () => {
        const result = validateHistoryIntegrity([buildRejectedModelMessage()], {
            detectOrphanFunctionCall: true
        });
        expect(result.valid).toBe(true);
        expect(result.issues.filter(i => i.kind === 'orphan_function_call')).toHaveLength(0);
    });

    test('未响应的非 rejected 调用仍报 orphan_function_call（原有检测不回归）', () => {
        const result = validateHistoryIntegrity([
            {
                role: 'model',
                parts: [
                    { functionCall: { id: 'call_unresolved', name: 'read_file', args: {} } }
                ]
            }
        ], { detectOrphanFunctionCall: true });
        expect(result.valid).toBe(false);
        expect(result.issues).toContainEqual(expect.objectContaining({
            kind: 'orphan_function_call',
            callId: 'call_unresolved'
        }));
    });

    test('duplicate_function_call_id 检测不受 rejected 标记影响', () => {
        const result = validateHistoryIntegrity([
            {
                role: 'model',
                parts: [
            { functionCall: { id: 'call_dup', name: 'read_file', args: {} } },
                    { functionCall: { id: 'call_dup', name: 'todo_write', args: {}, rejected: true } }
                ]
            }
        ], { detectOrphanFunctionCall: true });
        expect(result.issues.filter(i => i.kind === 'duplicate_function_call_id')).toHaveLength(1);
    });
});

describe('formatHistoryForAPI: 无配对响应的 rejected 调用整体丢弃（主路径核心修复）', () => {
    const manager = new ConversationManager(new MemoryStorageAdapter());

    test('中断残留（rejected 无响应）被丢弃，不再进入发送历史', () => {
        const forApi = manager.getHistoryForAPIFrom([
            { role: 'user', parts: [{ text: '继续' }] },
            { role: 'model', parts: [
                { text: '正在处理…' },
                { functionCall: { id: 'call_rej_1', name: 'read_file', args: { path: 'a.png' }, rejected: true } },
                { functionCall: { id: 'call_rej_2', name: 'subagents', args: { agentName: 'A' }, rejected: true } }
            ] }
        ]);

        // 只有 user 消息 + 文本形态的 model 消息（rejected 调用被整体丢弃）
        expect(forApi).toHaveLength(2);
        const model = forApi[1];
        expect(model.parts).toEqual([{ text: '正在处理…' }]);
        expect(model.parts.some(p => p.functionCall)).toBe(false);
    });

    test('用户显式拒绝（rejected + 占位响应）保留成对发送，rejected 字段剥离', () => {
        const forApi = manager.getHistoryForAPIFrom([
            { role: 'user', parts: [{ text: '拒绝该工具' }] },
            { role: 'model', parts: [
                { functionCall: { id: 'call_rej_3', name: 'read_file', args: { path: 'a.txt' }, rejected: true } }
            ] },
            { role: 'user', isFunctionResponse: true, parts: [
                { functionResponse: { id: 'call_rej_3', name: 'read_file', response: { success: false, error: 'User rejected the tool call', rejected: true } } }
            ] }
        ]);

        // call 保留（剥 rejected 字段）+ 响应改写为拒绝态：成对发送
        expect(forApi).toHaveLength(3);
        const model = forApi[1];
        expect(model.parts[0].functionCall?.id).toBe('call_rej_3');
        expect(model.parts[0].functionCall?.rejected).toBeUndefined();
        const fr = forApi[2].parts[0].functionResponse;
        expect(fr?.id).toBe('call_rej_3');
        expect(fr?.response).toMatchObject({ success: false, error: expect.any(String), rejected: true });
    });

    test('端到端：formatHistoryForAPI 丢弃后 OpenAI formatter 不再产生孤儿 tool_calls', () => {
        const formatter = new OpenAIFormatter();
        const history = manager.getHistoryForAPIFrom([
            { role: 'model', parts: [
                { text: '正在处理…' },
                { functionCall: { id: 'call_rej_e2e', name: 'subagents', args: {}, rejected: true } }
            ] }
        ]);

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
        expect(messages.filter((m: any) => m.role === 'assistant' && m.tool_calls)).toHaveLength(0);
        expect(messages.filter((m: any) => m.role === 'tool')).toHaveLength(0);
    });
});

describe('GeminiFormatter: rejected functionCall 过滤', () => {
    test('XML 模式：rejected 调用不转文本，也不泄漏原生 part', () => {
        const formatter = new GeminiFormatter();
        const request = buildGeminiRequest(formatter, [buildRejectedModelMessage()], 'xml');
        const contents = request.body.contents as any[];
        const serialized = JSON.stringify(contents);
        // 文本保留、无 functionCall 泄漏、无 XML 调用文本
        expect(serialized).toContain('正在处理…');
        expect(serialized).not.toContain('call_rej_');
        expect(serialized).not.toContain('read_file');
    });

    test('JSON 模式：rejected 调用不转文本，也不泄漏原生 part', () => {
        const formatter = new GeminiFormatter();
        const request = buildGeminiRequest(formatter, [buildRejectedModelMessage()], 'json');
        const contents = request.body.contents as any[];
        const serialized = JSON.stringify(contents);
        expect(serialized).toContain('正在处理…');
        expect(serialized).not.toContain('call_rej_');
        // convertFunctionCallToJSON 的文本不含 call id，必须按工具名断言才能抓住转文本泄漏
        expect(serialized).not.toContain('read_file');
    });

    test('原生 function_call 模式：rejected 调用 part 被过滤', () => {
        const formatter = new GeminiFormatter();
        const request = buildGeminiRequest(formatter, [buildRejectedModelMessage()], 'function_call');
        const contents = request.body.contents as any[];
        const serialized = JSON.stringify(contents);
        expect(serialized).toContain('正在处理…');
        expect(serialized).not.toContain('call_rej_');
    });

/** 混合形态：rejected call + 配对占位 response（防御层直传路径形态） */
function buildRejectedCallWithResponse(): Content[] {
    return [
        {
            role: 'model',
            parts: [
                { functionCall: { id: 'call_mix_1', name: 'read_file', args: { path: 'a.txt' }, rejected: true } }
            ]
        },
        {
            role: 'user',
            isFunctionResponse: true,
            parts: [
                { functionResponse: { id: 'call_mix_1', name: 'read_file', response: { success: false, error: 'User rejected the tool call', rejected: true } } }
            ]
        }
    ];
}

/** 正常调用正控（防「丢弃所有调用」类回归） */
function buildNormalCall(): Content[] {
    return [
        {
            role: 'model',
            parts: [
                { functionCall: { id: 'call_norm_1', name: 'read_file', args: { path: 'c.txt' } } }
            ]
        },
        {
            role: 'user',
            isFunctionResponse: true,
            parts: [
                { functionResponse: { id: 'call_norm_1', name: 'read_file', response: { success: true, data: '内容C' } } }
            ]
        }
    ];
}

describe('formatter 成对过滤：rejected call + 配对 response 一起丢弃（防御层加固）', () => {
    test('OpenAI function_call 模式：rejected call 及其占位 response 都不输出（无孤儿 tool 消息）', () => {
        const formatter = new OpenAIFormatter();
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history: buildRejectedCallWithResponse(),
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, createOpenAIConfig());

        const messages = request.body.messages as any[];
        expect(messages.filter((m: any) => m.role === 'assistant' && m.tool_calls)).toHaveLength(0);
        expect(messages.filter((m: any) => m.role === 'tool')).toHaveLength(0);
        expect(JSON.stringify(messages)).not.toContain('call_mix_1');
    });

    test('Anthropic function_call 模式：rejected call 及其占位 response 都不输出（无孤儿 tool_result）', () => {
        const formatter = new AnthropicFormatter();
        const request = formatter.buildRequest({
            configId: 'anthropic-test',
            dynamicSystemPrompt: 'system prompt',
            history: buildRejectedCallWithResponse(),
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, createAnthropicConfig());

        const serialized = JSON.stringify(request.body.messages);
        expect(serialized).not.toContain('tool_use');
        expect(serialized).not.toContain('tool_result');
        expect(serialized).not.toContain('call_mix_1');
    });

    test('OpenAIResponses：rejected call 及其 function_call_output 都不输出', () => {
        const formatter = new OpenAIResponsesFormatter();
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history: buildRejectedCallWithResponse(),
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, { ...createOpenAIConfig(), type: 'openai-responses' } as any);

        const input = request.body.input as any[];
        expect(input.filter((i: any) => i?.type === 'function_call')).toHaveLength(0);
        expect(input.filter((i: any) => i?.type === 'function_call_output')).toHaveLength(0);
        expect(JSON.stringify(input)).not.toContain('call_mix_1');
    });

    test('Gemini 原生模式：rejected call 及其配对 response 都丢弃，无空 parts 消息', () => {
        const formatter = new GeminiFormatter();
        const request = buildGeminiRequest(formatter, buildRejectedCallWithResponse(), 'function_call');
        const contents = request.body.contents as any[];
        expect(JSON.stringify(contents)).not.toContain('call_mix_1');
        expect(contents.every((c: any) => c.parts.length > 0)).toBe(true);
    });
});

describe('formatter 正常调用正控（防「丢弃所有调用」类回归）', () => {
    test('OpenAIResponses：正常 call + response 仍输出 function_call + function_call_output', () => {
        const formatter = new OpenAIResponsesFormatter();
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history: buildNormalCall(),
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, { ...createOpenAIConfig(), type: 'openai-responses' } as any);

        const input = request.body.input as any[];
        expect(input.filter((i: any) => i?.type === 'function_call')).toHaveLength(1);
        expect(input.filter((i: any) => i?.type === 'function_call_output')).toHaveLength(1);
    });

    test('Gemini XML/JSON/原生：正常调用仍保留', () => {
        for (const mode of ['xml', 'json']) {
            // XML/JSON 模式把调用转成文本（不含 call id，含工具名）
            const formatter = new GeminiFormatter();
            const request = buildGeminiRequest(formatter, buildNormalCall(), mode);
            const serialized = JSON.stringify(request.body.contents);
            expect(serialized).toContain('read_file');
        }
        // 原生模式保留 call id
        const nativeFormatter = new GeminiFormatter();
        const nativeRequest = buildGeminiRequest(nativeFormatter, buildNormalCall(), 'function_call');
        expect(JSON.stringify(nativeRequest.body.contents)).toContain('call_norm_1');
    });
});

describe('纯 rejected 消息（无文本）：formatter 不产生空消息/空 parts', () => {
    function buildOnlyRejectedCall(): Content[] {
        return [{
            role: 'model',
            parts: [
                { functionCall: { id: 'call_only_1', name: 'read_file', args: {}, rejected: true } }
            ]
        }];
    }

    test('OpenAI function_call 模式：不输出任何消息', () => {
        const formatter = new OpenAIFormatter();
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history: buildOnlyRejectedCall(),
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, createOpenAIConfig());

        // 排除 system 消息后，历史部分不输出任何消息（纯 rejected 调用被丢弃）
        expect(request.body.messages.filter((m: any) => m.role !== 'system')).toHaveLength(0);
    });

    test('Gemini 三模式：纯 rejected 消息被整体丢弃，无空 parts', () => {
        for (const mode of ['xml', 'json', 'function_call']) {
            const formatter = new GeminiFormatter();
            const request = buildGeminiRequest(formatter, buildOnlyRejectedCall(), mode);
            const contents = request.body.contents as any[];
            expect(contents).toHaveLength(0);
        }
    });
});

describe('prompt 模式（xml/json）：rejected 调用不转文本', () => {
    test('OpenAI xml 模式：rejected 不转 XML 调用文本，周围文本保留', () => {
        const formatter = new OpenAIFormatter();
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history: [buildRejectedModelMessage()],
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, { ...createOpenAIConfig(), toolMode: 'xml' } as any);

        const serialized = JSON.stringify(request.body.messages);
        expect(serialized).toContain('正在处理…');
        expect(serialized).not.toContain('read_file');
    });

    test('OpenAI json 模式：rejected 不转 JSON 调用文本', () => {
        const formatter = new OpenAIFormatter();
        const request = formatter.buildRequest({
            configId: 'openai-test',
            dynamicSystemPrompt: 'system prompt',
            history: [buildRejectedModelMessage()],
            promptContext: {
                beforeHistoryMessages: [],
                afterHistoryMessages: [],
                historyPlacement: 'legacy'
            },
            dynamicContextStrategy: 'single'
        }, { ...createOpenAIConfig(), toolMode: 'json' } as any);

        const serialized = JSON.stringify(request.body.messages);
        expect(serialized).toContain('正在处理…');
        expect(serialized).not.toContain('read_file');
    });

    test('Anthropic xml/json 模式：rejected 不转文本', () => {
        for (const mode of ['xml', 'json']) {
            const formatter = new AnthropicFormatter();
            const request = formatter.buildRequest({
                configId: 'anthropic-test',
                dynamicSystemPrompt: 'system prompt',
                history: [buildRejectedModelMessage()],
                promptContext: {
                    beforeHistoryMessages: [],
                    afterHistoryMessages: [],
                    historyPlacement: 'legacy'
                },
                dynamicContextStrategy: 'single'
            }, { ...createAnthropicConfig(), toolMode: mode } as any);

            const serialized = JSON.stringify(request.body.messages);
            expect(serialized).toContain('正在处理…');
            expect(serialized).not.toContain('read_file');
        }
    });
});
});
