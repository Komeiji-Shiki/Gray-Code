/**
 * ToolRegistry 核心行为直接单测（任务 02#20-B）。
 *
 * 覆盖：
 *  - register 重复注册抛错（且保留首个实例）
 *  - refreshTool 失败时保留旧实例（不替换、不污染别名）
 *  - revision 递增语义（register/unregister 递增，refreshTool 不递增）
 */

import { ToolRegistry } from '../../tools/ToolRegistry';
import type { Tool } from '../../tools/types';

function makeTool(name: string, aliases?: string[]): Tool {
    return {
        declaration: {
            name,
            description: `${name} tool`,
            parameters: { type: 'object', properties: {} },
            aliases
        },
        handler: async () => ({ success: true })
    };
}

describe('ToolRegistry 核心行为', () => {
    test('register 重复注册抛错，且保留首个已注册实例', () => {
        const registry = new ToolRegistry();
        const first = makeTool('dup_tool');
        registry.register(() => first);

        expect(() => registry.register(() => makeTool('dup_tool'))).toThrow(/dup_tool/);

        // 抛错后不覆盖旧实例
        expect(registry.getTool('dup_tool')).toBe(first);
        expect(registry.count()).toBe(1);
    });

    test('refreshTool 工厂抛错时保留旧实例、返回 false，且不污染别名', () => {
        const registry = new ToolRegistry();
        const original = makeTool('dynamic_tool', ['old_alias']);
        let shouldThrow = false;
        const registration = (): Tool => {
            if (shouldThrow) {
                throw new Error('factory boom');
            }
            return original;
        };
        registry.register(registration);

        shouldThrow = true;

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(registry.refreshTool('dynamic_tool')).toBe(false);
        } finally {
            warnSpy.mockRestore();
        }

        // 旧实例与旧别名索引均未被污染
        expect(registry.getTool('dynamic_tool')).toBe(original);
        expect(registry.getTool('old_alias')).toBe(original);
        expect(registry.count()).toBe(1);
    });

    test('refreshTool 不存在的工具返回 false', () => {
        const registry = new ToolRegistry();
        expect(registry.refreshTool('missing_tool')).toBe(false);
    });

    test('revision：register/unregister 递增，refreshTool（成功/失败）不递增', () => {
        const registry = new ToolRegistry();
        expect(registry.getRevision()).toBe(0);

        registry.register(() => makeTool('tool_a'));
        expect(registry.getRevision()).toBe(1);

        registry.register(() => makeTool('tool_b'));
        expect(registry.getRevision()).toBe(2);

        // refreshTool 只替换实例、不改变工具名集合 → 不递增
        expect(registry.refreshTool('tool_a')).toBe(true);
        expect(registry.getRevision()).toBe(2);

        // 工厂抛错同样不改变工具名集合 → 不递增
        const registry2 = new ToolRegistry();
        let shouldThrow2 = false;
        const registration2 = (): Tool => {
            if (shouldThrow2) {
                throw new Error('boom');
            }
            return makeTool('flaky_tool');
        };
        registry2.register(registration2); // revision 0 -> 1
        shouldThrow2 = true;
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            expect(registry2.refreshTool('flaky_tool')).toBe(false);
        } finally {
            warnSpy.mockRestore();
        }
        expect(registry2.getRevision()).toBe(1);
        expect(registry2.getTool('flaky_tool')).toBeDefined();

        // unregister 已存在工具 → 递增
        expect(registry.unregister('tool_b')).toBe(true);
        expect(registry.getRevision()).toBe(3);

        // unregister 不存在的工具 → 不递增
        expect(registry.unregister('nope')).toBe(false);
        expect(registry.getRevision()).toBe(3);

        // clear 只清空映射、不改 revision
        registry.clear();
        expect(registry.getRevision()).toBe(3);
        expect(registry.count()).toBe(0);
    });

    test('registerBatch 逐条注册并递增 revision', () => {
        const registry = new ToolRegistry();
        registry.registerBatch([
            () => makeTool('batch_a'),
            () => makeTool('batch_b')
        ]);

        expect(registry.count()).toBe(2);
        expect(registry.getRevision()).toBe(2);
        expect(registry.getTool('batch_a')?.declaration.name).toBe('batch_a');
        expect(registry.getTool('batch_b')?.declaration.name).toBe('batch_b');
    });
});
