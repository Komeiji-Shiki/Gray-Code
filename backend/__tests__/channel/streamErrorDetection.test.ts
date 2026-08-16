/**
 * 流式响应里内联的上游错误。
 *
 * 各家 provider 都会在 HTTP 200 的 SSE 流里内联错误（Anthropic 的 `event: error`、
 * OpenAI 兼容代理的 `{"error": {...}}`）。formatter 过去只有 Gemini 和 OpenAI Responses
 * 认这类 chunk，OpenAI / Anthropic 直接当成空块跳过：累加器什么也没累加，界面上只剩一句
 * 「模型返回空内容」，而上游其实已经写清了原因。
 */

import { OpenAIFormatter } from '../../modules/channel';
import { GeminiFormatter } from '../../modules/channel';
import { AnthropicFormatter } from '../../modules/channel';
import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import { extractStreamError } from '../../modules/channel/formatters/streamError';
import { ChannelError, ErrorType } from '../../modules/channel';

describe('extractStreamError', () => {
    test('识别 OpenAI 兼容代理的对象错误体', () => {
        expect(extractStreamError({ error: { message: 'Insufficient balance', code: 'insufficient_quota' } }))
            .toEqual({ message: 'Insufficient balance', code: 'insufficient_quota' });
    });

    test('识别 Anthropic 的 event: error 事件（描述在内层）', () => {
        expect(extractStreamError({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
            .toEqual({ message: 'Overloaded', code: 'overloaded_error' });
    });

    test('识别只有字符串的简化错误体', () => {
        expect(extractStreamError({ error: '余额不足' })).toEqual({ message: '余额不足' });
    });

    test('没有 message 时退回 code / type', () => {
        expect(extractStreamError({ error: { code: 429 } })).toEqual({ message: '429', code: '429' });
    });

    test('结构不认识但有内容时原样透出', () => {
        const result = extractStreamError({ error: { reason: 'upstream_down' } });
        expect(result?.message).toContain('upstream_down');
    });

    test('Google 官方 errors 数组包装：error.errors: [{ message }]', () => {
        expect(extractStreamError({ error: { errors: [{ message: 'Quota exceeded', reason: 'RATE_LIMIT' }] } }))
            .toEqual({ message: 'Quota exceeded' });
    });

    test('error 本身是数组包装', () => {
        expect(extractStreamError({ error: [{ message: 'Array wrapped error' }] }))
            .toEqual({ message: 'Array wrapped error' });
    });

    test('type=error 事件内层 errors 数组包装', () => {
        expect(extractStreamError({ type: 'error', error: { errors: [{ message: 'Nested array error' }] } }))
            .toEqual({ message: 'Nested array error' });
    });

    test('chunk 本身是错误数组', () => {
        expect(extractStreamError([{ type: 'error', message: 'Top-level array error' }]))
            .toEqual({ message: 'Top-level array error', code: 'error' });
    });

    test('errors 数组元素只有 reason 时透出原文（不误判为空）', () => {
        const result = extractStreamError({ error: { errors: [{ reason: 'RATE_LIMIT' }] } });
        expect(result?.message).toContain('RATE_LIMIT');
    });

    test('数组包装空数组不误判', () => {
        expect(extractStreamError({ error: { errors: [] } })).toBeUndefined();
        expect(extractStreamError([])).toBeUndefined();
    });

    test('空内层错误不会遮蔽外层 message', () => {
        expect(extractStreamError({
            error: { errors: [] },
            code: 429,
            message: 'Quota exceeded outside'
        })).toEqual({ message: 'Quota exceeded outside', code: '429' });
    });

    test('空内层 message 也不会遮蔽外层说明', () => {
        expect(extractStreamError({
            error: { message: '' },
            status: 'RESOURCE_EXHAUSTED',
            message: 'Outer quota message'
        })).toEqual({ message: 'Outer quota message', code: 'RESOURCE_EXHAUSTED' });
    });

    test('正常 chunk 不被误判', () => {
        expect(extractStreamError({ choices: [{ delta: { content: 'hi' } }] })).toBeUndefined();
        expect(extractStreamError({ error: null })).toBeUndefined();
        expect(extractStreamError({ error: {} })).toBeUndefined();
        expect(extractStreamError({ error: '   ' })).toBeUndefined();
        expect(extractStreamError(undefined)).toBeUndefined();
        expect(extractStreamError('not an object')).toBeUndefined();
        expect(extractStreamError([{ type: 'text', text: 'normal content' }])).toBeUndefined();
        expect(extractStreamError([{ type: 'step', status: 'in_progress' }])).toBeUndefined();
        expect(extractStreamError([{ code: 200, message: 'normal response' }])).toBeUndefined();
    });
});

describe('parseStreamChunk 遇到内联错误时抛出 ChannelError', () => {
    test('OpenAI：错误 chunk 不再被当成空块跳过', () => {
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

    test('Anthropic：event: error 事件带出上游原文', () => {
        const formatter = new AnthropicFormatter();
        expect(() => formatter.parseStreamChunk({
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded' }
        })).toThrow(/Overloaded/);
    });

    test('Gemini：保留上游 message 而不只是 code', () => {
        const formatter = new GeminiFormatter();
        expect(() => formatter.parseStreamChunk({
            error: { code: 429, message: 'Resource has been exhausted' }
        })).toThrow(/Resource has been exhausted/);
    });

    test('Gemini：errors 数组包装错误同样带出原文', () => {
        const formatter = new GeminiFormatter();
        expect(() => formatter.parseStreamChunk({
            error: { errors: [{ message: 'Model quota exceeded' }] }
        })).toThrow(/Model quota exceeded/);
    });

    test('OpenAI Responses：error 事件与 response.failed 都带出原文', () => {
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

    test('非流式：HTTP 200 + 错误体也带出上游原文，而不是报「没有选项/内容/候选结果」', () => {
        expect(() => new OpenAIFormatter().parseResponse({ error: { message: 'Model not found' } }))
            .toThrow(/Model not found/);
        expect(() => new AnthropicFormatter().parseResponse({ type: 'error', error: { message: 'Overloaded' } }))
            .toThrow(/Overloaded/);
        expect(() => new GeminiFormatter().parseResponse({ error: { code: 400, message: 'API key not valid' } }))
            .toThrow(/API key not valid/);
    });

    test('正常 chunk 仍然照常解析', () => {
        expect(new OpenAIFormatter().parseStreamChunk({ choices: [{ delta: { content: 'hi' } }] }).delta)
            .toEqual([{ text: 'hi' }]);
        expect(new AnthropicFormatter().parseStreamChunk({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'hi' }
        }).delta).toEqual([{ text: 'hi' }]);
    });
});
