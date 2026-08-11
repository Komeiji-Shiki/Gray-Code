/**
 * 测试共享 fixture：SubAgent 系列 builder（createSubAgentConfig）。
 *
 * 这是测试共享 fixture，禁止在测试内复制。
 *
 * 收敛说明（createConfig 收敛批次）：
 * - createConfig(Partial<SubAgentConfig>) 原在 11 个 tools 测试中重复定义，默认字段差异仅三处：
 *   - maxIterations：5（多数）/ 0（subagentExecutorTermination、subagentExecutorContinuation
 *     依赖 0 触发「超出最大迭代次数」早退，调用点显式传 { maxIterations: 0 }）；
 *   - maxRuntime：300 / 缺失（subagentRegistry 不消费，缺省与 300 行为等价）；
 *   - enabled：true（subagentResolverSharing / subagentToolRestriction / subagentToolConfirmation）/
 *     缺失（其余，SubAgentRegistry.isEnabled 对缺省与 true 同义）。
 *   统一为 maxIterations:5 + maxRuntime:300 + enabled:true 的超集默认，消费方断言不依赖被收敛差异。
 * - 消费方通过 `import { createSubAgentConfig } from '../__fixtures__/subagentFixtures'` 引入。
 */
import type { SubAgentConfig } from '../../tools/subagents/types';

/**
 * 构造最小 SubAgentConfig（tester 代理）。
 * 差异点：默认 maxIterations=5；需要立即早退的用例显式传 { maxIterations: 0 }。
 */
export function createSubAgentConfig(overrides: Partial<SubAgentConfig> = {}): SubAgentConfig {
    return {
        type: 'tester',
        name: 'Tester',
        description: 'test agent',
        systemPrompt: 'you are a test agent',
        channel: { channelId: 'channel_1' },
        tools: { mode: 'all' },
        maxIterations: 5,
        maxRuntime: 300,
        enabled: true,
        ...overrides
    };
}
