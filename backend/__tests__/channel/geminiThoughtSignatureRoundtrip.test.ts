import { GeminiFormatter, StreamAccumulator } from '../../modules/channel';
import { formatHistoryForAPI } from '../../modules/conversation/manager/historyFormatting';
import type { Content } from '../../modules/conversation/types';
import type { GeminiConfig } from '../../modules/config/types';

const formatter = new GeminiFormatter();
const config = {
    type: 'gemini',
    url: 'http://127.0.0.1:5102/v1beta',
    model: 'gemini-3.8-flash_generateContent',
    apiKey: 'test-key',
    toolMode: 'function_call',
    options: { stream: true, thinkingConfig: { includeThoughts: true, mode: 'default' } },
    optionsEnabled: { thinkingConfig: true }
} as GeminiConfig;

function buildBody(history: Content[]): any {
    return formatter.buildRequest({ configId: 'gemini-test', history }, config).body;
}

describe('Gemini generateContent 思考签名回传', () => {
    test('默认请求携带思考摘要配置', () => {
        expect(buildBody([{ role: 'user', parts: [{ text: '问题' }] }]).generationConfig.thinkingConfig)
            .toEqual({ includeThoughts: true });
    });

    test('流末空文本签名经累积、历史格式化和下一轮请求后仍在原 part', () => {
        const accumulator = new StreamAccumulator('function_call', () => 'test-call');
        accumulator.setProviderType('gemini');
        for (const response of [
            { candidates: [{ content: { parts: [{ text: '让我想想', thought: true }] } }] },
            { candidates: [{ content: { parts: [{ text: '答案' }] } }] },
            { candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'sig-final' }] }, finishReason: 'STOP' }] }
        ]) {
            accumulator.add(formatter.parseStreamChunk(response));
        }

        const model = accumulator.getFinalContent();
        expect(model.parts).toEqual([
            { text: '让我想想', thought: true },
            { text: '答案' },
            { text: '', thoughtSignatures: { gemini: 'sig-final' } }
        ]);

        const history = formatHistoryForAPI([
            { role: 'user', parts: [{ text: '问题' }] },
            model,
            { role: 'user', parts: [{ text: '继续' }] }
        ], { channelType: 'gemini', sendHistoryThoughtSignatures: true });
        expect(history[1].parts).toEqual([
            { text: '答案' },
            { text: '', thoughtSignatures: { gemini: 'sig-final' } }
        ]);
        expect(buildBody(history).contents[1].parts).toEqual([
            { text: '答案' },
            { text: '', thoughtSignature: 'sig-final' }
        ]);
    });

    test('带签名文本与相邻普通文本保持独立，函数调用签名随当前轮次回传', () => {
        const accumulator = new StreamAccumulator('function_call', () => 'test-call');
        accumulator.setProviderType('gemini');
        for (const part of [
            { text: '前段' },
            { text: '带签名段', thoughtSignature: 'sig-text' },
            { text: '后段' }
        ]) {
            accumulator.add(formatter.parseStreamChunk({ candidates: [{ content: { parts: [part] } }] }));
        }
        expect(accumulator.getFinalContent().parts).toEqual([
            { text: '前段' },
            { text: '带签名段', thoughtSignatures: { gemini: 'sig-text' } },
            { text: '后段' }
        ]);

        const model = formatter.parseResponse({
            candidates: [{ content: { role: 'model', parts: [
                { functionCall: { name: 'read_file', args: { path: 'a.txt' } }, thoughtSignature: 'sig-call' }
            ] } }]
        }).content;
        const history = formatHistoryForAPI([
            { role: 'user', parts: [{ text: '读取文件' }] },
            model,
            { role: 'user', isFunctionResponse: true, parts: [
                { functionResponse: { name: 'read_file', response: { content: 'ok' } } }
            ] }
        ], { channelType: 'gemini' });
        expect(buildBody(history).contents[1].parts[0]).toEqual({
            functionCall: { name: 'read_file', args: { path: 'a.txt' } },
            thoughtSignature: 'sig-call'
        });
    });
});
