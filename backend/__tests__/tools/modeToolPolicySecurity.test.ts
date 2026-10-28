import { DESIGN_PROMPT_MODE, PLAN_PROMPT_MODE, REVIEW_PROMPT_MODE, ASK_PROMPT_MODE } from '../../modules/settings/promptModes';

describe('只读模式工具策略', () => {
    test('内置模式仍包含 search_in_files 搜索能力', () => {
        expect(DESIGN_PROMPT_MODE.toolPolicy).toContain('search_in_files');
        expect(PLAN_PROMPT_MODE.toolPolicy).toContain('search_in_files');
        expect(REVIEW_PROMPT_MODE.toolPolicy).toContain('search_in_files');
        expect(ASK_PROMPT_MODE.toolPolicy).toContain('search_in_files');
    });
});
