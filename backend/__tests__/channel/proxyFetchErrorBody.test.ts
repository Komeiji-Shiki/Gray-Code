/**
 * proxyStreamFetch 非 2xx 错误体处理测试（SEC）。
 *
 * 覆盖：纯文本 / HTML 错误体不再丢失——response.text() 优先读取、再尝试解析 JSON，
 * 上游给出的真实错误正文进入错误信息（修复前 json() 消费响应体后 text() 返回空串）。
 */

import { proxyStreamFetch } from '../../modules/channel';
import { ChannelError, ErrorType } from '../../modules/channel';

async function collectError(gen: AsyncGenerator<string>): Promise<ChannelError> {
    try {
        for await (const _chunk of gen) { /* consume */ }
    } catch (error) {
        return error as ChannelError;
    }
    throw new Error('expected stream to fail, but it completed normally');
}

describe('proxyStreamFetch 非 2xx 错误体（SEC）', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('纯文本错误体（无代理分支）被保留并进入错误信息', async () => {
        const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 502,
            headers: new Map(),
            text: async () => 'Bad Gateway: html error page body',
            json: async () => { throw new Error('not json'); }
        } as any);

        const gen = proxyStreamFetch(
            'https://api.example.com/v1/chat',
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } as any
        );
        const error = await collectError(gen);
        expect(error.type).toBe(ErrorType.API_ERROR);
        expect(String(error.message)).toContain('html error page body');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    test('JSON 错误体仍按 JSON 解析（提取 error.message 字段）', async () => {
        const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: false,
            status: 429,
            headers: new Map(),
            text: async () => JSON.stringify({ error: { message: 'rate limited by upstream' } }),
            json: async () => { throw new Error('unused'); }
        } as any);

        const gen = proxyStreamFetch(
            'https://api.example.com/v1/chat',
            { method: 'POST', headers: {}, body: '{}' } as any
        );
        const error = await collectError(gen);
        expect(error.type).toBe(ErrorType.API_ERROR);
        expect(String(error.message)).toContain('rate limited by upstream');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});
