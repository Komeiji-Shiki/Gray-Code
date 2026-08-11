import {
    ContextTrimService,
    PRESERVED_USER_INPUT_MAX_CHARS
} from '../../modules/api/chat/services/ContextTrimService';
import type { Content } from '../../modules/conversation/types';

describe('ContextTrimService preserved user input archive budget', () => {
    test('keeps the complete archive at or below the hard character budget', () => {
        const service = new ContextTrimService({} as any, {} as any, {} as any, {} as any);
        const history: Content[] = Array.from({ length: 20 }, (_, index) => ({
            role: 'user',
            isUserInput: true,
            parts: [{ text: `${index}:` + 'x'.repeat(10_000) }]
        }));

        const preserved = (service as any).createPreservedUserInputsMessage(history, history.length) as Content;
        const text = preserved.parts[0].text!;
        expect(text.length).toBeLessThanOrEqual(PRESERVED_USER_INPUT_MAX_CHARS);
        expect(text).toContain('User input 1');
        expect(text).toContain('User input 20');
        expect(text).toContain('were omitted because the verbatim archive exceeded its safety budget');
    });
});
