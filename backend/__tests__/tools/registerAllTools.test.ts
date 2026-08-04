/**
 * registerAllTools 注册真实工厂函数测试
 *
 * 覆盖修复：旧实现用 () => tool 闭包注册 getAllTools() 预构建的实例，
 * refreshTool() 重新调用"工厂"拿到的仍是同一对象（read_skill 除外），
 * 所有工具的"刷新声明"都是静默空操作。
 * 修复后 registry 保存真实工厂函数，refreshTool 应生成新实例。
 */

import { ToolRegistry } from '../../tools/ToolRegistry';
import { registerAllTools } from '../../tools/index';

describe('registerAllTools 注册真实工厂函数', () => {
    let registry: ToolRegistry;

    beforeEach(() => {
        registry = new ToolRegistry();
        registerAllTools(registry);
    });

    it('注册全部内置工具（含 read_skill 与 subagents）', () => {
        expect(registry.has('read_file')).toBe(true);
        expect(registry.has('write_file')).toBe(true);
        expect(registry.has('apply_diff')).toBe(true);
        expect(registry.has('search_in_files')).toBe(true);
        expect(registry.has('execute_command')).toBe(true);
        expect(registry.has('read_skill')).toBe(true);
        expect(registry.has('subagents')).toBe(true);
        expect(registry.has('agent_send_message')).toBe(true);
        // 内置工具数量应显著大于 0（各工具模块均已注册）
        expect(registry.count()).toBeGreaterThan(20);
    });

    it('非 read_skill 工具 refreshTool 重新生成新实例（对象引用变化）', () => {
        const before = registry.getTool('write_file');
        expect(before).toBeDefined();

        expect(registry.refreshTool('write_file')).toBe(true);

        const after = registry.getTool('write_file');
        expect(after).toBeDefined();
        // 旧实现 () => tool 闭包导致 refreshTool 返回同一实例；修复后应为新对象
        expect(after).not.toBe(before);
    });

    it('read_skill 仍以真实工厂注册，refreshTool 生成新实例', () => {
        const before = registry.getTool('read_skill');
        expect(before).toBeDefined();

        expect(registry.refreshTool('read_skill')).toBe(true);

        const after = registry.getTool('read_skill');
        expect(after).toBeDefined();
        expect(after).not.toBe(before);
    });

    it('subagents 工具注册成功且刷新不抛错', () => {
        expect(registry.getTool('subagents')).toBeDefined();
        expect(registry.getTool('agent_send_message')).toBeDefined();
        expect(registry.refreshTool('subagents')).toBe(true);
        expect(registry.refreshTool('agent_send_message')).toBe(true);
    });
});
