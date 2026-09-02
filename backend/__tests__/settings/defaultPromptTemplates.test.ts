import {
    CODE_MODE_TEMPLATE,
    DEFAULT_DYNAMIC_CONTEXT_TEMPLATE,
    DEFAULT_SYSTEM_PROMPT_CONFIG,
    DEFAULT_SYSTEM_PROMPT_TEMPLATE
} from '../../modules/settings/promptModes';

describe('default prompt templates', () => {
    test('encourages safe multi-call batches and local incidental bug fixes', () => {
        expect(CODE_MODE_TEMPLATE).toContain('emit them together in the same response');
        expect(CODE_MODE_TEMPLATE).toContain('multiple calls to the same tool with different arguments');
        expect(CODE_MODE_TEMPLATE).toContain('separate apply_diff calls for non-overlapping files');
        expect(CODE_MODE_TEMPLATE).toContain('Keep calls sequential when a later call depends on an earlier result');
        expect(CODE_MODE_TEMPLATE).toContain('fix a small bug you encounter while working');
        expect(CODE_MODE_TEMPLATE).toContain('the fix is local and low-risk');
    });

    test('keeps every code-mode default on the shared template', () => {
        expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toBe(CODE_MODE_TEMPLATE);
        expect(DEFAULT_SYSTEM_PROMPT_CONFIG.template).toBe(CODE_MODE_TEMPLATE);
        expect(DEFAULT_SYSTEM_PROMPT_CONFIG.modes.code.template).toBe(CODE_MODE_TEMPLATE);
    });

    test('includes active skills in the backend dynamic-context default', () => {
        expect(DEFAULT_DYNAMIC_CONTEXT_TEMPLATE).toContain('{{$SKILLS}}');
        expect(DEFAULT_SYSTEM_PROMPT_CONFIG.dynamicTemplate).toBe(DEFAULT_DYNAMIC_CONTEXT_TEMPLATE);
        expect(DEFAULT_SYSTEM_PROMPT_CONFIG.modes.code.dynamicTemplate).toBe(DEFAULT_DYNAMIC_CONTEXT_TEMPLATE);
    });
});
