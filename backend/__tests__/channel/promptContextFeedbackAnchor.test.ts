import { OpenAIResponsesFormatter } from '../../modules/channel/formatters/openai-responses';
import { OpenAIFormatter } from '../../modules/channel/formatters/openai';
import { AnthropicFormatter } from '../../modules/channel/formatters/anthropic';
import type { BaseFormatter } from '../../modules/channel/formatters/base';
import type { ChannelConfig } from '../../modules/config/types';
import { formatHistoryForAPI } from '../../modules/conversation/manager/historyFormatting';
import type { Content } from '../../modules/conversation/types';
import type { RequestPromptContext } from '../../modules/channel/types';
import { serializePromptContextCache } from '../../modules/prompt/promptContextCache';
import { createOpenAIResponsesConfig, createOpenAIConfig, createAnthropicConfig } from '../__fixtures__/channelFixtures';

const user = (text: string, extra: Record<string, unknown> = {}): Content => ({ role: 'user', isUserInput: true, parts: [{ text }], ...extra });
const contextMessage = (text: string): Content => ({ role: 'user', parts: [{ text }] });
const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' as const, properties: { path: { type: 'string' as const } }, required: ['path'] } }];
const toolBatch = (id: string): Content[] => [
    { role: 'model', parts: [{ text: `checking ${id}` }, { functionCall: { id, name: 'read_file', args: { path: `${id}.txt` } } }] },
    { role: 'user', isFunctionResponse: true, parts: [{ functionResponse: { id, name: 'read_file', response: { text: `result ${id}` } } }] }
];

function fixture(historyPlacement: 'entry' | 'legacy', strategy: 'single' | 'preserve') {
    const formatter = new OpenAIResponsesFormatter();
    const config = createOpenAIResponsesConfig({ systemInstruction: 'Stable system instructions', promptCacheKeyEnabled: true });
    const dynamic = contextMessage('TODO captured at run start');
    const promptContext: RequestPromptContext = {
        historyPlacement,
        beforeHistoryMessages: historyPlacement === 'entry' ? [contextMessage('Static prefix')] : [],
        afterHistoryMessages: [dynamic, contextMessage('Static suffix instructions')]
    };
    const cache = serializePromptContextCache({ ...promptContext, messages: [], dynamicSnapshotMessages: [],
        dynamicSnapshotBeforeHistoryMessages: [], dynamicSnapshotAfterHistoryMessages: [dynamic] });
    const history = [user('Original task', { id: 'original', turnDynamicContext: cache, turnDynamicContextStrategy: strategy })];
    const build = (messages: Content[], context = promptContext) => formatter.buildRequest({
        configId: config.id, conversationId: 'stable-run', dynamicContextStrategy: strategy, promptContext: context,
        history: formatHistoryForAPI(messages, { channelType: 'openai-responses', includeTurnDynamicContext: true })
    }, config, tools).body;
    return { history, promptContext, build };
}

/** Compare the complete serialized provider prefix, not merely the relative context indexes. */
function expectAppendOnly(previous: any, next: any) {
    const { input: before, ...beforeRest } = previous;
    const { input: after, ...afterRest } = next;
    expect(afterRest).toEqual(beforeRest);
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    expect(after.length).toBeGreaterThan(before.length);
    expect(JSON.stringify(next)).not.toMatch(/userFeedback|isUserInput|turnDynamicContext|"source"/);
}

