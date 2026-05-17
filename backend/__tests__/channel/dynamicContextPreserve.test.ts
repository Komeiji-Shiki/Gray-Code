import type { Content } from '../../modules/conversation/types';
import { BaseFormatter } from '../../modules/channel/formatters/base';
import type { ChannelConfig } from '../../modules/config/types';
import type { ToolDeclaration } from '../../tools/types';
import type { GenerateRequest, GenerateResponse, HttpRequestOptions, RequestPromptContext, StreamChunk } from '../../modules/channel/types';
import { serializePromptContextCache } from '../../modules/prompt/promptContextCache';

class TestFormatter extends BaseFormatter {
    exposeInject(history: Content[], messages?: Content[], strategy: 'single' | 'preserve' = 'single'): Content[] {
        return this.injectDynamicContextMessages(history, messages, strategy);
    }

    exposeInjectPromptContext(history: Content[], promptContext?: RequestPromptContext, strategy: 'single' | 'preserve' = 'single'): Content[] {
        return this.injectPromptContextMessages(history, promptContext, strategy);
    }

    buildRequest(_request: GenerateRequest, _config: ChannelConfig, _tools?: ToolDeclaration[]): HttpRequestOptions {
        throw new Error('not used');
    }

    parseResponse(_response: any): GenerateResponse {
        throw new Error('not used');
    }

    parseStreamChunk(_chunk: any): StreamChunk {
        throw new Error('not used');
    }

    validateConfig(_config: ChannelConfig): boolean {
        return true;
    }

    getSupportedType(): string {
        return 'test';
    }

    convertTools(_tools: ToolDeclaration[]): any {
        return [];
    }
}

function textOf(message: Content): string {
    return message.parts?.map(part => part.text || '').join('') || '';
}

