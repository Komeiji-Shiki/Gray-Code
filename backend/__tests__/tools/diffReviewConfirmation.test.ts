import { ToolExecutionService } from '../../modules/api/chat/services/ToolExecutionService';
import { isDiffReviewToolCall, DIFF_REVIEW_TOOL_NAMES } from '../../modules/api/chat/services/diffReviewTools';
import { setGlobalSettingsManager } from '../../core/settingsContext';
import { SettingsManager, MemorySettingsStorage } from '../../modules/settings';

/**
 * Diff 审阅类工具的确认语义测试。
 *
 * 背景：以前 write_file/apply_diff 在 autoSave 开启时还要看"自动执行"页的勾选，
 * insert_code/delete_code 在 autoSave 关闭时会被聊天确认 + diff 审阅双重确认。
 * 用户需要在两个设置页都配置才能真正自动，非常迷糊。
 *
 * 新语义：diff 审阅类调用一律不走聊天确认，diff 机制本身就是确认层，
 * 确认行为的唯一数据源是 apply_diff 工具设置（autoSave / 延迟 / 跳过差异视图）。
 */
describe('diff review tool confirmation semantics', () => {
    let settingsManager: SettingsManager;
    let service: ToolExecutionService;

    beforeEach(async () => {
        jest.clearAllMocks();
        settingsManager = new SettingsManager(new MemorySettingsStorage());
        await settingsManager.initialize();
        setGlobalSettingsManager(settingsManager);
        service = new ToolExecutionService(undefined, undefined, settingsManager);
    });

    it.each([...DIFF_REVIEW_TOOL_NAMES])(
        '%s 不走聊天确认（autoSave 关闭 + 自动执行页未勾选）',
        async (toolName) => {
            await settingsManager.setToolAutoExec(toolName, false);

            expect(service.toolNeedsConfirmation(toolName, {})).toBe(false);
        }
    );

    it.each([...DIFF_REVIEW_TOOL_NAMES])(
        '%s 不走聊天确认（autoSave 开启 + 自动执行页未勾选，以前会被双重把关）',
        async (toolName) => {
            await settingsManager.updateApplyDiffConfig({ autoSave: true });
            await settingsManager.setToolAutoExec(toolName, false);

            expect(service.toolNeedsConfirmation(toolName, {})).toBe(false);
        }
    );

    it('search_in_files replace 模式不走聊天确认（走 diff 审阅）', async () => {
        await settingsManager.setToolAutoExec('search_in_files', false);

        expect(service.toolNeedsConfirmation('search_in_files', { query: 'a', mode: 'replace', replace: 'b' })).toBe(false);
    });

    it('search_in_files search 模式（只读）仍跟随自动执行页配置', async () => {
        await settingsManager.setToolAutoExec('search_in_files', false);
        expect(service.toolNeedsConfirmation('search_in_files', { query: 'a' })).toBe(true);

        await settingsManager.setToolAutoExec('search_in_files', true);
        expect(service.toolNeedsConfirmation('search_in_files', { query: 'a' })).toBe(false);
    });

    it('非 diff 审阅工具仍跟随自动执行页配置', async () => {
        await settingsManager.setToolAutoExec('execute_command', false);
        expect(service.toolNeedsConfirmation('execute_command', { command: 'echo hi' })).toBe(true);

        await settingsManager.setToolAutoExec('execute_command', true);
        expect(service.toolNeedsConfirmation('execute_command', { command: 'echo hi' })).toBe(false);
    });

    describe('isDiffReviewToolCall', () => {
        it('覆盖四个写入工具', () => {
            expect(isDiffReviewToolCall('write_file')).toBe(true);
            expect(isDiffReviewToolCall('apply_diff')).toBe(true);
            expect(isDiffReviewToolCall('insert_code')).toBe(true);
            expect(isDiffReviewToolCall('delete_code')).toBe(true);
        });

        it('search_in_files 按 mode 区分', () => {
            expect(isDiffReviewToolCall('search_in_files', { mode: 'replace' })).toBe(true);
            expect(isDiffReviewToolCall('search_in_files', { mode: 'search' })).toBe(false);
            expect(isDiffReviewToolCall('search_in_files')).toBe(false);
        });

        it('其他工具不属于 diff 审阅类', () => {
            expect(isDiffReviewToolCall('read_file')).toBe(false);
            expect(isDiffReviewToolCall('execute_command')).toBe(false);
            expect(isDiffReviewToolCall('delete_file')).toBe(false);
        });
    });
});
