/**
 * Gemini Interactions API formatter 测试
 *
 * 覆盖 GeminiInteractionsFormatter（gemini-interactions 渠道）：
 * 1. buildRequest：历史 → steps 转换（普通/工具/思考签名）、generation_config 映射、
 *    tools 扁平格式、URL/headers/stream 标志
 * 2. parseResponse：steps → Content（completed / requires_action / usage / 签名 / failed）
 * 3. parseStreamChunk：SSE 事件状态机（step.start/delta/stop、arguments 增量、
 *    thought_summary/thought_signature、interaction.completed、requires_action、error）
 * 4. 旧 gemini（generateContent）渠道行为不回归
 */

import { GeminiInteractionsFormatter } from '../../modules/channel';
import { GeminiFormatter, StreamAccumulator } from '../../modules/channel';
import { normalizeGeminiModelId } from '../../modules/channel/formatters/gemini';
import type { GenerateRequest } from '../../modules/channel';
import type { GeminiInteractionsConfig } from '../../modules/config/types';
import type { Content } from '../../modules/conversation/types';

const sampleTools = [
    {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path' }
            },
            required: ['path']
        }
    }
] as any;

function makeConfig(overrides: Partial<GeminiInteractionsConfig> = {}): GeminiInteractionsConfig {
    return {
        id: 'cfg-1',
        name: 'Gemini Interactions',
        type: 'gemini-interactions',
        enabled: true,
        url: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: 'test-key',
        model: 'gemini-3.6-flash',
        createdAt: 0,
        updatedAt: 0,
        options: {
            stream: false
        },
        optionsEnabled: {},
        ...overrides
    } as GeminiInteractionsConfig;
}

function makeRequest(history: Content[], overrides: Partial<GenerateRequest> = {}): GenerateRequest {
    return {
        configId: 'cfg-1',
        history,
        ...overrides
    } as GenerateRequest;
}

