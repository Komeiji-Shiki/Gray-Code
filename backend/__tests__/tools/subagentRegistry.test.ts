/**
 * SubAgentRegistry 行为测试（F-05 / F-08）
 *
 * F-05：isEnabled() 只有代理存在且未被禁用时才返回 true。
 * F-08：get()/getByName() 不再隐式创建默认 executor；显式注册的 executor 原样保留。
 */

import { SubAgentRegistry } from '../../tools/subagents';
import type { SubAgentConfig, SubAgentExecutor } from '../../tools/subagents';
import { createSubAgentConfig } from '../__fixtures__/subagentFixtures';


describe('SubAgentRegistry.isEnabled', () => {
    let registry: SubAgentRegistry;

    beforeEach(() => {
        registry = new SubAgentRegistry();
    });

    test('未注册代理返回 false（F-05 回归）', () => {
        expect(registry.isEnabled('not-registered')).toBe(false);
    });

    test('注册且未显式禁用的代理返回 true', () => {
        registry.register(createSubAgentConfig());
        expect(registry.isEnabled('tester')).toBe(true);
    });

    test('注册且 enabled: true 返回 true', () => {
        registry.register(createSubAgentConfig({ enabled: true }));
        expect(registry.isEnabled('tester')).toBe(true);
    });

    test('setEnabled(false) 后返回 false', () => {
        registry.register(createSubAgentConfig());
        expect(registry.setEnabled('tester', false)).toBe(true);
        expect(registry.isEnabled('tester')).toBe(false);
    });

    test('注销后返回 false', () => {
        registry.register(createSubAgentConfig());
        expect(registry.unregister('tester')).toBe(true);
        expect(registry.isEnabled('tester')).toBe(false);
    });
});

describe('SubAgentRegistry executor 语义（F-08）', () => {
    let registry: SubAgentRegistry;

    beforeEach(() => {
        registry = new SubAgentRegistry();
    });

    test('get() 不再隐式创建默认 executor，未注册时返回 undefined', () => {
        registry.register(createSubAgentConfig());
        const entry = registry.get('tester');
        expect(entry?.executor).toBeUndefined();
        expect(registry.get('missing')).toBeUndefined();
    });

    test('getByName() 不再隐式创建默认 executor', () => {
        registry.register(createSubAgentConfig());
        const entry = registry.getByName('Tester');
        expect(entry?.executor).toBeUndefined();
    });

    test('显式注册的自定义 executor 原样保留', () => {
        const customExecutor: SubAgentExecutor = async () => ({ success: true, response: 'custom' });
        registry.register(createSubAgentConfig(), customExecutor);

        expect(registry.get('tester')?.executor).toBe(customExecutor);
        expect(registry.getByName('Tester')?.executor).toBe(customExecutor);
        expect(registry.getExecutor('tester')).toBe(customExecutor);
    });

    test('updateConfig 后清除已注册的 executor（配置变更后需要重新注册）', () => {
        const customExecutor: SubAgentExecutor = async () => ({ success: true, response: 'custom' });
        registry.register(createSubAgentConfig(), customExecutor);
        registry.updateConfig('tester', { description: 'updated' });

        expect(registry.getExecutor('tester')).toBeUndefined();
    });
});
