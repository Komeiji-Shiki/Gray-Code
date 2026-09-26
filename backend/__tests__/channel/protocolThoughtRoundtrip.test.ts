import { AnthropicFormatter, GeminiInteractionsFormatter, StreamAccumulator } from '../../modules/channel';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import { formatHistoryForAPI } from '../../modules/conversation/manager/historyFormatting';
import type { Content } from '../../modules/conversation/types';
import type { GeminiInteractionsConfig } from '../../modules/config/types';
import { createAnthropicConfig, createOpenAIResponsesConfig } from '../__fixtures__/channelFixtures';

function storedHistory(model: Content): Content[] {
    // 经过历史记录使用的 JSON 形态，再走正式历史格式化和下一轮协议构造。
    return JSON.parse(JSON.stringify([
        { role: 'user', isUserInput: true, parts: [{ text: '读取文件' }] },
        model,
        { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id: 'call_1', name: 'read_file', response: { content: 'ok' } } }] }
    ]));
}

describe('无明文推理经过存储和历史格式化后回放', () => {
    test.each(['stream', 'nonstream'])('Responses 无摘要密文保留在工具调用之前：%s', mode => {
        const formatter = new OpenAIResponsesFormatter();
        const reasoning = { type: 'reasoning', id: 'rs_1', status: 'completed', summary: [], encrypted_content: 'encrypted-reasoning' };
        const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' };
        let model: Content;
        if (mode === 'stream') {
            const accumulator = new StreamAccumulator();
            accumulator.setProviderType('openai-responses');
            for (const [output_index, item] of [reasoning, call].entries()) {
                accumulator.add(formatter.parseStreamChunk({ type: 'response.output_item.done', output_index, item }));
            }
            model = accumulator.getFinalContent();
        } else {
            model = formatter.parseResponse({ output: [reasoning, call] }).content;
        }
        const history = formatHistoryForAPI(storedHistory(model), { channelType: 'openai-responses' });
        const body = formatter.buildRequest({ configId: 'test', history }, createOpenAIResponsesConfig({ sendHistoryThoughtSignatures: true })).body;
        expect(body.input.map((item: any) => item.type)).toEqual(['message', 'reasoning', 'function_call', 'function_call_output']);
        expect(body.input[1]).toEqual(reasoning);
        expect(body.input[2].call_id).toBe('call_1');
        expect(body.input[3].call_id).toBe('call_1');
    });

    test('关闭 Responses 历史签名时仍尊重用户配置', () => {
        const formatter = new OpenAIResponsesFormatter();
        const model = formatter.parseResponse({ output: [
            { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted-reasoning' },
            { type: 'message', content: [{ type: 'output_text', text: '答复' }] }
        ] }).content;
        const history = formatHistoryForAPI([
            { role: 'user', isUserInput: true, parts: [{ text: '问题' }] },
            model,
            { role: 'user', isUserInput: true, parts: [{ text: '继续' }] }
        ], { channelType: 'openai-responses', sendHistoryThoughtSignatures: false });
        const body = formatter.buildRequest({ configId: 'test', history }, createOpenAIResponsesConfig({ sendHistoryThoughtSignatures: true })).body;
        expect(body.input.some((item: any) => item.type === 'reasoning')).toBe(false);
    });

    test('Anthropic 明文签名、redacted 与 omitted 思考保持原顺序', () => {
        const formatter = new AnthropicFormatter();
        const originalBlocks = [
            { type: 'thinking', thinking: '第一段', signature: 'sig-first' },
            { type: 'redacted_thinking', data: 'encrypted-thinking' },
            { type: 'thinking', thinking: '', signature: 'sig-omitted' },
            { type: 'thinking', thinking: '第三段', signature: 'sig-third' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }
        ];
        const model = formatter.parseResponse({ content: originalBlocks }).content;
        const history = formatHistoryForAPI(storedHistory(model), { channelType: 'anthropic' });
        const body = formatter.buildRequest({ configId: 'test', history }, createAnthropicConfig()).body;
        expect(body.messages[1].content).toEqual(originalBlocks);
        expect(body.messages[2].content[0].tool_use_id).toBe('call_1');
    });

    test('Gemini Interactions 保留没有摘要的 thought 签名', () => {
        const formatter = new GeminiInteractionsFormatter();
        const model = formatter.parseResponse({ status: 'requires_action', steps: [
            { type: 'thought', signature: 'gemini-sig', summary: [] },
            { type: 'function_call', id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } }
        ] }).content;
        const history = formatHistoryForAPI(storedHistory(model), { channelType: 'gemini-interactions' });
        const config = { type: 'gemini-interactions', url: 'https://example.test/v1beta', model: 'test-model', options: {}, optionsEnabled: {} } as GeminiInteractionsConfig;
        const body = formatter.buildRequest({ configId: 'test', history }, config).body;
        expect(body.input.map((step: any) => step.type)).toEqual(['user_input', 'thought', 'function_call', 'function_result']);
        expect(body.input[1].signature).toBe('gemini-sig');
    });

    test('Gemini generateContent 继续过滤没有 oneof data 的思考空壳', () => {
        const history = formatHistoryForAPI([
            { role: 'user', isUserInput: true, parts: [{ text: '问题' }] },
            { role: 'model', parts: [
                { thought: true, thoughtSignatures: { gemini: 'sig-only' } },
                { redactedThinking: 'anthropic-only' },
                { thought: true, openaiResponsesReasoning: { id: 'rs-other' } },
                { text: '答复' }
            ] }
        ], { channelType: 'gemini' });
        expect(history[1].parts).toEqual([{ text: '答复' }]);
    });

    test.each(['official', 'deepseek'] as const)('关闭明文回传时 DeepSeek 不补空 reasoning：%s', reasoningSignatureMode => {
        const formatter = new OpenAIResponsesFormatter();
        const body = formatter.buildRequest({ configId: 'test', history: [
            { role: 'user', parts: [{ text: '问题' }] },
            { role: 'model', parts: [
                { thought: true, openaiResponsesReasoning: { id: 'rs_empty', status: 'completed' } },
                { text: '答复' }
            ] }
        ] }, createOpenAIResponsesConfig({ model: 'deepseek-test', reasoningSignatureMode, replayReasoningContent: false })).body;
        expect(body.input.some((item: any) => item.type === 'reasoning')).toBe(false);
    });
});
