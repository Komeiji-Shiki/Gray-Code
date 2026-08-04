/**
 * 流式响应缓冲区解析。
 *
 * 重点是 unparsed：上游并不总按约定格式回（网关的 502 HTML、代理的纯文本错误），
 * 这些内容过去在缓冲区里被静默丢弃，调用方只能报一句「没有响应体」，
 * 到了界面上就成了和真实原因毫无关系的「模型返回空内容」。
 */

import { parseStreamBuffer } from '../../modules/channel/streamBufferParser';

describe('parseStreamBuffer - SSE', () => {
    it('解析连续的 data 行', () => {
        const result = parseStreamBuffer('data: {"a":1}\n\ndata: {"a":2}\n\n');
        expect(result.chunks).toEqual([{ a: 1 }, { a: 2 }]);
        expect(result.remaining).toBe('');
    });

    it('跳过 [DONE] 与事件名行', () => {
        const result = parseStreamBuffer('event: message\ndata: {"a":1}\n\ndata: [DONE]\n\n');
        expect(result.chunks).toEqual([{ a: 1 }]);
    });

    it('识别 Anthropic 的 event: error 事件体', () => {
        const result = parseStreamBuffer('event: error\ndata: {"type":"error","error":{"message":"Overloaded"}}\n\n');
        expect(result.chunks).toEqual([{ type: 'error', error: { message: 'Overloaded' } }]);
    });

    it('未收完的 data 行保留为 remaining 等待后续数据', () => {
        const result = parseStreamBuffer('data: {"a":');
        expect(result.chunks).toEqual([]);
        expect(result.remaining).toBe('data: {"a":');
        expect(result.unparsed).toBeUndefined();
    });

    it('流结束仍解析不了的 data 内容转为 unparsed 而非丢弃', () => {
        const result = parseStreamBuffer('data: upstream gateway timeout', true);
        expect(result.chunks).toEqual([]);
        expect(result.remaining).toBe('');
        expect(result.unparsed).toBe('upstream gateway timeout');
    });
});

describe('parseStreamBuffer - SSE keep-alive 心跳', () => {
    it('非 JSON 心跳行不污染后续真实事件', () => {
        const result = parseStreamBuffer('data: keep_alive\ndata: {"a":1}\ndata: keep-alive\ndata: {"a":2}\n\n');
        expect(result.chunks).toEqual([{ a: 1 }, { a: 2 }]);
        expect(result.remaining).toBe('');
    });

    it('纯心跳流在流结束时直接丢弃，不进入 unparsed（避免误报错误）', () => {
        const result = parseStreamBuffer('data: keep_alive', true);
        expect(result.chunks).toEqual([]);
        expect(result.remaining).toBe('');
        expect(result.unparsed).toBeUndefined();
    });

    it('多种心跳形态（ping/heartbeat/keepalive）均被容忍', () => {
        const result = parseStreamBuffer(
            'data: ping\ndata: heartbeat\ndata: keepalive\ndata: {"a":1}',
            true
        );
        expect(result.chunks).toEqual([{ a: 1 }]);
    });

    it('心跳出现在流中间时不中断其后事件解析（长思考场景回归）', () => {
        const result = parseStreamBuffer(
            'data: {"type":"content_block_delta"}\ndata: keep_alive\n\ndata: keep_alive\n\ndata: {"type":"message_stop"}'
        );
        expect(result.chunks).toEqual([
            { type: 'content_block_delta' },
            { type: 'message_stop' }
        ]);
    });

    it('未收完的 JSON 前缀仍按多行事件累积（不被心跳规则误伤）', () => {
        const result = parseStreamBuffer('data: {"a":\ndata: 1}');
        expect(result.chunks).toEqual([{ a: 1 }]);
    });
});

describe('parseStreamBuffer - JSON 行', () => {
    it('逐行解析 JSON 对象', () => {
        const result = parseStreamBuffer('{"a":1}\n{"a":2}\n');
        expect(result.chunks).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it('未收完的末行在流未结束时保留为 remaining', () => {
        const result = parseStreamBuffer('{"a":1}\n{"a":');
        expect(result.chunks).toEqual([{ a: 1 }]);
        expect(result.remaining).toBe('{"a":');
        expect(result.unparsed).toBeUndefined();
    });

    it('流结束后解析不了的行进入 unparsed', () => {
        const result = parseStreamBuffer('{"a":1}\n{broken', true);
        expect(result.chunks).toEqual([{ a: 1 }]);
        expect(result.unparsed).toBe('{broken');
    });
});

describe('parseStreamBuffer - 非约定格式', () => {
    it('整体是一个 JSON 错误体时照常解析（HTTP 200 + 错误体）', () => {
        const result = parseStreamBuffer('{"error":{"message":"Insufficient balance"}}', true);
        expect(result.chunks).toEqual([{ error: { message: 'Insufficient balance' } }]);
    });

    it('纯文本 / HTML 报错在流结束时原样带出，不再被静默丢弃', () => {
        const html = '<html><body><h1>502 Bad Gateway</h1></body></html>';
        const result = parseStreamBuffer(html, true);
        expect(result.chunks).toEqual([]);
        expect(result.remaining).toBe('');
        expect(result.unparsed).toBe(html);
    });

    it('流未结束时纯文本仍留作 remaining 等待更多数据', () => {
        const result = parseStreamBuffer('Internal Server');
        expect(result.chunks).toEqual([]);
        expect(result.remaining).toBe('Internal Server');
        expect(result.unparsed).toBeUndefined();
    });
});