describe('GeminiInteractionsFormatter.buildRequest', () => {
    const formatter = new GeminiInteractionsFormatter();

    test('普通历史转换为 user_input / model_output steps（无状态模式）', () => {
        const history: Content[] = [
            { role: 'user', parts: [{ text: 'Hello' }] },
            { role: 'model', parts: [{ text: 'Hi there' }] },
            { role: 'user', parts: [{ text: 'How are you?' }] }
        ];

        const result = formatter.buildRequest(makeRequest(history), makeConfig());

        expect(result.method).toBe('POST');
        expect(result.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
        expect(result.headers['x-goog-api-key']).toBe('test-key');

        const body = result.body as any;
        expect(body.model).toBe('gemini-3.6-flash');
        expect(body.store).toBe(false);
        expect(body.stream).toBeUndefined();
        expect(body.input).toEqual([
            { type: 'user_input', content: [{ type: 'text', text: 'Hello' }] },
            { type: 'model_output', content: [{ type: 'text', text: 'Hi there' }] },
            { type: 'user_input', content: [{ type: 'text', text: 'How are you?' }] }
        ]);
    });

    test('流式时 URL 带 alt=sse 且 body.stream=true', () => {
        const result = formatter.buildRequest(
            makeRequest([{ role: 'user', parts: [{ text: 'x' }] }]),
            makeConfig({ options: { stream: true } })
        );

        expect(result.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions?alt=sse');
        expect((result.body as any).stream).toBe(true);
        expect(result.stream).toBe(true);
    });

    test('尾斜杠与基础 query 会规范合并，stream 强制覆盖 alt=sse', () => {
        const result = formatter.buildRequest(
            makeRequest([{ role: 'user', parts: [{ text: 'x' }] }]),
            makeConfig({
                url: '  https://generativelanguage.googleapis.com/v1beta/?api-version=1&alt=json  ',
                options: { stream: true }
            })
        );

        expect(result.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions?api-version=1&alt=sse');
        expect(result.url).not.toContain('/v1beta//interactions');
    });

    test('工具历史转换为 function_call / function_result steps（call_id 关联）', () => {
        const history: Content[] = [
            { role: 'user', parts: [{ text: 'Read b.ts' }] },
            { role: 'model', parts: [{ functionCall: { id: 'fc_1', name: 'read_file', args: { path: 'b.ts' } } }] },
            { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'fc_1', name: 'read_file', response: { success: true, content: 'code' } } }] }
        ];

        const result = formatter.buildRequest(makeRequest(history), makeConfig());

        const input = (result.body as any).input;
        expect(input).toEqual([
            { type: 'user_input', content: [{ type: 'text', text: 'Read b.ts' }] },
            { type: 'function_call', id: 'fc_1', name: 'read_file', arguments: { path: 'b.ts' } },
            {
                type: 'function_result',
                call_id: 'fc_1',
                name: 'read_file',
                result: [{ type: 'text', text: JSON.stringify({ success: true, content: 'code' }) }]
            }
        ]);
    });

    test('functionResponse 多模态 parts 追加到 result 内容块', () => {
        const history: Content[] = [
            { role: 'model', parts: [{ functionCall: { id: 'fc_2', name: 'read_file', args: {} } }] },
            {
                role: 'user',
                isFunctionResponse: true,
                parts: [{
                    functionResponse: {
                        id: 'fc_2',
                        name: 'read_file',
                        response: { success: true },
                        parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }]
                    }
                }]
            }
        ];

        const result = formatter.buildRequest(makeRequest(history), makeConfig());

        const input = (result.body as any).input;
        expect(input[1]).toEqual({
            type: 'function_result',
            call_id: 'fc_2',
            name: 'read_file',
            result: [
                { type: 'text', text: '{"success":true}' },
                { type: 'image', data: 'aGVsbG8=', mime_type: 'image/png' }
            ]
        });
    });

    test('思考 + 签名转换为 thought step（signature/summary）', () => {
        const history: Content[] = [
            { role: 'user', parts: [{ text: 'Solve this' }] },
            {
                role: 'model',
                parts: [
                    { thought: true, text: 'Let me think', thoughtSignatures: { gemini: 'sig-abc' } },
                    { text: 'Answer is 42' }
                ]
            }
        ];

        const result = formatter.buildRequest(makeRequest(history), makeConfig());

        const input = (result.body as any).input;
        expect(input).toEqual([
            { type: 'user_input', content: [{ type: 'text', text: 'Solve this' }] },
            {
                type: 'thought',
                signature: 'sig-abc',
                summary: [{ type: 'text', text: 'Let me think' }]
            },
            { type: 'model_output', content: [{ type: 'text', text: 'Answer is 42' }] }
        ]);
    });

    test('functionCall 上的旧格式签名并入同消息 thought step；无 thought 时生成仅签名 step', () => {
        // 场景 1：functionCall 带签名 + 同消息有 thought step → 签名并入 thought step
        const history1: Content[] = [
            { role: 'user', parts: [{ text: 'q' }] },
            {
                role: 'model',
                parts: [
                    { thought: true, text: 'thinking...' },
                    { functionCall: { id: 'fc_1', name: 'read_file', args: {} }, thoughtSignatures: { gemini: 'sig-1' } } as any
                ]
            }
        ];
        const input1 = (formatter.buildRequest(makeRequest(history1), makeConfig()).body as any).input;
        expect(input1[1]).toEqual({
            type: 'thought',
            signature: 'sig-1',
            summary: [{ type: 'text', text: 'thinking...' }]
        });
        expect(input1[2]).toEqual({ type: 'function_call', id: 'fc_1', name: 'read_file', arguments: {} });

        // 场景 2：functionCall 带签名但同消息无 thought step → 生成仅签名 thought step（位于调用前）
        const history2: Content[] = [
            { role: 'user', parts: [{ text: 'q' }] },
            {
                role: 'model',
                parts: [
                    { functionCall: { id: 'fc_2', name: 'read_file', args: {} }, thoughtSignatures: { gemini: 'sig-2' } } as any
                ]
            }
        ];
        const input2 = (formatter.buildRequest(makeRequest(history2), makeConfig()).body as any).input;
        expect(input2[1]).toEqual({ type: 'thought', signature: 'sig-2', summary: [] });
        expect(input2[2]).toEqual({ type: 'function_call', id: 'fc_2', name: 'read_file', arguments: {} });
    });

    test('generation_config 映射：level 模式 / budget 模式 / includeThoughts=false', () => {
        // level 模式
        const r1 = formatter.buildRequest(
            makeRequest([{ role: 'user', parts: [{ text: 'x' }] }]),
            makeConfig({
                options: {
                    temperature: 0.7,
                    maxOutputTokens: 1024,
                    thinkingConfig: { includeThoughts: true, mode: 'level', thinkingLevel: 'high' }
                },
                optionsEnabled: { temperature: true, maxOutputTokens: true, thinkingConfig: true }
            })
        );
        expect((r1.body as any).generation_config).toEqual({
            temperature: 0.7,
            max_output_tokens: 1024,
            thinking_level: 'high'
        });

        // budget 模式：Interactions 无 thinking_budget，不发送该字段
        const r2 = formatter.buildRequest(
            makeRequest([{ role: 'user', parts: [{ text: 'x' }] }]),
            makeConfig({
                options: {
                    thinkingConfig: { includeThoughts: true, mode: 'budget', thinkingBudget: 2048 }
                },
                optionsEnabled: { thinkingConfig: true }
            })
        );
        expect((r2.body as any).generation_config).toEqual({});

        // includeThoughts=false → thinking_summaries: none
        const r3 = formatter.buildRequest(
            makeRequest([{ role: 'user', parts: [{ text: 'x' }] }]),
            makeConfig({
                options: {
                    thinkingConfig: { includeThoughts: false, mode: 'default' }
                },
                optionsEnabled: { thinkingConfig: true }
            })
        );
        expect((r3.body as any).generation_config).toEqual({ thinking_summaries: 'none' });
    });

    test('tools 转换为扁平 function 数组（非 function_declarations 包装）', () => {
        const result = formatter.buildRequest(
            makeRequest([{ role: 'user', parts: [{ text: 'x' }] }]),
            makeConfig(),
            sampleTools
        );

        const tools = (result.body as any).tools;
        expect(tools).toEqual([
            {
                type: 'function',
                name: 'read_file',
                description: 'Read a file',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'File path' }
                    },
                    required: ['path']
                }
            }
        ]);
    });

    test('system_instruction 为字符串（含动态系统提示词与工具占位符）', () => {
        const result = formatter.buildRequest(
            makeRequest([{ role: 'user', parts: [{ text: 'x' }] }], { dynamicSystemPrompt: 'OS: Windows' }),
            makeConfig({ systemInstruction: 'You are a cat' })
        );

        const body = result.body as any;
        expect(body.system_instruction).toContain('You are a cat');
        expect(body.system_instruction).toContain('OS: Windows');
    });

    test('Authorization Bearer 头（useAuthorizationHeader）', () => {
        const result = formatter.buildRequest(
            makeRequest([{ role: 'user', parts: [{ text: 'x' }] }]),
            makeConfig({ useAuthorizationHeader: true })
        );

        expect(result.headers['x-goog-api-key']).toBeUndefined();
        expect(result.headers['Authorization']).toBe('Bearer test-key');
    });

    test('手填 models/ 前缀被剥除：body.model 保持官方裸 ID（不追加 models/）', () => {
        const result = formatter.buildRequest(
            makeRequest([{ role: 'user', parts: [{ text: 'x' }] }]),
            makeConfig({ model: 'models/gemini-3.6-flash' })
        );

        expect((result.body as any).model).toBe('gemini-3.6-flash');
    });
});

