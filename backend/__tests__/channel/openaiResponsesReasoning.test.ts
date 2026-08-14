import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import { StreamAccumulator } from '../../modules/channel';
import type { Content } from '../../modules/conversation/types';
import { createOpenAIResponsesConfig } from '../__fixtures__/channelFixtures';


describe('OpenAI Responses reasoning 与 usage', () => {
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

    test('sendHistoryThoughts 默认开启但「发送思考签名」关闭时 content-only reasoning 降级为 assistant 文本', () => {
        // 回归：sendHistoryThoughts 默认 true 且 openai-responses 设置 UI 无对应开关（关不掉），
        // 此前仅靠它控制 reasoning item 回传，导致第三方兼容端点报
        // 「输入项类型 'reasoning' 当前暂不支持」。签名开关关闭时必须不回传 reasoning item。
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
        const assistantTexts = request.body.input.filter((item: any) => item.type === 'message')
            .flatMap((item: any) => item.content)
            .filter((part: any) => part.type === 'output_text' || part.type === 'input_text')
            .map((part: any) => part.text);
        expect(reasoningItems).toHaveLength(0);
        expect(assistantTexts.join('')).toContain('先检查工具结果，再决定下一步');
        expect(assistantTexts.join('')).toContain('继续调用工具。');
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
});
