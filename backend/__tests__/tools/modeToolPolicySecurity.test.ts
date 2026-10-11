import { MEMORY_TOOL_NAMES } from '../../modules/memory/types';
import { DESIGN_PROMPT_MODE, PLAN_PROMPT_MODE, REVIEW_PROMPT_MODE, ASK_PROMPT_MODE } from '../../modules/settings/promptModes';

describe('plan/design/review 模式记忆指令', () => {
    test('design 模式 toolPolicy 包含全部记忆工具', () => {
        for (const name of MEMORY_TOOL_NAMES) {
            expect(DESIGN_PROMPT_MODE.toolPolicy).toContain(name);
        }
    });

    test('plan 模式 toolPolicy 包含全部记忆工具', () => {
        for (const name of MEMORY_TOOL_NAMES) {
            expect(PLAN_PROMPT_MODE.toolPolicy).toContain(name);
        }
    });

    test('review 模式 toolPolicy 包含全部记忆工具', () => {
        for (const name of MEMORY_TOOL_NAMES) {
            expect(REVIEW_PROMPT_MODE.toolPolicy).toContain(name);
        }
    });

    test('ask 模式保持只读定位：不包含记忆写工具', () => {
        // ask 是纯问答模式，未被授予记忆指令（用户仅要求 plan/design/review）
        for (const name of MEMORY_TOOL_NAMES) expect(ASK_PROMPT_MODE.toolPolicy).not.toContain(name);
    });

    test('内置模式仍包含 search_in_files 搜索能力', () => {
        expect(DESIGN_PROMPT_MODE.toolPolicy).toContain('search_in_files');
        expect(PLAN_PROMPT_MODE.toolPolicy).toContain('search_in_files');
        expect(REVIEW_PROMPT_MODE.toolPolicy).toContain('search_in_files');
        expect(ASK_PROMPT_MODE.toolPolicy).toContain('search_in_files');
    });
});
