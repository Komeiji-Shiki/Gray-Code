import { ToolIterationLoopService } from '../../modules/api/chat/services/ToolIterationLoopService';
import type { Content } from '../../modules/conversation/types';
import { serializePromptContextCache } from '../../modules/prompt/promptContextCache';

function createDynamicContextCache(text: string): string {
    return serializePromptContextCache({
        messages: [{ role: 'user', parts: [{ text }] }],
        dynamicSnapshotMessages: [{ role: 'user', parts: [{ text }] }],
        text,
        dynamicSnapshotText: text
    });
}

function createService(updateMessagesBatch = jest.fn()) {
    const conversationManager = { updateMessagesBatch };
    const service = new ToolIterationLoopService(
        {} as any,
        conversationManager as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
    );

    return { service, updateMessagesBatch };
}

describe('ToolIterationLoopService dynamic context preserve anchoring', () => {
    it('marks every cached historical user turn as preserve and updates the current in-memory history snapshot', async () => {
        const { service, updateMessagesBatch } = createService();
        const history: Content[] = [
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: createDynamicContextCache('old ctx 1'),
                turnDynamicContextStrategy: 'single',
                parts: [{ text: 'old user 1' }]
            },
            { role: 'model', parts: [{ text: 'old answer 1' }] },
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: createDynamicContextCache('old ctx 2'),
                parts: [{ text: 'old user 2' }]
            },
            { role: 'model', parts: [{ text: 'old answer 2' }] },
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: createDynamicContextCache('current ctx'),
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'current user' }]
            }
        ];

        await (service as any).preserveHistoricalTurnDynamicContexts('conv-1', history, 4);

        expect(history[0].turnDynamicContextStrategy).toBe('preserve');
        expect(history[2].turnDynamicContextStrategy).toBe('preserve');
        expect(history[4].turnDynamicContextStrategy).toBe('preserve');
        expect(updateMessagesBatch).toHaveBeenCalledWith('conv-1', [
            { messageIndex: 2, updates: { turnDynamicContextStrategy: 'preserve' } },
            { messageIndex: 0, updates: { turnDynamicContextStrategy: 'preserve' } }
        ]);
    });

    it('does not persist anything when historical cached turns are already preserved', async () => {
        const { service, updateMessagesBatch } = createService();
        const history: Content[] = [
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: createDynamicContextCache('old ctx'),
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'old user' }]
            },
            {
                role: 'user',
                isUserInput: true,
                turnDynamicContext: createDynamicContextCache('current ctx'),
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'current user' }]
            }
        ];

        await (service as any).preserveHistoricalTurnDynamicContexts('conv-1', history, 1);

        expect(updateMessagesBatch).not.toHaveBeenCalled();
    });
});
