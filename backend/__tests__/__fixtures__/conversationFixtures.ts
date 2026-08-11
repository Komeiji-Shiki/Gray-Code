/**
 * 测试共享 fixture：conversation 系列 builder（makeContent / makeHistory）。
 *
 * 这是测试共享 fixture，禁止在测试内复制。
 *
 * 收敛说明（模块化重构第六批）：
 * - makeContent 原在 10 个 conversation 测试中重复定义（5 个带 extra 参数、3 个不带、
 *   1 个无 timestamp、1 个按 role 附加 modelVersion），统一为「timestamp + 可选 extra」形态；
 *   历史断言均不依赖被收敛的差异字段。
 * - makeHistory 原在 3 个测试中重复定义（完全同构）。
 * - 消费方通过 `import { makeContent, makeHistory } from '../__fixtures__/conversationFixtures'` 引入。
 */
import type { ConversationHistory, Content } from '../../modules/conversation/types';

/** 构造一条最小 Content（带 timestamp，可经 extra 覆盖/扩展任意字段）。 */
export function makeContent(role: 'user' | 'model', text: string, extra: Record<string, unknown> = {}): Content {
    return { role, parts: [{ text }], timestamp: Date.now(), ...extra } as Content;
}

/** 构造 count 条 user 消息历史，消息文本为 `${prefix}${i}`。 */
export function makeHistory(count: number, prefix = 'm'): ConversationHistory {
    const history: ConversationHistory = [];
    for (let i = 0; i < count; i++) {
        history.push(makeContent('user', `${prefix}${i}`));
    }
    return history;
}