describe('GeminiInteractionsFormatter.parseResponse', () => {
    const formatter = new GeminiInteractionsFormatter();

    test('completed：文本 + usage 映射', () => {
        const result = formatter.parseResponse({
            id: 'int_1',
            model: 'gemini-3.6-flash',
            status: 'completed',
            steps: [
                { type: 'user_input', status: 'done', content: [{ type: 'text', text: 'q' }] },
                {
                    type: 'model_output',
                    status: 'done',
                    content: [{ type: 'text', text: 'The answer is 42.' }]
                }
            ],
            usage: {
                total_input_tokens: 100,
                total_output_tokens: 20,
                total_thought_tokens: 30,
                total_cached_tokens: 40,
                total_tokens: 150
            }
        });

        expect(result.content.role).toBe('model');
        expect(result.content.parts).toEqual([{ text: 'The answer is 42.' }]);
        expect(result.finishReason).toBe('STOP');
        expect(result.model).toBe('gemini-3.6-flash');
        expect(result.content.modelVersion).toBe('gemini-3.6-flash');
        expect(result.content.usageMetadata).toEqual({
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 30,
            cachedContentTokenCount: 40,
            cacheReadTokenCount: 40,
            totalTokenCount: 150
        });
    });

    test('requires_action：function_call step 转换为 functionCall part（带 id）', () => {
        const result = formatter.parseResponse({
            id: 'int_2',
            model: 'gemini-3.6-flash',
            status: 'requires_action',
            steps: [
                {
                    type: 'function_call',
                    status: 'waiting',
                    id: 'fc_1',
                    name: 'get_weather',
                    arguments: { location: 'Boston, MA' }
                }
            ]
        });

        expect(result.finishReason).toBe('STOP');
        expect(result.content.parts).toEqual([
            { functionCall: { name: 'get_weather', args: { location: 'Boston, MA' }, id: 'fc_1' } }
        ]);
    });

    test('thought step：摘要文本 + 签名提取（签名存 thoughtSignatures.gemini）', () => {
        const result = formatter.parseResponse({
            id: 'int_3',
            status: 'completed',
            steps: [
                {
                    type: 'thought',
                    signature: 'EpoG-sig',
                    summary: [
                        { type: 'text', text: 'First thought' },
                        { type: 'text', text: 'Second thought' }
                    ]
                },
                { type: 'model_output', content: [{ type: 'text', text: 'Answer' }] }
            ]
        });

        const parts = result.content.parts as any[];
        expect(parts).toContainEqual({
            text: 'First thought\nSecond thought',
            thought: true,
            thoughtSignatures: { gemini: 'EpoG-sig' }
        });
        expect(parts).toContainEqual({ text: 'Answer' });
    });

    test('仅签名 thought step（summary 为空）也保留', () => {
        const result = formatter.parseResponse({
            id: 'int_4',
            status: 'completed',
            steps: [
                { type: 'thought', signature: 'sig-only', summary: [] },
                { type: 'model_output', content: [{ type: 'text', text: 'Answer' }] }
            ]
        });

        expect(result.content.parts[0]).toEqual({
            thought: true,
            thoughtSignatures: { gemini: 'sig-only' }
        });
    });

    test('多模态输出块转换为 inlineData', () => {
        const result = formatter.parseResponse({
            id: 'int_5',
            status: 'completed',
            steps: [
                {
                    type: 'model_output',
                    content: [
                        { type: 'text', text: 'Here is the image:' },
                        { type: 'image', mime_type: 'image/png', data: 'aGVsbG8=' }
                    ]
                }
            ]
        });

        expect(result.content.parts).toEqual([
            { text: 'Here is the image:' },
            { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }
        ]);
    });

    test('failed 状态抛 ChannelError；无效响应抛错', () => {
        expect(() => formatter.parseResponse({ id: 'int_6', status: 'failed', steps: [] })).toThrow();
        expect(() => formatter.parseResponse({})).toThrow();
        expect(() => formatter.parseResponse({ id: 'int_7', status: 'completed' })).toThrow();
    });

    test('HTTP 200 内联错误体抛出上游原文', () => {
        expect(() => formatter.parseResponse({ error: { message: 'quota exceeded', code: 429 } })).toThrow('quota exceeded');
    });

    test('budget_exceeded 状态：非错误终止，映射 incomplete（非流式）', () => {
        const result = formatter.parseResponse({
            id: 'int_be',
            status: 'budget_exceeded',
            steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Partial answer' }] }]
        });

        expect(result.finishReason).toBe('incomplete');
        expect(result.content.parts).toEqual([{ text: 'Partial answer' }]);
    });
});

