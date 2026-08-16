/**
 * proxyFetch 模块单元测试。
 *
 * 覆盖 #34 / #35 / #36 / #37 / #38 / #40 修复相关的纯逻辑函数：
 *   - closeSocketGracefully
 *   - parseProxyLeg
 *   - extractUpstreamErrorMessage
 *   - decodeChunkedBuffer
 */

import { EventEmitter } from 'events';
import {
    closeSocketGracefully,
    parseProxyLeg,
    extractUpstreamErrorMessage,
    decodeChunkedBuffer
} from '../../modules/channel';
import * as https from 'https';
import * as http from 'http';

// ---------------------------------------------------------------------------
// closeSocketGracefully
// ---------------------------------------------------------------------------
describe('closeSocketGracefully', () => {
    function mockSocket(overrides: { destroyed?: boolean; writable?: boolean } = {}) {
        const socket = new EventEmitter() as any;
        socket.destroyed = overrides.destroyed ?? false;
        socket.writable = overrides.writable ?? true;
        socket.end = jest.fn();
        socket.destroy = jest.fn(function (this: any) {
            this.destroyed = true;
        });
        return socket;
    }

    test('已销毁的 socket 立即 resolve', async () => {
        const socket = mockSocket({ destroyed: true });
        await expect(closeSocketGracefully(socket)).resolves.toBeUndefined();
        expect(socket.end).not.toHaveBeenCalled();
    });

    test('不可写的 socket 立即 resolve', async () => {
        const socket = mockSocket({ writable: false });
        await expect(closeSocketGracefully(socket)).resolves.toBeUndefined();
        expect(socket.end).not.toHaveBeenCalled();
    });

    test('正常 socket：调用 end() 后等待 close 事件', async () => {
        const socket = mockSocket();
        const promise = closeSocketGracefully(socket);

        // 给一个 tick 让 Promise 启动
        await new Promise(r => setTimeout(r, 5));
        expect(socket.end).toHaveBeenCalledTimes(1);

        socket.emit('close');
        await expect(promise).resolves.toBeUndefined();
    });

    test('超时未 close 则强制 destroy', async () => {
        jest.useFakeTimers();
        const socket = mockSocket();
        const promise = closeSocketGracefully(socket);

        // 推进到超时
        jest.advanceTimersByTime(5000);
        await expect(promise).resolves.toBeUndefined();
        expect(socket.destroy).toHaveBeenCalled();
        expect(socket.destroyed).toBe(true);

        jest.useRealTimers();
    });

    test('close 事件触发后超时定时器被清除（不触发 destroy）', async () => {
        jest.useFakeTimers();
        const socket = mockSocket();
        const promise = closeSocketGracefully(socket);

        socket.emit('close');
        await expect(promise).resolves.toBeUndefined();

        // 即使推进到超时也不应再 destroy
        jest.advanceTimersByTime(5000);
        expect(socket.destroy).not.toHaveBeenCalled();

        jest.useRealTimers();
    });
});

