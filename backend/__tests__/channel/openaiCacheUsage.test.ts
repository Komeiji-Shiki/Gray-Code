import { OpenAIFormatter } from '../../modules/channel/formatters/openai';
import { StreamAccumulator } from '../../modules/channel/StreamAccumulator';

describe('OpenAI 兼容渠道缓存用量', () => {
    const formatter = new OpenAIFormatter();
    test.each([
        ['DeepSeek 原生', { prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36 }, 64],
        ['兼容字段', { prompt_tokens_details: { cached_tokens: 64 } }, 64],
        ['两个字段不重复累加', { prompt_cache_hit_tokens: 64, prompt_tokens_details: { cached_tokens: 64 } }, 64],
        ['明确没有命中', { prompt_cache_hit_tokens: 0 }, 0],
        ['没有返回缓存统计', {}, undefined],
    ])('%s 的流式与非流式结果一致', (_label, details, expected) => {
        const usage = { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112,
            completion_tokens_details: { reasoning_tokens: 10 }, ...details };
        const complete = formatter.parseResponse({ choices: [{ message: { content: '完成' }, finish_reason: 'stop' }], usage }).content.usageMetadata;
        const stream = formatter.parseStreamChunk({ choices: [], usage }).usage;
        expect(stream).toEqual(complete);
        expect(complete?.cacheReadTokenCount).toBe(expected);
        expect(complete?.cachedContentTokenCount).toBe(expected);
        expect(complete?.candidatesTokenCount).toBe(12);
        expect(complete?.totalTokenCount).toBe(112);
    });

    test('后到的汇总帧缺少缓存字段时，保留前一帧明确返回的零', () => {
        const accumulator = new StreamAccumulator('function_call');
        accumulator.setProviderType('openai');
        accumulator.add(formatter.parseStreamChunk({ choices: [], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0 } }));
        accumulator.add(formatter.parseStreamChunk({ choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 } }));
        expect(accumulator.getFinalContent().usageMetadata?.cacheReadTokenCount).toBe(0);
    });
});
