/**
 * A1 依赖反转桥契约测试：backend/core/subAgentAvailabilityBridge。
 *
 * 覆盖：
 * - 未注册（测试/独立调用路径）时 hasAvailableSubAgentSafe() 回退 true（宽松语义，
 *   不隐藏 subagents 工具；与真实实现 hasAvailableSubAgent 在 settingsManager 未注册
 *   时的行为一致——generalWorkerEnabled undefined ≠ false）；
 * - 注册后真实转发注入实现的结果（含 false 情况），与改造前直连语义一致；
 * - 重复注册覆盖（幂等，bootstrap 重试初始化依赖此语义）；
 * - 清理（setSubAgentAvailabilityQuery(undefined)）后回退默认 true（M2 回滚口径）；
 * - 已注册查询抛错时按现状行为原样传播（桥无 try/catch，不吞错）；
 * - getSubAgentAvailabilityQuery 返回当前注册引用（供测试/未来使用）。
 */

import {
    getSubAgentAvailabilityQuery,
    hasAvailableSubAgentSafe,
    setSubAgentAvailabilityQuery
} from '../../core/subAgentAvailabilityBridge';

describe('subAgentAvailabilityBridge 契约', () => {
    // 每个用例前清空注册，保证全局状态隔离（等价于 bootstrap dispose 后的回退状态）
    beforeEach(() => {
        setSubAgentAvailabilityQuery(undefined);
    });

    test('未注册时回退 true（宽松语义：不隐藏 subagents 工具）', () => {
        expect(getSubAgentAvailabilityQuery()).toBeUndefined();
        expect(hasAvailableSubAgentSafe()).toBe(true);
    });

    test('注册后真实转发注入实现的结果（含 false 情况）', () => {
        setSubAgentAvailabilityQuery(() => true);
        expect(hasAvailableSubAgentSafe()).toBe(true);

        setSubAgentAvailabilityQuery(() => false);
        expect(hasAvailableSubAgentSafe()).toBe(false);
    });

    test('重复注册覆盖：后注册实现生效，前实现不再被调用（幂等）', () => {
        const first = jest.fn(() => true);
        const second = jest.fn(() => false);
        setSubAgentAvailabilityQuery(first);
        expect(hasAvailableSubAgentSafe()).toBe(true);

        setSubAgentAvailabilityQuery(second);
        expect(hasAvailableSubAgentSafe()).toBe(false);
        expect(first).toHaveBeenCalledTimes(1); // 覆盖前仅调用一次，覆盖后不再调用
        expect(second).toHaveBeenCalledTimes(1);
    });

    test('清理（setSubAgentAvailabilityQuery(undefined)）后回退默认 true（M2 回滚口径）', () => {
        setSubAgentAvailabilityQuery(() => false);
        expect(hasAvailableSubAgentSafe()).toBe(false);

        setSubAgentAvailabilityQuery(undefined);
        expect(getSubAgentAvailabilityQuery()).toBeUndefined();
        expect(hasAvailableSubAgentSafe()).toBe(true); // 与未注册状态一致
    });

    test('已注册查询抛错时原样传播（桥无 try/catch，按现状行为断言）', () => {
        setSubAgentAvailabilityQuery(() => {
            throw new Error('query boom');
        });
        expect(() => hasAvailableSubAgentSafe()).toThrow('query boom');
    });

    test('getSubAgentAvailabilityQuery 返回当前注册引用（同引用）', () => {
        const query = () => true;
        setSubAgentAvailabilityQuery(query);
        expect(getSubAgentAvailabilityQuery()).toBe(query);
    });
});