describe('GeminiInteractionsFormatter.parseStreamChunk（SSE 事件状态机）', () => {
    const formatter = new GeminiInteractionsFormatter();

    test('思考 + 文本全链路：step.start(thought) → thought_summary → thought_signature → model_output → text → completed', () => {
        const chunks: any[] = [
            { type: 'interaction.created', interaction: { id: 'int_x', status: 'in_progress', model: 'gemini-3.6-flash' } },
            { type: 'step.start', index: 0, step: { type: 'thought', signature: '', summary: [{ type: 'text', text: '**Thinking**' }] } },
            { type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: ' more' } } },
            { type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'EpoG-sig' } },
            { type: 'step.stop', index: 0 },
            { type: 'step.start', index: 1, step: { type: 'model_output', content: [{ type: 'text', text: 'Answer:' }] } },
            { type: 'step.delta', index: 1, delta: { type: 'text', text: ' 42' } },
            { type: 'step.stop', index: 1 },
            {
                type: 'interaction.completed',
                interaction: { id: 'int_x', status: 'completed', model: 'gemini-3.6-flash', usage: { total_input_tokens: 10, total_output_tokens: 5, total_tokens: 15 } }
            }
        ];

        const parsed = chunks.map(c => formatter.parseStreamChunk(c));

        // interaction.created：modelVersion 提前暴露
        expect(parsed[0].modelVersion).toBe('gemini-3.6-flash');
        expect(parsed[0].done).toBe(false);

        // 思考初始摘要（step.start 携带）+ 增量
        expect(parsed[1].delta).toEqual([{ text: '**Thinking**', thought: true }]);
        expect(parsed[2].delta).toEqual([{ text: ' more', thought: true }]);
        // thought_signature：复数格式（thoughtSignatures.gemini），由 StreamAccumulator 非文本分支存储
        expect(parsed[3].delta).toEqual([{ thought: true, thoughtSignatures: { gemini: 'EpoG-sig' } }]);
        expect(parsed[4].done).toBe(false);

        // model_output 初始块 + 文本增量
        expect(parsed[5].delta).toEqual([{ text: 'Answer:' }]);
        expect(parsed[6].delta).toEqual([{ text: ' 42' }]);

        // 完成事件：done + usage
        expect(parsed[8].done).toBe(true);
        expect(parsed[8].finishReason).toBe('STOP');
        expect(parsed[8].modelVersion).toBe('gemini-3.6-flash');
        expect(parsed[8].usage).toEqual({
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15
        });
    });

    test('函数调用流程：step.start 占位 → arguments_delta 增量 → requires_action 结束（done）', () => {
        const chunks: any[] = [
            { type: 'interaction.created', interaction: { id: 'int_y', status: 'in_progress' } },
            { type: 'step.start', index: 0, step: { type: 'function_call', id: 'fc_1', name: 'get_weather' } },
            { type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{"location": "' } },
            { type: 'step.delta', index: 0, delta: { type: 'arguments', arguments: 'Boston, MA"}' } },
            { type: 'step.stop', index: 0, status: 'waiting' },
            { type: 'interaction.status_update', interaction_id: 'int_y', status: 'requires_action' }
        ];

        const parsed = chunks.map(c => formatter.parseStreamChunk(c));

        // 占位 part：id/name/index
        expect(parsed[1].delta).toEqual([
            { functionCall: { name: 'get_weather', args: {}, partialArgs: '', index: 0, id: 'fc_1' } }
        ]);
        // arguments_delta / arguments 两种 type 都认；官方 delta.arguments 字段，index 定位
        expect(parsed[2].delta).toEqual([
            { functionCall: { partialArgs: '{"location": "', index: 0 } }
        ]);
        expect(parsed[3].delta).toEqual([
            { functionCall: { partialArgs: 'Boston, MA"}', index: 0 } }
        ]);
        // requires_action：本轮生成结束（工具回合等待结果）
        expect(parsed[5].done).toBe(true);
        expect(parsed[5].finishReason).toBe('STOP');
    });

    test('arguments 增量经 StreamAccumulator 合并并解析出完整参数', () => {
        const accumulator = new StreamAccumulator('function_call', () => 'generated-id');
        accumulator.setProviderType('gemini-interactions');

        const chunks: any[] = [
            { type: 'step.start', index: 0, step: { type: 'function_call', id: 'fc_1', name: 'read_file' } },
            { type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{"path": ' } },
            { type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '"b.ts"}' } },
            { type: 'step.stop', index: 0 },
            { type: 'interaction.status_update', status: 'requires_action' }
        ];

        for (const c of chunks) {
            accumulator.add(formatter.parseStreamChunk(c));
        }

        const finalContent = accumulator.getFinalContent();
        const fc = finalContent.parts.find(p => p.functionCall)?.functionCall;
        expect(fc?.name).toBe('read_file');
        expect(fc?.id).toBe('fc_1');
        expect(fc?.args).toEqual({ path: 'b.ts' });
    });

    test('arguments_delta：官方 delta.arguments 优先；partial_arguments 兼容；非字符串对象序列化；空增量不输出伪 part', () => {
        // 旧形态 partial_arguments 兼容
        const legacy = formatter.parseStreamChunk({
            type: 'step.delta', index: 0, delta: { type: 'arguments_delta', partial_arguments: '{"a":' }
        });
        expect(legacy.delta).toEqual([{ functionCall: { partialArgs: '{"a":', index: 0 } }]);

        // 官方字段 delta.arguments 优先：arguments 存在时忽略 partial_arguments
        const preferred = formatter.parseStreamChunk({
            type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '{"x":1}', partial_arguments: '{"y":2}' }
        });
        expect(preferred.delta).toEqual([{ functionCall: { partialArgs: '{"x":1}', index: 0 } }]);

        // 非字符串对象（部分代理直接返回完整对象）→ 合理序列化
        const objectDelta = formatter.parseStreamChunk({
            type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: { location: 'Boston' } }
        });
        expect(objectDelta.delta).toEqual([{ functionCall: { partialArgs: '{"location":"Boston"}', index: 0 } }]);

        // 空增量（无 arguments / partial_arguments）→ 不输出伪 part
        const empty = formatter.parseStreamChunk({
            type: 'step.delta', index: 0, delta: { type: 'arguments_delta' }
        });
        expect(empty.delta).toEqual([]);
        expect(formatter.parseStreamChunk({
            type: 'step.delta', index: 0, delta: { type: 'arguments_delta', arguments: '' }
        }).delta).toEqual([]);
    });

    test('思考文本与后到签名经 StreamAccumulator 合并为同一 part', () => {
        const accumulator = new StreamAccumulator('function_call', () => 'generated-id');
        accumulator.setProviderType('gemini-interactions');

        const chunks: any[] = [
            { type: 'step.start', index: 0, step: { type: 'thought', signature: 'sig-final', summary: [{ type: 'text', text: 'thinking' }] } },
            { type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: ' more' } } },
            { type: 'step.delta', index: 0, delta: { type: 'thought_signature', signature: 'sig-final' } },
            { type: 'step.stop', index: 0 },
            { type: 'interaction.completed', interaction: { status: 'completed' } }
        ];

        for (const c of chunks) {
            accumulator.add(formatter.parseStreamChunk(c));
        }

        const finalContent = accumulator.getFinalContent();
        expect(finalContent.parts).toEqual([{
            text: 'thinking more',
            thought: true,
            thoughtSignatures: { gemini: 'sig-final' }
        }]);
    });

    test('不同 thought step 的不同签名不会覆盖前一步', () => {
        const accumulator = new StreamAccumulator('function_call', () => 'generated-id');
        accumulator.setProviderType('gemini-interactions');

        const chunks: any[] = [
            { type: 'step.start', index: 0, step: { type: 'thought', signature: 'sig-old', summary: [{ type: 'text', text: 'first thought' }] } },
            { type: 'step.stop', index: 0 },
            { type: 'step.start', index: 1, step: { type: 'thought', signature: '', summary: [] } },
            { type: 'step.delta', index: 1, delta: { type: 'thought_signature', signature: 'sig-new' } },
            { type: 'step.stop', index: 1 }
        ];
        for (const chunk of chunks) accumulator.add(formatter.parseStreamChunk(chunk));

        expect(accumulator.getFinalContent().parts).toEqual([
            { text: 'first thought', thought: true, thoughtSignatures: { gemini: 'sig-old' } },
            { thought: true, thoughtSignatures: { gemini: 'sig-new' } }
        ]);
    });

    test('step.start(thought) 携带非空 signature 时保留；空签名不输出', () => {
        // 摘要 + 签名：签名并入同一 part
        const withSig = formatter.parseStreamChunk({
            type: 'step.start', index: 0,
            step: { type: 'thought', signature: 'EpoG-sig', summary: [{ type: 'text', text: 'Thinking...' }] }
        });
        expect(withSig.delta).toEqual([
            { text: 'Thinking...', thought: true, thoughtSignatures: { gemini: 'EpoG-sig' } }
        ]);

        // 无摘要仅签名：独立签名 part（与 thought_signature delta 同形态）
        const sigOnly = formatter.parseStreamChunk({
            type: 'step.start', index: 0,
            step: { type: 'thought', signature: 'sig-only', summary: [] }
        });
        expect(sigOnly.delta).toEqual([{ thought: true, thoughtSignatures: { gemini: 'sig-only' } }]);

        // 空签名：维持原行为（不输出签名）
        const emptySig = formatter.parseStreamChunk({
            type: 'step.start', index: 0,
            step: { type: 'thought', signature: '', summary: [{ type: 'text', text: 'Hi' }] }
        });
        expect(emptySig.delta).toEqual([{ text: 'Hi', thought: true }]);
    });

    test('error 事件抛出上游原文', () => {
        expect(() => formatter.parseStreamChunk({
            type: 'error',
            error: { message: 'Model not found', code: 'not_found' }
        })).toThrow('Model not found');
    });

    test('未知事件类型忽略（空 delta，前向兼容）', () => {
        const result = formatter.parseStreamChunk({ type: 'future.event', data: {} });
        expect(result.delta).toEqual([]);
        expect(result.done).toBe(false);
    });

    test('interaction.status_update(failed) 抛错；cancelled/incomplete 结束', () => {
        expect(() => formatter.parseStreamChunk({
            type: 'interaction.status_update', status: 'failed'
        })).toThrow();

        const cancelled = formatter.parseStreamChunk({ type: 'interaction.status_update', status: 'cancelled' });
        expect(cancelled.done).toBe(true);

        const incomplete = formatter.parseStreamChunk({ type: 'interaction.status_update', status: 'incomplete' });
        expect(incomplete.done).toBe(true);
        expect(incomplete.finishReason).toBe('incomplete');
    });

    test('interaction.status_update(budget_exceeded) 终止且映射 incomplete', () => {
        const result = formatter.parseStreamChunk({ type: 'interaction.status_update', status: 'budget_exceeded' });
        expect(result.done).toBe(true);
        expect(result.finishReason).toBe('incomplete');
    });

    test('interaction.completed 按终态细分：budget_exceeded/incomplete → incomplete；failed 抛错', () => {
        const budget = formatter.parseStreamChunk({
            type: 'interaction.completed',
            interaction: { status: 'budget_exceeded', usage: { total_input_tokens: 5, total_output_tokens: 2, total_tokens: 7 } }
        });
        expect(budget.done).toBe(true);
        expect(budget.finishReason).toBe('incomplete');
        expect(budget.usage).toEqual({ promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 });

        const incomplete = formatter.parseStreamChunk({
            type: 'interaction.completed', interaction: { status: 'incomplete' }
        });
        expect(incomplete.done).toBe(true);
        expect(incomplete.finishReason).toBe('incomplete');

        const completed = formatter.parseStreamChunk({
            type: 'interaction.completed', interaction: { status: 'completed' }
        });
        expect(completed.done).toBe(true);
        expect(completed.finishReason).toBe('STOP');

        expect(() => formatter.parseStreamChunk({
            type: 'interaction.completed', interaction: { status: 'failed' }
        })).toThrow();
    });

    test('interaction.requires_action 生命周期事件：本轮正常结束（STOP）', () => {
        const result = formatter.parseStreamChunk({ type: 'interaction.requires_action', interaction_id: 'int_x' });
        expect(result.done).toBe(true);
        expect(result.finishReason).toBe('STOP');
    });

    test('interaction.failed 生命周期事件：显式抛错', () => {
        expect(() => formatter.parseStreamChunk({ type: 'interaction.failed', interaction_id: 'int_x' })).toThrow();
    });
});

