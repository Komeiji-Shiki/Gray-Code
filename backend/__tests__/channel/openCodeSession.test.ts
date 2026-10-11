
import {
    applyOpenCodeSessionHeader,
    buildOpenCodeSessionId,
    OPENCODE_SESSION_HEADER
} from '../../modules/channel/opencodeSession';
import type { HttpRequestOptions } from '../../modules/channel/types';

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
});
