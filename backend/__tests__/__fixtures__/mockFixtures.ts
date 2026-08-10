/**
 * 测试共享 fixture：mock 系列 builder（createPromptManagerMock）。
 *
 * 这是测试共享 fixture，禁止在测试内复制。
 *
 * 收敛说明（模块化重构第六批）：
 * - createPromptManagerMock 原在 4 个测试中重复定义（完全同构：空 bundle + 3 个 jest.fn）。
 * - 注：createSettingsManagerMock 因首参语义（mode / pinnedFiles 数组）、
 *   dynamicContextStrategy 默认值（single / preserve）与方法集各不相同，属形状各异的 builder，
 *   按重构纪律不收敛，保留在各自测试内。
 * - diffManager 模块级 jest.mock 注册见 ./diffManagerMock.ts（副作用模块）。
 */
export function createPromptManagerMock() {
    const emptyBundle = {
        beforeHistoryMessages: [],
        afterHistoryMessages: [],
        dynamicSnapshotBeforeHistoryMessages: [],
        dynamicSnapshotAfterHistoryMessages: [],
        messages: [],
        dynamicSnapshotMessages: [],
        text: '',
        dynamicSnapshotText: '',
        historyPlacement: 'legacy' as const
    };
    return {
        getPromptContextBundle: jest.fn().mockReturnValue(emptyBundle),
        refreshAndGetPrompt: jest.fn().mockReturnValue('sys'),
        getSystemPrompt: jest.fn().mockReturnValue('sys')
    };
}
