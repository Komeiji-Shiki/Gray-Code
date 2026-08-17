import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import { StreamAccumulator } from '../../modules/channel';
import type { Content } from '../../modules/conversation/types';
import { createOpenAIResponsesConfig } from '../__fixtures__/channelFixtures';
import {
    extractUpstreamErrorFields,
    summarizeResponsesRequest
} from '../../modules/channel/channelManager/channelResponseHelpers';


describe('OpenAI Responses reasoning 与 usage', () => {
    test('请求诊断能定位 reasoning content 数组且不记录正文或密钥', () => {
        const diagnostic = summarizeResponsesRequest(
            'https://api.openai.com/v1/responses?api_key=should-not-log',
            {
                model: 'gpt-5',
                stream: true,
                instructions: 'private system prompt',
                input: [
                    {
                        type: 'message',
                        role: 'user',
                        content: [{ type: 'input_text', text: 'private user text' }]
                    },
                    {
                        type: 'reasoning',
                        content: [{ type: 'reasoning_text', text: 'private reasoning text' }]
                    }
                ],
                tools: [{ type: 'function', name: 'private-tool' }]
            }
        );

        expect(diagnostic).toMatchObject({
            endpointHost: 'api.openai.com',
            model: 'gpt-5',
            inputLength: 2,
            reasoningContentPaths: ['input[1].content'],
            toolsLength: 1
        });
        expect(diagnostic?.inputItems[1]).toMatchObject({
            index: 1,
            type: 'reasoning',
            content: {
                kind: 'array',
                length: 1,
                itemTypes: ['reasoning_text']
            }
        });

        const serialized = JSON.stringify(diagnostic);
        expect(serialized).not.toContain('private user text');
        expect(serialized).not.toContain('private reasoning text');
        expect(serialized).not.toContain('should-not-log');
        expect(extractUpstreamErrorFields({
            error: {
                message: JSON.stringify({
                    error: {
                        code: 'array_above_max_length',
                        param: 'input[1].content',
                        type: 'invalid_request_error'
                    }
                })
            }
        })).toEqual({
            code: 'array_above_max_length',
            param: 'input[1].content',
            type: 'invalid_request_error'
        });
    });

    test('非流式 candidatesTokenCount 使用含 reasoning 的总 output_tokens', () => {
        const formatter = new OpenAIResponsesFormatter();
        const response = formatter.parseResponse({
            model: 'gpt-5',
            status: 'completed',
            output: [{
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'answer' }]
            }],
            usage: {
                input_tokens: 75,
                input_tokens_details: { cached_tokens: 10 },
                output_tokens: 1186,
                output_tokens_details: { reasoning_tokens: 1024 },
                total_tokens: 1261
            }
        });

        expect(response.content.usageMetadata).toMatchObject({
            promptTokenCount: 75,
            candidatesTokenCount: 1186,
            thoughtsTokenCount: 1024,
            totalTokenCount: 1261
        });
    });

    test('流式 completed usage 同样使用含 reasoning 的总 output_tokens', () => {
        const formatter = new OpenAIResponsesFormatter();
        const chunk = formatter.parseStreamChunk({
            type: 'response.completed',
            response: {
                model: 'gpt-5',
                status: 'completed',
                usage: {
                    input_tokens: 75,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens: 1186,
                    output_tokens_details: { reasoning_tokens: 1024 },
                    total_tokens: 1261
                }
            }
        });

        expect(chunk.usage).toMatchObject({
            promptTokenCount: 75,
            candidatesTokenCount: 1186,
            thoughtsTokenCount: 1024,
            totalTokenCount: 1261
        });
    });

    test('流式摘要与 done reasoning item 合并为可回传的单一 part', () => {
        const formatter = new OpenAIResponsesFormatter();
        const accumulator = new StreamAccumulator('function_call', () => 'test_call');
        accumulator.setProviderType('openai-responses');

        accumulator.add(formatter.parseStreamChunk({
            type: 'response.reasoning_summary_text.delta',
            output_index: 0,
            item_id: 'rs_1',
            summary_index: 0,
            delta: 'Check the inputs'
        }));
        accumulator.add(formatter.parseStreamChunk({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
                id: 'rs_1',
                type: 'reasoning',
                status: 'completed',
                encrypted_content: 'encrypted-reasoning',
                summary: [{ type: 'summary_text', text: 'Check the inputs' }]
            }
        }));

        const thoughtParts = accumulator.getFinalContent().parts.filter(part => part.thought);
        expect(thoughtParts).toHaveLength(1);
        expect(thoughtParts[0]).toMatchObject({
            text: 'Check the inputs',
            thought: true,
            thoughtSignatures: { 'openai-responses': 'encrypted-reasoning' },
            openaiResponsesReasoning: {
                id: 'rs_1',
                status: 'completed',
                summary: [{ type: 'summary_text', text: 'Check the inputs' }]
            }
        });
    });

    test('下一轮按官方 reasoning item 格式回传 id、summary 与 encrypted_content', () => {
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [{
                    text: 'Check the inputs',
                    thought: true,
                    thoughtSignatures: { 'openai-responses': 'encrypted-reasoning' },
                    openaiResponsesReasoning: {
                        id: 'rs_1',
                        status: 'completed',
                        summary: [{ type: 'summary_text', text: 'Check the inputs' }]
                    }
                }, { text: 'The answer is 42.' }]
            },
            { role: 'user', parts: [{ text: 'Continue.' }] }
        ];

        const request = formatter.buildRequest({ configId: 'responses-test', history }, createOpenAIResponsesConfig({
            id: 'responses-test',
            name: 'Responses Test',
            preferStream: true,
            sendHistoryThoughtSignatures: true,
            options: {
                stream: true,
                reasoning: {
                    effort: 'medium',
                    summaryEnabled: true,
                    summary: 'auto'
                }
            }
        }));
        const reasoningItem = request.body.input.find((item: any) => item.type === 'reasoning');

        expect(request.body.include).toEqual(['reasoning.encrypted_content']);
        expect(request.body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
        expect(reasoningItem).toEqual({
            type: 'reasoning',
            id: 'rs_1',
            status: 'completed',
            encrypted_content: 'encrypted-reasoning',
            summary: [{ type: 'summary_text', text: 'Check the inputs' }]
        });
        expect(reasoningItem).not.toHaveProperty('content');
    });

    test('关闭「发送思考签名」时不回传 reasoning item（兼容不支持 reasoning 输入的第三方端点）', () => {
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [{
                    text: 'Check the inputs',
                    thought: true,
                    thoughtSignatures: { 'openai-responses': 'encrypted-reasoning' },
                    openaiResponsesReasoning: {
                        id: 'rs_1',
                        status: 'completed',
                        summary: [{ type: 'summary_text', text: 'Check the inputs' }]
                    }
                }, { text: 'The answer is 42.' }]
            },
            { role: 'user', parts: [{ text: 'Continue.' }] }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test',
                name: 'Responses Test',
                preferStream: true,
                sendHistoryThoughtSignatures: false,
                options: {
                    stream: true,
                    reasoning: {
                        effort: 'medium',
                        summaryEnabled: true,
                        summary: 'auto'
                    }
                }
            })
        );
        const reasoningItems = request.body.input.filter((item: any) => item.type === 'reasoning');
        const assistantTexts = request.body.input.filter((item: any) => item.type === 'message')
            .flatMap((item: any) => item.content)
            .filter((part: any) => part.type === 'output_text' || part.type === 'input_text')
            .map((part: any) => part.text);

        // 不回传 reasoning item，但可见摘要降级为普通 assistant 文本保留
        expect(reasoningItems).toHaveLength(0);
        expect(assistantTexts.join('')).toContain('Check the inputs');
        expect(assistantTexts.join('')).toContain('The answer is 42.');
    });

    test('DeepSeek content-only reasoning：delta + done 合并为可回传的单一 part', () => {
        const formatter = new OpenAIResponsesFormatter();
        const accumulator = new StreamAccumulator('function_call', () => 'test_call');
        accumulator.setProviderType('openai-responses');

        accumulator.add(formatter.parseStreamChunk({
            type: 'response.reasoning_text.delta',
            output_index: 0,
            item_id: 'rs_deepseek_1',
            delta: '先检查工具结果，'
        }));
        accumulator.add(formatter.parseStreamChunk({
            type: 'response.reasoning_text.delta',
            output_index: 0,
            item_id: 'rs_deepseek_1',
            delta: '再决定下一步'
        }));
        accumulator.add(formatter.parseStreamChunk({
            type: 'response.reasoning_text.done',
            output_index: 0,
            item_id: 'rs_deepseek_1',
            text: '先检查工具结果，再决定下一步'
        }));

        const thoughtParts = accumulator.getFinalContent().parts.filter(part => part.thought);
        expect(thoughtParts).toHaveLength(1);
        expect(thoughtParts[0]).toMatchObject({
            text: '先检查工具结果，再决定下一步',
            thought: true,
            openaiResponsesReasoning: {
                id: 'rs_deepseek_1',
                status: 'completed',
                content: [{ type: 'reasoning_text', text: '先检查工具结果，再决定下一步' }]
            }
        });
        expect(thoughtParts[0].thoughtSignatures).toBeUndefined();
    });

    test('Responses reasoning delta 记录思考起点，并在正文开始时结算耗时', () => {
        const formatter = new OpenAIResponsesFormatter();
        const accumulator = new StreamAccumulator('function_call', () => 'test_call');
        accumulator.setProviderType('openai-responses');
        const nowSpy = jest.spyOn(Date, 'now');

        try {
            nowSpy.mockReturnValue(1_000);
            accumulator.add(formatter.parseStreamChunk({
                type: 'response.reasoning_summary_text.delta',
                output_index: 0,
                item_id: 'rs_timing_1',
                delta: '正在分析'
            }));

            expect(accumulator.getThinkingStartTime()).toBe(1_000);
            expect(accumulator.getThinkingDuration()).toBe(0);

            nowSpy.mockReturnValue(2_600);
            accumulator.add(formatter.parseStreamChunk({
                type: 'response.output_text.delta',
                output_index: 1,
                delta: '最终回答'
            }));

            expect(accumulator.getThinkingDuration()).toBe(1_600);
            expect(accumulator.getFinalContent().thinkingDuration).toBe(1_600);
        } finally {
            nowSpy.mockRestore();
        }
    });

    test('开启「发送思考签名」时 DeepSeek content-only reasoning 按 reasoning_text 回传（不带 encrypted_content/summary）', () => {
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [{
                    text: '先检查工具结果，再决定下一步',
                    thought: true,
                    openaiResponsesReasoning: {
                        id: 'rs_deepseek_1',
                        status: 'completed',
                        content: [{ type: 'reasoning_text', text: '先检查工具结果，再决定下一步' }]
                    }
                }, { text: '继续调用工具。' }]
            },
            { role: 'user', parts: [{ text: 'Continue.' }] }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test',
                name: 'Responses Test',
                preferStream: true,
                sendHistoryThoughts: true,
                sendHistoryThoughtSignatures: true,
                options: {
                    stream: true,
                    reasoning: {
                        effort: 'medium',
                        summaryEnabled: true,
                        summary: 'auto'
                    }
                }
            })
        );

        const reasoningItems = request.body.input.filter((item: any) => item.type === 'reasoning');
        expect(reasoningItems).toHaveLength(1);
        expect(reasoningItems[0]).toEqual({
            type: 'reasoning',
            id: 'rs_deepseek_1',
            status: 'completed',
            content: [{ type: 'reasoning_text', text: '先检查工具结果，再决定下一步' }]
        });
        expect(reasoningItems[0]).not.toHaveProperty('encrypted_content');
        expect(reasoningItems[0]).not.toHaveProperty('summary');
    });

    test('sendHistoryThoughts 开启但签名关闭时 DeepSeek content-only reasoning 仍按 reasoning_text 回传', () => {
        // 回归：DeepSeek 等兼容端点在 thinking mode 下要求历史思考必须按 reasoning_text 原样回传，
        // 否则 400「The reasoning_text in the thinking mode must be passed back to the API」。
        // 签名开关（sendHistoryThoughtSignatures）只控制 encrypted_content 形态，不能一并禁掉
        // content 形态的 reasoning_text 回传。
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [{
                    text: '先检查工具结果，再决定下一步',
                    thought: true,
                    openaiResponsesReasoning: {
                        id: 'rs_deepseek_1',
                        status: 'completed',
                        content: [{ type: 'reasoning_text', text: '先检查工具结果，再决定下一步' }]
                    }
                }, { text: '继续调用工具。' }]
            },
            { role: 'user', parts: [{ text: 'Continue.' }] }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test',
                name: 'Responses Test',
                preferStream: true,
                sendHistoryThoughts: true,
                sendHistoryThoughtSignatures: false,
                options: {
                    stream: true,
                    reasoning: {
                        effort: 'medium',
                        summaryEnabled: true,
                        summary: 'auto'
                    }
                }
            })
        );

        const reasoningItems = request.body.input.filter((item: any) => item.type === 'reasoning');
        // 必须回传 reasoning_text，否则 DeepSeek thinking mode 400
        expect(reasoningItems).toHaveLength(1);
        expect(reasoningItems[0]).toEqual({
            type: 'reasoning',
            id: 'rs_deepseek_1',
            status: 'completed',
            content: [{ type: 'reasoning_text', text: '先检查工具结果，再决定下一步' }]
        });
        expect(reasoningItems[0]).not.toHaveProperty('encrypted_content');
        expect(reasoningItems[0]).not.toHaveProperty('summary');
    });

    test('只剩摘要（无 content 无 encrypted_content）且签名关闭时降级为 assistant 文本', () => {
        // summary-only reasoning item 对官方 API 无效（官方要求 encrypted_content 或 content
        // 才能恢复推理上下文），第三方端点可能 400「输入项类型 'reasoning' 当前暂不支持」；
        // 应降级为可见文本保留信息，不构造无效 reasoning item。
        // 本用例模拟官方 encrypted 形态在 historyFormatting 剥离 thoughtSignatures 后的 part。
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [{
                    text: 'Check the inputs',
                    thought: true,
                    openaiResponsesReasoning: {
                        id: 'rs_1',
                        status: 'completed',
                        summary: [{ type: 'summary_text', text: 'Check the inputs' }]
                    }
                }, { text: 'The answer is 42.' }]
            },
            { role: 'user', parts: [{ text: 'Continue.' }] }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test',
                name: 'Responses Test',
                preferStream: true,
                sendHistoryThoughts: true,
                sendHistoryThoughtSignatures: false,
                options: {
                    stream: true,
                    reasoning: {
                        effort: 'medium',
                        summaryEnabled: true,
                        summary: 'auto'
                    }
                }
            })
        );

        const reasoningItems = request.body.input.filter((item: any) => item.type === 'reasoning');
        const assistantTexts = request.body.input.filter((item: any) => item.type === 'message')
            .flatMap((item: any) => item.content)
            .filter((part: any) => part.type === 'output_text' || part.type === 'input_text')
            .map((part: any) => part.text);
        expect(reasoningItems).toHaveLength(0);
        expect(assistantTexts.join('')).toContain('Check the inputs');
        expect(assistantTexts.join('')).toContain('The answer is 42.');
    });

    test('关闭 sendHistoryThoughts 时 content-only reasoning 降级为 assistant 文本', () => {
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [{
                    text: '先检查工具结果，再决定下一步',
                    thought: true,
                    openaiResponsesReasoning: {
                        id: 'rs_deepseek_1',
                        status: 'completed',
                        content: [{ type: 'reasoning_text', text: '先检查工具结果，再决定下一步' }]
                    }
                }, { text: '继续调用工具。' }]
            },
            { role: 'user', parts: [{ text: 'Continue.' }] }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test',
                name: 'Responses Test',
                preferStream: true,
                sendHistoryThoughts: false,
                sendHistoryThoughtSignatures: false,
                options: {
                    stream: true,
                    reasoning: {
                        effort: 'medium',
                        summaryEnabled: true,
                        summary: 'auto'
                    }
                }
            })
        );

        const reasoningItems = request.body.input.filter((item: any) => item.type === 'reasoning');
        const assistantTexts = request.body.input.filter((item: any) => item.type === 'message')
            .flatMap((item: any) => item.content)
            .filter((part: any) => part.type === 'output_text' || part.type === 'input_text')
            .map((part: any) => part.text);
        expect(reasoningItems).toHaveLength(0);
        expect(assistantTexts.join('')).toContain('先检查工具结果，再决定下一步');
        expect(assistantTexts.join('')).toContain('继续调用工具。');
    });

    test('官方形态同时带 content 且签名关闭时按 reasoning_text 回传（有效形态不受守卫误伤）', () => {
        // 场景 d：part 既有 encrypted_content 又有 content 数组、签名开关关闭时，
        // content 是有效回传形态，不应被 summary-only 守卫误伤。
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [{
                    text: '完整思维链',
                    thought: true,
                    thoughtSignatures: { 'openai-responses': 'ENC_X' },
                    openaiResponsesReasoning: {
                        id: 'rs_mixed_1',
                        status: 'completed',
                        content: [{ type: 'reasoning_text', text: '完整思维链' }]
                    }
                }, { text: '正文。' }]
            },
            { role: 'user', parts: [{ text: 'Continue.' }] }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test', name: 'Responses Test', preferStream: true,
                sendHistoryThoughts: true,
                sendHistoryThoughtSignatures: false
            })
        );
        const reasoningItems = request.body.input.filter((item: any) => item.type === 'reasoning');
        expect(reasoningItems).toHaveLength(1);
        expect(reasoningItems[0].content?.[0]).toEqual({ type: 'reasoning_text', text: '完整思维链' });
        expect(reasoningItems[0]).not.toHaveProperty('encrypted_content');
        expect(reasoningItems[0]).not.toHaveProperty('summary');
    });

    test('裸 thought（无元数据）+ sendHistoryThoughts=true 时按 reasoning_text 包装回传', () => {
        // 场景 e：历史来自其他渠道（gemini/anthropic）的裸 thought 在内容开关开启时
        // 走 hasPlainThought 路径，与 openai 渠道「永远携带 reasoning_content」语义对齐。
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [
                    { text: '来自其他渠道的思考', thought: true },
                    { text: '正文。' }
                ]
            },
            { role: 'user', parts: [{ text: 'Continue.' }] }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test', name: 'Responses Test', preferStream: true,
                sendHistoryThoughts: true,
                sendHistoryThoughtSignatures: false
            })
        );
        const reasoningItems = request.body.input.filter((item: any) => item.type === 'reasoning');
        expect(reasoningItems).toHaveLength(1);
        expect(reasoningItems[0].content?.[0]).toEqual({ type: 'reasoning_text', text: '来自其他渠道的思考' });
    });

    test('裸 thought + sendHistoryThoughts=false 时按旧语义丢弃（不包装）', () => {
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [
                    { text: '来自其他渠道的思考', thought: true },
                    { text: '正文。' }
                ]
            },
            { role: 'user', parts: [{ text: 'Continue.' }] }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test', name: 'Responses Test', preferStream: true,
                sendHistoryThoughts: false,
                sendHistoryThoughtSignatures: false
            })
        );
        const reasoningItems = request.body.input.filter((item: any) => item.type === 'reasoning');
        const assistantTexts = request.body.input.filter((item: any) => item.type === 'message')
            .flatMap((item: any) => item.content)
            .filter((part: any) => part.type === 'output_text' || part.type === 'input_text')
            .map((part: any) => part.text);
        expect(reasoningItems).toHaveLength(0);
        expect(assistantTexts.join('')).toContain('正文。');
        expect(assistantTexts.join('')).not.toContain('来自其他渠道的思考');
    });

    test('id/status + text 的旧流式记录（无 content/summary）按 reasoning_text 兜底回传', () => {
        // 场景 f：仅 id/status + text 的旧记录没有标准数组字段，displayText 兜底分支补全。
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            {
                role: 'model',
                parts: [{
                    text: '旧格式思维链',
                    thought: true,
                    openaiResponsesReasoning: {
                        id: 'rs_legacy_1',
                        status: 'completed'
                    }
                }, { text: '正文。' }]
            },
            { role: 'user', parts: [{ text: 'Continue.' }] }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test', name: 'Responses Test', preferStream: true,
                sendHistoryThoughts: true,
                sendHistoryThoughtSignatures: false
            })
        );
        const reasoningItems = request.body.input.filter((item: any) => item.type === 'reasoning');
        expect(reasoningItems).toHaveLength(1);
        expect(reasoningItems[0].content?.[0]).toEqual({ type: 'reasoning_text', text: '旧格式思维链' });
    });

    test('DeepSeek 空 reasoning item 仅在 reasoning_text 字段内补单空格', () => {
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            { role: 'user', parts: [{ text: '读取文件。' }] },
            {
                role: 'model',
                parts: [
                    {
                        thought: true,
                        openaiResponsesReasoning: {
                            id: 'rs_ds_empty_1',
                            status: 'completed'
                        }
                    },
                    { functionCall: { name: 'read_file', args: { path: 'a.ts' }, id: 'call_empty_1' } }
                ]
            },
            {
                role: 'user',
                parts: [{
                    functionResponse: {
                        id: 'call_empty_1',
                        name: 'read_file',
                        response: { ok: true }
                    }
                }]
            }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test', name: 'Responses Test', model: 'vendor/DeepSeek-V4-Flash',
                sendHistoryThoughts: true,
                sendHistoryThoughtSignatures: false
            })
        );
        const reasoningItems = request.body.input.filter((item: any) => item.type === 'reasoning');

        expect(reasoningItems).toEqual([{
            type: 'reasoning',
            id: 'rs_ds_empty_1',
            status: 'completed',
            content: [{ type: 'reasoning_text', text: ' ' }]
        }]);
    });

    test('DeepSeek assistant 工具调用未返回 reasoning 时补单空格字段', () => {
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            { role: 'user', parts: [{ text: '读取文件。' }] },
            {
                role: 'model',
                parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' }, id: 'call_no_reasoning_1' } }]
            },
            {
                role: 'user',
                parts: [{
                    functionResponse: {
                        id: 'call_no_reasoning_1',
                        name: 'read_file',
                        response: { ok: true }
                    }
                }]
            }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test', name: 'Responses Test', model: 'deepseek-v4-flash',
                sendHistoryThoughts: true,
                sendHistoryThoughtSignatures: false
            })
        );

        const assistantTurnItems = request.body.input.filter((item: any) =>
            item.type === 'reasoning' || item.type === 'function_call'
        );
        expect(assistantTurnItems).toEqual([
            {
                type: 'reasoning',
                content: [{ type: 'reasoning_text', text: ' ' }]
            },
            {
                type: 'function_call',
                name: 'read_file',
                call_id: 'call_no_reasoning_1',
                arguments: '{"path":"a.ts"}'
            }
        ]);
    });

    test('DeepSeek assistant 纯文本未返回 reasoning 时补单空格字段', () => {
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            { role: 'user', parts: [{ text: '直接回答。' }] },
            { role: 'model', parts: [{ text: '这是直接输出的文本。' }] },
            { role: 'user', parts: [{ text: '继续。' }] }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test', name: 'Responses Test', model: 'deepseek-v4-pro',
                sendHistoryThoughts: true,
                sendHistoryThoughtSignatures: false
            })
        );

        const assistantTurnItems = request.body.input.filter((item: any) =>
            item.type === 'reasoning' || (item.type === 'message' && item.role === 'assistant')
        );
        expect(assistantTurnItems).toEqual([
            {
                type: 'reasoning',
                content: [{ type: 'reasoning_text', text: ' ' }]
            },
            {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: '这是直接输出的文本。' }]
            }
        ]);
    });

    test('非 DeepSeek assistant 纯文本缺少 reasoning 时不补字段', () => {
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            { role: 'user', parts: [{ text: '直接回答。' }] },
            { role: 'model', parts: [{ text: '普通模型文本。' }] },
            { role: 'user', parts: [{ text: '继续。' }] }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test', name: 'Responses Test', model: 'gpt-5',
                sendHistoryThoughts: true,
                sendHistoryThoughtSignatures: false
            })
        );

        expect(request.body.input.filter((item: any) => item.type === 'reasoning')).toHaveLength(0);
        expect(request.body.input.filter((item: any) =>
            item.type === 'message' && item.role === 'assistant'
        )).toHaveLength(1);
    });

    test('非 DeepSeek assistant 工具调用缺少 reasoning 时不补字段', () => {
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            { role: 'user', parts: [{ text: '读取文件。' }] },
            {
                role: 'model',
                parts: [
                    { functionCall: { name: 'read_file', args: { path: 'a.ts' }, id: 'call_gpt_1' } }
                ]
            },
            {
                role: 'user',
                parts: [{
                    functionResponse: {
                        id: 'call_gpt_1',
                        name: 'read_file',
                        response: { ok: true }
                    }
                }]
            }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test', name: 'Responses Test', model: 'gpt-5',
                sendHistoryThoughts: true,
                sendHistoryThoughtSignatures: false
            })
        );

        expect(request.body.input.filter((item: any) => item.type === 'reasoning')).toHaveLength(0);
        expect(request.body.input.filter((item: any) => item.type === 'function_call')).toHaveLength(1);
    });

    test('子代理场景：reasoning item 位于 function_call 之前，thinking 不混入普通 assistant 文本', () => {
        // 复现 DeepSeek 带工具的子代理上下文：思考必须在工具调用之前按 reasoning 回传，
        // 且降级路径不得把思维链混入正文。
        const formatter = new OpenAIResponsesFormatter();
        const history: Content[] = [
            { role: 'user', parts: [{ text: '任务：检查测试覆盖率。' }] },
            {
                role: 'model',
                parts: [
                    {
                        text: '我需要先检查文件结构，再确认测试覆盖，最后验证结果。',
                        thought: true,
                        openaiResponsesReasoning: {
                            id: 'rs_ds_subagent_1',
                            status: 'completed',
                            content: [{ type: 'reasoning_text', text: '我需要先检查文件结构，再确认测试覆盖，最后验证结果。' }]
                        }
                    },
                    { functionCall: { name: 'read_file', args: { path: 'a.ts' }, id: 'call_1' } }
                ]
            },
            { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'read_file', response: { ok: true } } }] }
        ];

        const request = formatter.buildRequest(
            { configId: 'responses-test', history },
            createOpenAIResponsesConfig({
                id: 'responses-test', name: 'Responses Test', model: 'deepseek-v4-flash', preferStream: true,
                sendHistoryThoughts: true,
                sendHistoryThoughtSignatures: false
            })
        );
        const reasoningItems = request.body.input.filter((item: any) => item.type === 'reasoning');
        const assistantTexts = request.body.input.filter((item: any) => item.type === 'message')
            .flatMap((item: any) => item.content)
            .filter((part: any) => part.type === 'output_text' || part.type === 'input_text')
            .map((part: any) => part.text);

        // DeepSeek 无状态接口要求带 tools 的请求回传 reasoning_text（否则 400）
        expect(reasoningItems).toHaveLength(1);
        expect(reasoningItems[0].content?.[0]).toEqual({
            type: 'reasoning_text',
            text: '我需要先检查文件结构，再确认测试覆盖，最后验证结果。'
        });
        // thinking 不应出现在普通 assistant 文本里（未被降级污染）
        expect(assistantTexts.join('')).not.toContain('我需要先检查文件结构');
    });
});