// ---------------------------------------------------------------------------
// parseProxyLeg
// ---------------------------------------------------------------------------
describe('parseProxyLeg', () => {
    test('http:// 代理 → http.request + 默认端口 80', () => {
        const result = parseProxyLeg('http://proxy.example.com');
        expect(result.request).toBe(http.request);
        expect(result.hostname).toBe('proxy.example.com');
        expect(result.port).toBe(80);
        expect(result.proxyAuthHeader).toBeUndefined();
    });

    test('https:// 代理 → https.request + 默认端口 443', () => {
        const result = parseProxyLeg('https://secure-proxy.example.com');
        expect(result.request).toBe(https.request);
        expect(result.hostname).toBe('secure-proxy.example.com');
        expect(result.port).toBe(443);
        expect(result.proxyAuthHeader).toBeUndefined();
    });

    test('自定义端口保留', () => {
        const result = parseProxyLeg('http://proxy.example.com:3128');
        expect(result.port).toBe(3128);
    });

    test('提取用户名/密码生成 Proxy-Authorization Basic 头', () => {
        const result = parseProxyLeg('http://user:pass@proxy.example.com:8080');
        expect(result.proxyAuthHeader).toBe('Basic dXNlcjpwYXNz');
        // dXNlcjpwYXNz == base64("user:pass")
    });

    test('只有用户名没有密码', () => {
        const result = parseProxyLeg('http://user@proxy.example.com');
        // base64("user:") = dXNlcjo=
        expect(result.proxyAuthHeader).toBe('Basic dXNlcjo=');
    });

    test('URL 编码的认证信息被正确解码', () => {
        const result = parseProxyLeg('http://user%40dom:pass%23word@proxy.example.com');
        expect(result.proxyAuthHeader).toBe('Basic dXNlckBkb206cGFzcyN3b3Jk');
        // base64("user@dom:pass#word")
    });

    test('IPv6 代理地址', () => {
        const result = parseProxyLeg('http://[::1]:8080');
        expect(result.hostname).toBe('[::1]');
        expect(result.port).toBe(8080);
    });

    test('不带认证信息的 https:// 自定义端口', () => {
        const result = parseProxyLeg('https://proxy.example.com:8443');
        expect(result.request).toBe(https.request);
        expect(result.port).toBe(8443);
        expect(result.proxyAuthHeader).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// extractUpstreamErrorMessage
// ---------------------------------------------------------------------------
describe('extractUpstreamErrorMessage', () => {
    test('提取 error.message（通用 API 错误格式）', () => {
        expect(extractUpstreamErrorMessage({ error: { message: 'Insufficient quota' } }))
            .toBe('Insufficient quota');
    });

    test('提取 error 为字符串', () => {
        expect(extractUpstreamErrorMessage({ error: 'Internal server error' }))
            .toBe('Internal server error');
    });

    test('提取 message 字段（无 error 包装）', () => {
        expect(extractUpstreamErrorMessage({ message: 'Not found' }))
            .toBe('Not found');
    });

    test('纯文本字符串 body', () => {
        expect(extractUpstreamErrorMessage('Something went wrong'))
            .toBe('Something went wrong');
    });

    test('空白字符串返回 undefined', () => {
        expect(extractUpstreamErrorMessage('   ')).toBeUndefined();
    });

    test('非 object 非 string（如数字）', () => {
        expect(extractUpstreamErrorMessage(42)).toBeUndefined();
    });

    test('null / undefined', () => {
        expect(extractUpstreamErrorMessage(null)).toBeUndefined();
        expect(extractUpstreamErrorMessage(undefined)).toBeUndefined();
    });

    test('空对象', () => {
        expect(extractUpstreamErrorMessage({})).toBeUndefined();
    });

    test('error 为空对象', () => {
        expect(extractUpstreamErrorMessage({ error: {} })).toBeUndefined();
    });

    test('message 仅含空白时 trim 后为空字符串', () => {
        // trim 不会转为 undefined，返回空字符串
        expect(extractUpstreamErrorMessage({ error: { message: '   ' } })).toBe('');
    });

    test('优先取 error.message 而非顶层的 message', () => {
        expect(extractUpstreamErrorMessage({
            message: 'outer',
            error: { message: 'inner' }
        })).toBe('inner');
    });

    test('数组包装：error.errors: [{ message }]', () => {
        expect(extractUpstreamErrorMessage({
            error: { errors: [{ message: 'Quota exceeded', reason: 'RATE_LIMIT' }] }
        })).toBe('Quota exceeded');
    });

    test('数组包装：error 本身是数组', () => {
        expect(extractUpstreamErrorMessage({
            error: [{ message: 'Array wrapped error' }]
        })).toBe('Array wrapped error');
    });

    test('数组包装：顶层 errors: [{ message }]', () => {
        expect(extractUpstreamErrorMessage({
            errors: [{ message: 'Top-level errors array' }]
        })).toBe('Top-level errors array');
    });

    test('数组包装：body 本身是数组', () => {
        expect(extractUpstreamErrorMessage([{ message: 'Body array error' }]))
            .toBe('Body array error');
    });

    test('数组包装：空数组 / error.errors 为空数组返回 undefined', () => {
        expect(extractUpstreamErrorMessage({ error: { errors: [] } })).toBeUndefined();
        expect(extractUpstreamErrorMessage([])).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// decodeChunkedBuffer
// ---------------------------------------------------------------------------
describe('decodeChunkedBuffer', () => {
    function chunked(body: string): Buffer {
        const lines: string[] = [];
        // 每 64 字节一个 chunk
        for (let i = 0; i < body.length; i += 64) {
            const piece = body.substring(i, i + 64);
            lines.push(piece.length.toString(16));
            lines.push(piece);
        }
        lines.push('0');
        lines.push('');
        lines.push('');  // 最后的 \r\n
        return Buffer.from(lines.join('\r\n'), 'utf8');
    }

    test('解码单个 chunk', () => {
        const input = Buffer.from('5\r\nHello\r\n0\r\n\r\n', 'utf8');
        expect(decodeChunkedBuffer(input)).toBe('Hello');
    });

    test('解码多个 chunk', () => {
        const input = Buffer.from('5\r\nHello\r\n6\r\n World\r\n0\r\n\r\n', 'utf8');
        expect(decodeChunkedBuffer(input)).toBe('Hello World');
    });

    test('正确的十六进制解析', () => {
        // 0xA = 10 bytes
        const input = Buffer.from('A\r\n0123456789\r\n0\r\n\r\n', 'utf8');
        expect(decodeChunkedBuffer(input)).toBe('0123456789');
    });

    test('空 body（只有终止块）', () => {
        const input = Buffer.from('0\r\n\r\n', 'utf8');
        expect(decodeChunkedBuffer(input)).toBe('');
    });

    test('包含 Unicode 的 chunked body', () => {
        const body = '你好世界🌍';
        const buf = Buffer.from(body, 'utf8');
        const hex = buf.length.toString(16);
        const input = Buffer.concat([
            Buffer.from(`${hex}\r\n`, 'utf8'),
            buf,
            Buffer.from('\r\n0\r\n\r\n', 'utf8')
        ]);
        expect(decodeChunkedBuffer(input)).toBe(body);
    });

    test('用 chunked 辅助函数生成的较大 body', () => {
        const body = 'The quick brown fox jumps over the lazy dog. '.repeat(20);
        const input = chunked(body);
        expect(decodeChunkedBuffer(input)).toBe(body);
    });

    test('不完整的 chunk（没有终止块）返回已解码部分', () => {
        // 只发了一个 chunk 但没有终止块
        const input = Buffer.from('5\r\nHello\r\n', 'utf8');
        expect(decodeChunkedBuffer(input)).toBe('Hello');
    });

    test('chunk size 为 NaN 时退出循环（pre-existing 行为：break 而非 continue）', () => {
        // 首行 'ZZ' 解析为 NaN → break，后续有效 chunk 也不会被解析
        const input = Buffer.from('ZZ\r\n5\r\nHello\r\n0\r\n\r\n', 'utf8');
        expect(decodeChunkedBuffer(input)).toBe('');
    });

    test('数据不够一个完整 chunk 时停止', () => {
        const input = Buffer.from('F\r\n01234', 'utf8'); // 声称 15 字节但只有 5 字节
        expect(decodeChunkedBuffer(input)).toBe('');
    });
});