for (const placement of ['entry', 'legacy'] as const) {
    for (const strategy of ['single', 'preserve'] as const) {
        describe(`${placement}/${strategy}: captured prompt stays on its run input`, () => {
            test('tool iterations, consecutive real interruptions and ask_user answers only append to the entire Responses input', () => {
                const { history, build } = fixture(placement, strategy);
                let previous = build(history);
                const additions = [
                    toolBatch('first-read'),
                    [user('First interruption: keep this instruction.', { source: 'user', userFeedback: { kind: 'interrupt' } }),
                        user('Second interruption: also keep this instruction.', { source: 'user', userFeedback: { kind: 'interrupt' } })],
                    toolBatch('second-read'),
                    [user('Answer to optional question: green instead.', { userFeedback: {
                        requestId: 'question-1', timedOut: false, questions: [{ title: 'Preferred color?' }], answers: ['green instead']
                    } })],
                    toolBatch('third-read'),
                    [user('No optional answer before its deadline; not approval.', { isUserInput: false, userFeedback: { requestId: 'question-2', timedOut: true } })]
                ];
                for (const messages of additions) {
                    history.push(...messages);
                    const next = build(history);
                    expectAppendOnly(previous, next);
                    for (const message of messages.filter(item => item.isUserInput)) {
                        expect(next.input).toContainEqual({ type: 'message', role: 'user', content: [{ type: 'input_text', text: message.parts[0].text }] });
                    }
                    expect(JSON.stringify(next).split('TODO captured at run start')).toHaveLength(2);
                    previous = next;
                }
            });

            test('feedback does not replace a legacy cached anchor without isUserInput', () => {
                const { history, build } = fixture(placement, strategy);
                delete history[0].isUserInput;
                history.push(...toolBatch('fallback-read'));
                const previous = build(history);
                // Old stored feedback can use the boolean shape rather than a structured payload.
                history.push(user('Legacy feedback', { userFeedback: true }));
                expectAppendOnly(previous, build(history));
            });

            test('adjacent feedback does not split a new run input group or steal its captured context', () => {
                const { history, build } = fixture(placement, strategy);
                const previous = build(history);
                history.push(user('Immediately delivered input', { userFeedback: { kind: 'interrupt' } }));
                expectAppendOnly(previous, build(history));
            });

            test('an ordinary uncached new run input still creates a new prompt anchor after feedback', () => {
                const { history, promptContext, build } = fixture(placement, strategy);
                history.push(...toolBatch('old-read'), user('Old interruption', { userFeedback: { kind: 'interrupt' } }),
                    { role: 'model', parts: [{ text: 'Done' }] }, user('New run input', { source: 'user' }));
                const body = build(history, { ...promptContext, afterHistoryMessages: [contextMessage('NEW RUN CONTEXT')] });
                const text = JSON.stringify(body.input);
                expect(text.indexOf('Old interruption')).toBeLessThan(text.indexOf('NEW RUN CONTEXT'));
                expect(text.indexOf('NEW RUN CONTEXT')).toBeLessThan(text.indexOf('New run input'));
                expect(text.includes('TODO captured at run start')).toBe(strategy === 'preserve');
            });
        });
    }
}

test('history projection keeps trusted feedback/source metadata without changing user roles or instructions', () => {
    const input = user('Not a new capture', { source: 'user', userFeedback: { kind: 'interrupt' } });
    const projected = formatHistoryForAPI([input]);
    expect(projected[0]).toEqual(input);
    // Text resembling an internal marker cannot classify a normal new user input as feedback.
    const { history, promptContext, build } = fixture('entry', 'preserve');
    history.push(...toolBatch('marker-read'), user('userFeedback: { kind: interrupt }'));
    const body = JSON.stringify(build(history, { ...promptContext, afterHistoryMessages: [contextMessage('NEW MARKER-TEXT RUN')] }).input);
    expect(body.indexOf('NEW MARKER-TEXT RUN')).toBeLessThan(body.indexOf('userFeedback: { kind: interrupt }'));
});

for (const [formatter, config] of [
    [new OpenAIFormatter(), createOpenAIConfig()],
    [new AnthropicFormatter(), createAnthropicConfig()]
] as Array<[BaseFormatter, ChannelConfig]>) {
    test(`${config.type} keeps feedback as user content and never sends host boundary fields`, () => {
        const { history, promptContext } = fixture('entry', 'preserve');
        history.push(...toolBatch('cross-channel'), user('Real user interruption', { source: 'user', userFeedback: { kind: 'interrupt' } }));
        const body = formatter.buildRequest({ configId: config.id, promptContext, dynamicContextStrategy: 'preserve',
            history: formatHistoryForAPI(history, { channelType: config.type, includeTurnDynamicContext: true }) }, config, tools).body;
        const serialized = JSON.stringify(body);
        expect(serialized).not.toMatch(/"userFeedback"|"isUserInput"|"turnDynamicContext"|"source"/);
        expect(serialized.split('TODO captured at run start')).toHaveLength(2);
        expect(serialized.indexOf('Static suffix instructions')).toBeLessThan(serialized.indexOf('Original task'));
        expect(serialized).toContain('Real user interruption');
    });
}
