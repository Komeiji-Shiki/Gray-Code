/**
 * 流式响应里内联的上游错误。
 *
 * 各家 provider 都会在 HTTP 200 的 SSE 流里内联错误（Anthropic 的 `event: error`、
 * OpenAI 兼容代理的 `{"error": {...}}`）。formatter 过去只有 Gemini 和 OpenAI Responses
 * 认这类 chunk，OpenAI / Anthropic 直接当成空块跳过：累加器什么也没累加，界面上只剩一句
 * 「模型返回空内容」，而上游其实已经写清了原因。
 */

import { OpenAIFormatter } from '../../modules/channel/formatters/openai';
import { GeminiFormatter } from '../../modules/channel/formatters/gemini';
import { AnthropicFormatter } from '../../modules/channel/formatters/anthropic';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import { extractStreamError } from '../../modules/channel/formatters/streamError';
import { ChannelError, ErrorType } from '../../modules/channel/types';

describe('extractStreamError', () => {
    it('识别 OpenAI 兼容代理的对象错误体', () => {
        expect(extractStreamError({ error: { message: 'Insufficient balance', code: 'insufficient_quota' } }))
            .toEqual({ message: 'Insufficient balance', code: 'insufficient_quota' });
    });

    it('识别 Anthropic 的 event: error 事件（描述在内层）', () => {
        expect(extractStreamError({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
            .toEqual({ message: 'Overloaded', code: 'overloaded_error' });
    });

    it('识别只有字符串的简化错误体', () => {
        expect(extractStreamError({ error: '余额不足' })).toEqual({ message: '余额不足' });
    });

    it('没有 message 时退回 code / type', () => {
        expect(extractStreamError({ error: { code: 429 } })).toEqual({ message: '429', code: '429' });
    });

    it('结构不认识但有内容时原样透出', () => {
        const result = extractStreamError({ error: { reason: 'upstream_down' } });
        expect(result?.message).toContain('upstream_down');
    });

    it('正常 chunk 不被误判', () => {
        expect(extractStreamError({ choices: [{ delta: { content: 'hi' } }] })).toBeUndefined();
        expect(extractStreamError({ error: null })).toBeUndefined();
        expect(extractStreamError({ error: {} })).toBeUndefined();
        expect(extractStreamError({ error: '   ' })).toBeUndefined();
        expect(extractStreamError(undefined)).toBeUndefined();
        expect(extractStreamError('not an object')).toBeUndefined();
    });
});

describe('parseStreamChunk 遇到内联错误时抛出 ChannelError', () => {
    it('OpenAI：错误 chunk 不再被当成空块跳过', () => {
        const formatter = new OpenAIFormatter();
        expect(() => formatter.parseStreamChunk({ error: { message: 'Insufficient balance' } }))
            .toThrow(/Insufficient balance/);

        try {
            formatter.parseStreamChunk({ error: { message: 'Insufficient balance' } });
        } catch (error) {
            expect(error).toBeInstanceOf(ChannelError);
            expect((error as ChannelError).type).toBe(ErrorType.API_ERROR);
        }
    });

    it('Anthropic：event: error 事件带出上游原文', () => {
        const formatter = new AnthropicFormatter();
        expect(() => formatter.parseStreamChunk({
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' }
        })).toThrow(/Overloaded/);
    });

    it('Gemini：保留上游 message 而不只是 code', () => {
        const formatter = new GeminiFormatter();
        expect(() => formatter.parseStreamChunk({
            error: { code: 429, message: 'Resource has been exhausted' }
        })).toThrow(/Resource has been exhausted/);
    });

    it('OpenAI Responses：error 事件与 response.failed 都带出原文', () => {
        const formatter = new OpenAIResponsesFormatter();
        expect(() => formatter.parseStreamChunk({
            type: 'error',
            error: { message: 'Upstream timeout' }
        })).toThrow(/Upstream timeout/);

        expect(() => formatter.parseStreamChunk({
            type: 'response.failed',
            response: { error: { message: 'Model unavailable' } }
        })).toThrow(/Model unavailable/);
    });

    it('非流式：HTTP 200 + 错误体也带出上游原文，而不是报「没有选项/内容/候选结果」', () => {
        expect(() => new OpenAIFormatter().parseResponse({ error: { message: 'Model not found' } }))
            .toThrow(/Model not found/);
        expect(() => new AnthropicFormatter().parseResponse({ type: 'error', error: { message: 'Overloaded' } }))
            .toThrow(/Overloaded/);
        expect(() => new GeminiFormatter().parseResponse({ error: { code: 400, message: 'API key not valid' } }))
            .toThrow(/API key not valid/);
    });

    it('正常 chunk 仍然照常解析', () => {
        expect(new OpenAIFormatter().parseStreamChunk({ choices: [{ delta: { content: 'hi' } }] }).delta)
            .toEqual([{ text: 'hi' }]);
        expect(new AnthropicFormatter().parseStreamChunk({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'hi' }
        }).delta).toEqual([{ text: 'hi' }]);
    });
});
