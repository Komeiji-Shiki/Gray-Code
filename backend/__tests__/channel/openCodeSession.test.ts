import { ChannelManager } from '../../modules/channel';
import { createProxyFetch, proxyStreamFetch } from '../../modules/channel/proxyFetch';
import {
    applyOpenCodeSessionHeader,
    buildOpenCodeSessionId,
    OPENCODE_SESSION_HEADER
} from '../../modules/channel/opencodeSession';
import type { HttpRequestOptions } from '../../modules/channel/types';

jest.mock('../../modules/channel/proxyFetch', () => ({
    createProxyFetch: jest.fn(() => jest.fn()),
    proxyStreamFetch: jest.fn()
}));

const mockCreateProxyFetch = createProxyFetch as jest.Mock;
const mockProxyStreamFetch = proxyStreamFetch as jest.Mock;

const BASE_REQUEST = {
    configId: 'opencode-config',
    history: [{ role: 'user' as const, parts: [{ text: 'hello' }] }]
};

function createRequestOptions(headers: Record<string, string> = {}): HttpRequestOptions {
    return {
        url: 'https://api.example.test/v1/chat/completions',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...headers
        },
        body: { model: 'test-model' },
        stream: false
    };
}

function createManager(stream: boolean): ChannelManager {
    const configManager = {
        getConfig: jest.fn().mockResolvedValue({
            id: BASE_REQUEST.configId,
            name: 'OpenCode Go',
            type: 'openai',
            enabled: true,
            openCodeSessionEnabled: true,
            model: 'test-model',
            url: 'https://api.example.test/v1',
            apiKey: 'test-key',
            timeout: 1000,
            options: { stream },
            optionsEnabled: {},
            toolMode: 'function_call',
            retryEnabled: false
        })
    };
    const settingsManager = {
        getEffectiveProxyUrl: jest.fn().mockReturnValue('http://127.0.0.1:7890')
    };
    return new ChannelManager(configManager as any, undefined, settingsManager as any);
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

beforeEach(() => {
    mockCreateProxyFetch.mockReset();
    mockProxyStreamFetch.mockReset();
});

describe('OpenCode Go session header', () => {
    test('builds a stable, privacy-safe UUID for each conversation', () => {
        const first = buildOpenCodeSessionId({ configId: 'cfg-1', conversationId: 'conversation-1' });
        const repeated = buildOpenCodeSessionId({ configId: 'cfg-1', conversationId: 'conversation-1' });
        const other = buildOpenCodeSessionId({ configId: 'cfg-1', conversationId: 'conversation-2' });

        expect(first).toBe(repeated);
        expect(first).not.toBe(other);
        expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(first).not.toContain('conversation-1');
    });

    test('uses a stable channel fallback for unscoped internal requests', () => {
        expect(buildOpenCodeSessionId({ configId: 'cfg-1' }))
            .toBe(buildOpenCodeSessionId({ configId: 'cfg-1' }));
        expect(buildOpenCodeSessionId({ configId: 'cfg-1' }))
            .not.toBe(buildOpenCodeSessionId({ configId: 'cfg-2' }));
    });

    test('is opt-in and replaces a case-insensitive custom duplicate when enabled', () => {
        const requestOptions = createRequestOptions({ 'X-OpenCode-Session': 'manual-value' });

        expect(applyOpenCodeSessionHeader(requestOptions, { configId: 'cfg-1', conversationId: 'c1' }, {
            openCodeSessionEnabled: false
        })).toBe(requestOptions);

        const applied = applyOpenCodeSessionHeader(requestOptions, { configId: 'cfg-1', conversationId: 'c1' }, {
            openCodeSessionEnabled: true
        });
        expect(Object.keys(applied.headers).filter(name => name.toLowerCase() === OPENCODE_SESSION_HEADER)).toEqual([
            OPENCODE_SESSION_HEADER
        ]);
        expect(applied.headers[OPENCODE_SESSION_HEADER]).toBe(buildOpenCodeSessionId({ configId: 'cfg-1', conversationId: 'c1' }));
        expect(requestOptions.headers['X-OpenCode-Session']).toBe('manual-value');
    });

    test('injects the same header on non-stream requests', async () => {
        let sentHeaders: Record<string, string> | undefined;
        const fetchMock = jest.fn(async (_url: string, options: { headers: Record<string, string> }) => {
            sentHeaders = options.headers;
            return {
                status: 200,
                text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
                headers: new Map()
            };
        });
        mockCreateProxyFetch.mockReturnValue(fetchMock);

        const manager = createManager(false);
        await manager.generate({ ...BASE_REQUEST, conversationId: 'conversation-1' });

        expect(sentHeaders?.[OPENCODE_SESSION_HEADER])
            .toBe(buildOpenCodeSessionId({ configId: BASE_REQUEST.configId, conversationId: 'conversation-1' }));
    });

    test('injects the same header on stream requests', async () => {
        let sentHeaders: Record<string, string> | undefined;
        mockProxyStreamFetch.mockImplementation(async function* (
            _url: string,
            options: { headers: Record<string, string> }
        ) {
            sentHeaders = options.headers;
            yield sse({ id: '1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] });
            yield sse({ id: '2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        });

        const manager = createManager(true);
        const stream = await manager.generate({ ...BASE_REQUEST, conversationId: 'conversation-1' });
        for await (const _chunk of stream as AsyncGenerator<unknown>) {
            // Consume the stream so the request is issued.
        }

        expect(sentHeaders?.[OPENCODE_SESSION_HEADER])
            .toBe(buildOpenCodeSessionId({ configId: BASE_REQUEST.configId, conversationId: 'conversation-1' }));
    });
});
