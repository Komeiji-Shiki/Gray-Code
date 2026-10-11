/** 预设仍供独立平台设置页使用，直接验证共享数据，旧执行器过滤规则随旧宿主移除。 */
import { SUB_AGENT_PRESETS, getSubAgentPreset } from '../../tools/subagents/presets';

describe('预设定义完整性（presets 数据不变形）', () => {
    test('deep-researcher 黑名单包含全部写工具与 execute_command', () => {
        const preset = getSubAgentPreset('deep-researcher');
        expect(preset?.tools.mode).toBe('blacklist');
        expect(preset?.tools.blacklist).toEqual(expect.arrayContaining([
            'write_file', 'apply_diff', 'insert_code', 'delete_code', 'delete_file', 'create_directory', 'execute_command'
        ]));
    });

    test('四个内置预设均存在且 tools 配置合法', () => {
        const ids = SUB_AGENT_PRESETS.map(p => p.presetId);
        expect(ids).toEqual(expect.arrayContaining(['code-reviewer', 'deep-researcher', 'parallel-editor', 'web-searcher']));
        for (const preset of SUB_AGENT_PRESETS) {
            expect(['all', 'builtin', 'mcp', 'whitelist', 'blacklist']).toContain(preset.tools.mode);
        }
    });
});