describe('GeminiInteractionsFormatter 与旧 gemini 渠道隔离', () => {
    test('convertTools：interactions 扁平数组 vs generateContent function_declarations 包装', () => {
        const interactions = new GeminiInteractionsFormatter();
        const legacy = new GeminiFormatter();

        const interactionsTools = interactions.convertTools(sampleTools);
        const legacyTools = legacy.convertTools(sampleTools);

        expect(Array.isArray(interactionsTools)).toBe(true);
        expect(interactionsTools[0]).toHaveProperty('type', 'function');
        expect(interactionsTools[0]).not.toHaveProperty('function_declarations');

        expect(legacyTools).toHaveLength(1);
        expect(legacyTools[0].function_declarations).toHaveLength(1);
    });

    test('getSupportedType / validateConfig 类型隔离', () => {
        const formatter = new GeminiInteractionsFormatter();
        expect(formatter.getSupportedType()).toBe('gemini-interactions');
        expect(formatter.validateConfig({ type: 'gemini', url: 'x', model: 'y' })).toBe(false);
        expect(formatter.validateConfig({ type: 'gemini-interactions', url: 'x', model: 'y' })).toBe(true);
        expect(formatter.validateConfig({ type: 'gemini-interactions', url: 'x' })).toBe(false);
    });

    test('旧 gemini formatter 的 parseResponse 行为不回归', () => {
        const legacy = new GeminiFormatter();
        const result = legacy.parseResponse({
            modelVersion: 'gemini-2.0-flash',
            candidates: [{ content: { role: 'model', parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }]
        });
        expect(result.content.parts).toEqual([{ text: 'Hi' }]);
    });

    test('旧 gemini 渠道：手填 models/ 前缀剥除后构造官方裸 model URL', () => {
        const legacy = new GeminiFormatter();
        const result = legacy.buildRequest(
            { configId: 'c', history: [{ role: 'user', parts: [{ text: 'x' }] }] } as any,
            {
                type: 'gemini',
                url: 'https://generativelanguage.googleapis.com/v1beta',
                model: 'models/gemini-2.0-flash',
                options: {},
                optionsEnabled: {}
            } as any
        );
        expect(result.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
        expect(result.url).not.toContain('models/models/');
    });

    test('旧 gemini 渠道：尾斜杠后的 query 仍放在最终端点末尾', () => {
        const legacy = new GeminiFormatter();
        const result = legacy.buildRequest(
            { configId: 'c', history: [{ role: 'user', parts: [{ text: 'x' }] }] } as any,
            {
                type: 'gemini',
                url: 'https://generativelanguage.googleapis.com/v1beta/?api-version=1',
                model: 'gemini-2.0-flash',
                options: {},
                optionsEnabled: {}
            } as any
        );
        expect(result.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?api-version=1');
        expect(result.url).not.toContain('/v1beta//models');
    });

    test('normalizeGeminiModelId：仅剥除 models/ 前缀，裸 ID 原样返回', () => {
        expect(normalizeGeminiModelId('models/gemini-3.6-flash')).toBe('gemini-3.6-flash');
        expect(normalizeGeminiModelId('gemini-3.6-flash')).toBe('gemini-3.6-flash');
        expect(normalizeGeminiModelId(undefined)).toBeUndefined();
    });
});