describe('BaseFormatter dynamic context insertion', () => {
    it('inserts multi-role current context before the current user turn in legacy single mode', () => {
        const formatter = new TestFormatter();
        const history: Content[] = [
            { role: 'user', isUserInput: true, parts: [{ text: 'hello' }] }
        ];
        const contextMessages: Content[] = [
            { role: 'user', parts: [{ text: 'ctx user' }] },
            { role: 'model', parts: [{ text: 'ctx assistant' }] }
        ];

        const result = formatter.exposeInject(history, contextMessages, 'single');

        expect(result.map(textOf)).toEqual(['ctx user', 'ctx assistant', 'hello']);
        expect(result.map(message => message.role)).toEqual(['user', 'model', 'user']);
    });

    it('places entry-mode prompt context around real history in single mode', () => {
        const formatter = new TestFormatter();
        const history: Content[] = [
            { role: 'user', isUserInput: true, parts: [{ text: 'current user' }] }
        ];

        const result = formatter.exposeInjectPromptContext(history, {
            beforeHistoryMessages: [
                { role: 'user', parts: [{ text: 'before user' }] },
                { role: 'model', parts: [{ text: 'before assistant' }] }
            ],
            afterHistoryMessages: [
                { role: 'user', parts: [{ text: 'after user' }] }
            ],
            historyPlacement: 'entry'
        });

        expect(result.map(textOf)).toEqual(['before user', 'before assistant', 'after user', 'current user']);
        expect(result.map(message => message.role)).toEqual(['user', 'model', 'user', 'user']);
    });

    it('keeps legacy dynamic context anchored to the original user turn after tool responses', () => {
        const formatter = new TestFormatter();
        const currentCache = serializePromptContextCache({
            messages: [
                { role: 'user', parts: [{ text: 'cached current ctx' }] }
            ],
            dynamicSnapshotMessages: [
                { role: 'user', parts: [{ text: 'cached current ctx' }] }
            ],
            text: 'cached current ctx',
            dynamicSnapshotText: 'cached current ctx'
        });
        const history: Content[] = [
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: currentCache,
                turnDynamicContextStrategy: 'single',
                parts: [{ text: 'current user' }]
            },
            { role: 'model', parts: [{ text: 'tool call' }] },
            {
                role: 'user',
                isFunctionResponse: true,
                parts: [{ text: 'tool result' }]
            }
        ];

        const result = formatter.exposeInject(
            history,
            [{ role: 'user', parts: [{ text: 'current ctx' }] }],
            'single'
        );

        expect(result.map(textOf)).toEqual(['current ctx', 'current user', 'tool call', 'tool result']);
    });

    it('keeps entry-mode after-history context next to the original user turn after tool responses', () => {
        const formatter = new TestFormatter();
        const currentCache = serializePromptContextCache({
            beforeHistoryMessages: [{ role: 'user', parts: [{ text: 'cached before' }] }],
            afterHistoryMessages: [{ role: 'user', parts: [{ text: 'cached after' }] }],
            dynamicSnapshotBeforeHistoryMessages: [],
            dynamicSnapshotAfterHistoryMessages: [{ role: 'user', parts: [{ text: 'cached after' }] }],
            messages: [],
            dynamicSnapshotMessages: [],
            text: 'cached before\n\ncached after',
            dynamicSnapshotText: 'cached after',
            historyPlacement: 'entry'
        });
        const history: Content[] = [
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: currentCache,
                turnDynamicContextStrategy: 'single',
                parts: [{ text: 'current user' }]
            },
            { role: 'model', parts: [{ text: 'tool call' }] },
            {
                role: 'user',
                isFunctionResponse: true,
                parts: [{ text: 'tool result' }]
            }
        ];

        const result = formatter.exposeInjectPromptContext(history, {
            beforeHistoryMessages: [{ role: 'user', parts: [{ text: 'before' }] }],
            afterHistoryMessages: [{ role: 'user', parts: [{ text: 'after' }] }],
            historyPlacement: 'entry'
        });

        expect(result.map(textOf)).toEqual(['before', 'after', 'current user', 'tool call', 'tool result']);
    });

    it('preserves old dynamic snapshots and wraps preserved history with current entry-mode context', () => {
        const formatter = new TestFormatter();
        const oldCache = serializePromptContextCache({
            beforeHistoryMessages: [
                { role: 'user', parts: [{ text: 'old full before' }] }
            ],
            afterHistoryMessages: [
                { role: 'model', parts: [{ text: 'old full after' }] }
            ],
            dynamicSnapshotBeforeHistoryMessages: [
                { role: 'user', parts: [{ text: 'old dynamic before' }] }
            ],
            dynamicSnapshotAfterHistoryMessages: [
                { role: 'model', parts: [{ text: 'old dynamic after' }] }
            ],
            messages: [],
            dynamicSnapshotMessages: [],
            text: 'old full before\n\nold full after',
            dynamicSnapshotText: 'old dynamic before\n\nold dynamic after',
            historyPlacement: 'entry'
        });
        const currentCache = serializePromptContextCache({
            messages: [
                { role: 'user', parts: [{ text: 'current cached full ctx' }] }
            ],
            dynamicSnapshotMessages: [
                { role: 'user', parts: [{ text: 'current cached dynamic snapshot' }] }
            ],
            text: 'current cached full ctx',
            dynamicSnapshotText: 'current cached dynamic snapshot'
        });
        const history: Content[] = [
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: oldCache,
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'old user' }]
            },
            { role: 'model', parts: [{ text: 'old answer' }] },
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: currentCache,
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'current user' }]
            }
        ];

        const result = formatter.exposeInjectPromptContext(
            history,
            {
                beforeHistoryMessages: [
                    { role: 'user', parts: [{ text: 'current before' }] },
                    { role: 'model', parts: [{ text: 'current assistant prelude' }] }
                ],
                afterHistoryMessages: [
                    { role: 'user', parts: [{ text: 'current after' }] }
                ],
                historyPlacement: 'entry'
            },
            'preserve'
        );

        expect(result.map(textOf)).toEqual([
            'current before',
            'current assistant prelude',
            'old dynamic before',
            'old dynamic after',
            'old user',
            'old answer',
            'current after',
            'current user',
        ]);
    });

    it('preserves historical cached contexts even when old turns have not been explicitly marked preserve', () => {
        const formatter = new TestFormatter();
        const oldCache = serializePromptContextCache({
            messages: [
                { role: 'user', parts: [{ text: 'old cached full ctx' }] }
            ],
            dynamicSnapshotMessages: [
                { role: 'user', parts: [{ text: 'old cached dynamic ctx' }] }
            ],
            text: 'old cached full ctx',
            dynamicSnapshotText: 'old cached dynamic ctx'
        });
        const currentCache = serializePromptContextCache({
            messages: [
                { role: 'user', parts: [{ text: 'current cached full ctx' }] }
            ],
            dynamicSnapshotMessages: [
                { role: 'user', parts: [{ text: 'current cached dynamic ctx' }] }
            ],
            text: 'current cached full ctx',
            dynamicSnapshotText: 'current cached dynamic ctx'
        });
        const history: Content[] = [
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: oldCache,
                parts: [{ text: 'old user' }]
            },
            { role: 'model', parts: [{ text: 'old answer' }] },
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: currentCache,
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'current user' }]
            }
        ];

        const result = formatter.exposeInject(history, [{ role: 'user', parts: [{ text: 'current ctx' }] }], 'preserve');

        expect(result.map(textOf)).toEqual(['old cached dynamic ctx', 'old user', 'old answer', 'current ctx', 'current user']);
    });

    it('preserves cached old context when the newly sent user turn has not been cached yet', () => {
        const formatter = new TestFormatter();
        const oldCache = serializePromptContextCache({
            messages: [
                { role: 'user', parts: [{ text: 'old cached full ctx' }] }
            ],
            dynamicSnapshotMessages: [
                { role: 'user', parts: [{ text: 'old cached dynamic ctx' }] }
            ],
            text: 'old cached full ctx',
            dynamicSnapshotText: 'old cached dynamic ctx'
        });
        const history: Content[] = [
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: oldCache,
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'old user' }]
            },
            { role: 'model', parts: [{ text: 'old answer' }] },
            { role: 'user', isUserInput: true, parts: [{ text: 'current user' }] }
        ];

        const result = formatter.exposeInject(history, [{ role: 'user', parts: [{ text: 'current ctx' }] }], 'preserve');

        expect(result.map(textOf)).toEqual(['old cached dynamic ctx', 'old user', 'old answer', 'current ctx', 'current user']);
    });

    it('keeps legacy plain-text turnDynamicContext compatible in preserve mode', () => {
        const formatter = new TestFormatter();
        const history: Content[] = [
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: 'legacy ctx',
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'old user' }]
            },
            { role: 'model', parts: [{ text: 'old answer' }] },
            { role: 'user', isUserInput: true, parts: [{ text: 'current user' }] }
        ];

        const result = formatter.exposeInject(
            history,
            [{ role: 'user', parts: [{ text: 'current ctx' }] }],
            'preserve'
        );

        expect(result.map(textOf)).toEqual(['legacy ctx', 'old user', 'old answer', 'current ctx', 'current user']);
    });
});
