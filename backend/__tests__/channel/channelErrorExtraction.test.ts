import { extractUpstreamErrorMessage } from '../../modules/channel/channelManager/channelResponseHelpers';

/**
 * channelManager 路径（原生 fetch，无代理）的上游错误提取。
 *
 * 回归场景：该实现此前只认 `error.message` / `error` 字符串 / `message`，
 * 网关（FastAPI/Starlette）报的 `{"detail": "The `reasoning_text` ..."}` 提不出来，
 * 客户端只能看到通用的 `HTTP 400`，上游给出的真实原因被丢掉。
 * 流式路径（formatters/streamError.ts）早就支持 detail，两条口径必须一致。
 */
describe('extractUpstreamErrorMessage（channelManager 路径）', () => {
    test('FastAPI/Starlette 的 detail 字符串', () => {
        expect(extractUpstreamErrorMessage({
            detail: 'The `reasoning_text` in the thinking mode must be passed back to the API.'
        })).toBe('The `reasoning_text` in the thinking mode must be passed back to the API.');
    });

    test('detail 为对象时递归提取内层 message', () => {
        expect(extractUpstreamErrorMessage({
            detail: { message: 'Invalid request payload' }
        })).toBe('Invalid request payload');
    });

    test('detail 为数组时递归提取首条可读信息', () => {
        expect(extractUpstreamErrorMessage({
            detail: [{ loc: ['body', 'input'], msg: 'field required' }]
        })).toBe('field required');
    });

    test('detail 为空字符串时回退到其它字段', () => {
        expect(extractUpstreamErrorMessage({ detail: '   ', message: 'upstream busy' }))
            .toBe('upstream busy');
    });

    test('保底行为不变：error.message 优先于顶层 message', () => {
        expect(extractUpstreamErrorMessage({
            message: 'outer',
            error: { message: 'inner' }
        })).toBe('inner');
    });

    test('errors 数组包装仍可提取', () => {
        expect(extractUpstreamErrorMessage({
            error: { errors: [{ message: 'Quota exceeded', reason: 'RATE_LIMIT' }] }
        })).toBe('Quota exceeded');
    });

    test('body 本身是数组时逐个尝试', () => {
        expect(extractUpstreamErrorMessage([{ message: 'Body array error' }]))
            .toBe('Body array error');
    });

    test('结构未知但带内容时原样透出，不再只留状态码', () => {
        expect(extractUpstreamErrorMessage({ code: 'invalid_request_error', param: 'input[1].content' }))
            .toBe('{"code":"invalid_request_error","param":"input[1].content"}');
    });

    test('空壳错误体仍返回 undefined，交由通用文案兜底', () => {
        expect(extractUpstreamErrorMessage({})).toBeUndefined();
        expect(extractUpstreamErrorMessage({ error: {} })).toBeUndefined();
        expect(extractUpstreamErrorMessage({ error: { errors: [] } })).toBeUndefined();
        expect(extractUpstreamErrorMessage(null)).toBeUndefined();
        expect(extractUpstreamErrorMessage(undefined)).toBeUndefined();
    });

    test('纯文本字符串 body', () => {
        expect(extractUpstreamErrorMessage('Something went wrong')).toBe('Something went wrong');
        expect(extractUpstreamErrorMessage('   ')).toBeUndefined();
    });
});
