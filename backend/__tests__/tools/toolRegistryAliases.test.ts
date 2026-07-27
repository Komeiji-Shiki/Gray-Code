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

describe('ToolRegistry 别名索引', () => {
    it('通过主名称查找不受影响', () => {
        const registry = new ToolRegistry();
        registry.register(() => makeTool('my_tool'));

        expect(registry.getTool('my_tool')?.declaration.name).toBe('my_tool');
        expect(registry.getTool('nonexistent')).toBeUndefined();
    });

    it('通过别名可以找到工具', () => {
        const registry = new ToolRegistry();
        registry.register(() => makeTool('new_name', ['old_name', 'legacy_name']));

        expect(registry.getTool('old_name')?.declaration.name).toBe('new_name');
        expect(registry.getTool('legacy_name')?.declaration.name).toBe('new_name');
    });

    it('先注册的工具优先占用别名', () => {
        const registry = new ToolRegistry();
        registry.register(() => makeTool('first_tool', ['shared_alias']));
        registry.register(() => makeTool('second_tool', ['shared_alias']));

        expect(registry.getTool('shared_alias')?.declaration.name).toBe('first_tool');
    });

    it('注销工具后其别名同时失效', () => {
        const registry = new ToolRegistry();
        registry.register(() => makeTool('my_tool', ['old_name']));

        expect(registry.unregister('my_tool')).toBe(true);
        expect(registry.getTool('old_name')).toBeUndefined();
    });

    it('refreshTool 后使用新声明的别名', () => {
        const registry = new ToolRegistry();
        let currentAliases = ['old_name'];
        registry.register(() => makeTool('my_tool', currentAliases));

        expect(registry.getTool('old_name')?.declaration.name).toBe('my_tool');

        currentAliases = ['renamed_alias'];
        expect(registry.refreshTool('my_tool')).toBe(true);

        expect(registry.getTool('old_name')).toBeUndefined();
        expect(registry.getTool('renamed_alias')?.declaration.name).toBe('my_tool');
    });

    it('clear 清空别名索引', () => {
        const registry = new ToolRegistry();
        registry.register(() => makeTool('my_tool', ['old_name']));

        registry.clear();

        expect(registry.getTool('old_name')).toBeUndefined();
        expect(registry.count()).toBe(0);
    });
});
