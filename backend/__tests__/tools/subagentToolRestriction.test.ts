/**
 * R4 复查修复（FIX-E 批次）回归测试 —— 嵌套子代理权限隔离（H-1）+ 空工具集拒绝（M-6）。
 *
 * 覆盖：
 * - H-1（权限逃逸）：blacklist 预设（deep-researcher）解析出的工具集无写工具且无 subagents；
 *   whitelist 只读（code-reviewer）、mcp（web-searcher）同样被裁剪；具备完整写/执行能力的
 *   配置（parallel-editor、mode all）保留 subagents。
 * - H-1（父限制传播）：嵌套派发时子 run 的最终可用工具 = 自身配置解析结果 ∩ 父 run 可用工具；
 *   mode='all' 的 General Worker 被只读父限制裁剪后无写工具、无 subagents；
 *   run 的工具限制按 runId 注册（供更内层派发继承），run 结束后清理。
 * - M-6（空集语义）：allowedToolNames 为空 Set 时（本 run 无任何可用工具）拒绝一切工具调用。
 */

import { createDefaultExecutor, resolveSubAgentAvailableTools, getRunAllowedTools } from '../../tools/subagents/executor';
import { ToolDeclarationResolver } from '../../modules/channel/ToolDeclarationResolver';
import { SUB_AGENT_PRESETS, getSubAgentPreset } from '../../tools/subagents';
import { subAgentConcurrencyLimiter } from '../../tools/subagents';
import type { SubAgentConfig, SubAgentExecutorContext } from '../../tools/subagents';
import type { GenerateResponse } from '../../modules/channel/types';
import { createSubAgentConfig } from '../__fixtures__/subagentFixtures';

jest.mock('../../modules/channel/ToolDeclarationResolver', () => ({
    ToolDeclarationResolver: jest.fn()
}));

/** 内置工具全集（含写工具、execute_command 与 subagents，模拟 mode='all' 的注册表） */
const ALL_BUILTIN_TOOLS = [
    'read_file', 'list_files', 'get_symbols', 'goto_definition', 'find_references',
    'search_in_files', 'find_files',
    'write_file', 'apply_diff', 'insert_code', 'delete_code', 'delete_file', 'create_directory',
    'execute_command', 'subagents'
];


function createContext(overrides: Partial<SubAgentExecutorContext> = {}): SubAgentExecutorContext {
    return {
        channelManager: {
            generate: jest.fn()
        } as any,
        toolRegistry: { getAllDeclarations: () => [] } as any,
        configManager: {
            getConfig: async () => ({
                id: 'channel_1',
                name: 'Test Channel',
                type: 'custom',
                toolMode: 'function_call',
                multimodalToolsEnabled: false
            })
        } as any,
        ...overrides
    };
}

/**
 * 模拟 ToolDeclarationResolver 的真实过滤语义（allowlist/denylist/exclude/include），
 * 让 resolveSubAgentAvailableTools 的 H-1 裁剪逻辑在完整工具流下被测。
 */
function mockResolveTools(allTools: string[]): jest.Mock {
    const resolveMock = jest.fn((options: any) => {
        let tools = allTools.map(name => ({
            name,
            description: `desc of ${name}`,
            parameters: { type: 'object', properties: {} }
        }));
        const exclude = new Set<string>(options.excludeToolNames || []);
        tools = tools.filter(t => !exclude.has(t.name));
        if (options.allowlist) {
            const allow = new Set<string>(options.allowlist);
            tools = tools.filter(t => allow.has(t.name));
        }
        if (options.denylist) {
            const deny = new Set<string>(options.denylist);
            tools = tools.filter(t => !deny.has(t.name));
        }
        if (options.includeBuiltins === false) {
            tools = tools.filter(t => t.name.startsWith('mcp__'));
        }
        if (options.includeMcp === false) {
            tools = tools.filter(t => !t.name.startsWith('mcp__'));
        }
        return tools;
    });
    (ToolDeclarationResolver as unknown as jest.Mock).mockImplementation(() => ({ resolve: resolveMock }));
    return resolveMock;
}

function textResponse(): GenerateResponse {
    return {
        content: {
            role: 'model',
            parts: [{ text: 'done' }],
            modelVersion: 'model-x'
        } as GenerateResponse['content'],
        model: 'model-x'
    };
}

function toolCallResponse(name: string, args: Record<string, unknown>): GenerateResponse {
    return {
        content: {
            role: 'model',
            parts: [{ functionCall: { name, args, id: `call_${name}` } }],
            modelVersion: 'model-x'
        } as GenerateResponse['content'],
        model: 'model-x'
    };
}

function flushMicrotasks(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/** 从预设构造可注册的 SubAgentConfig（补齐 channel/enabled 等运行时字段） */
function presetConfig(presetId: string): SubAgentConfig {
    const preset = getSubAgentPreset(presetId);
    if (!preset) throw new Error(`preset not found: ${presetId}`);
    return {
        type: presetId,
        name: preset.defaultName,
        description: preset.defaultDescription,
        systemPrompt: preset.systemPrompt,
        channel: { channelId: 'channel_1' },
        tools: preset.tools,
        maxIterations: preset.maxIterations,
        maxRuntime: preset.maxRuntime,
        enabled: true
    };
}

describe('嵌套子代理权限隔离 - 预设工具集裁剪（executor 层）', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    test('deep-researcher（blacklist 排除写工具 + execute_command）解析后无写工具、无 subagents', async () => {
        mockResolveTools(ALL_BUILTIN_TOOLS);
        const resolved = await resolveSubAgentAvailableTools(presetConfig('deep-researcher'), createContext());
        const names = resolved.map(d => d.name);

        // 黑名单语义仍由 resolver 口径生效
        for (const writeTool of ['write_file', 'apply_diff', 'insert_code', 'delete_code', 'delete_file', 'create_directory']) {
            expect(names).not.toContain(writeTool);
        }
        expect(names).not.toContain('execute_command');
        // H-1：不具备完整写/执行能力 → subagents 被裁剪，无法派发越权 General Worker
        expect(names).not.toContain('subagents');
        // 只读调查工具保留
        expect(names).toContain('read_file');
        expect(names).toContain('search_in_files');
    });

    test('code-reviewer（whitelist 只读）解析后无写工具、无 subagents', async () => {
        mockResolveTools(ALL_BUILTIN_TOOLS);
        const resolved = await resolveSubAgentAvailableTools(presetConfig('code-reviewer'), createContext());
        const names = resolved.map(d => d.name);

        expect(names).not.toContain('write_file');
        expect(names).not.toContain('execute_command');
        expect(names).not.toContain('subagents');
        expect(names).toContain('read_file');
    });

    test('web-searcher（mcp 模式）无内置写工具，subagents 被裁剪', async () => {
        mockResolveTools([...ALL_BUILTIN_TOOLS, 'mcp__server_a__search']);
        const resolved = await resolveSubAgentAvailableTools(presetConfig('web-searcher'), createContext());
        const names = resolved.map(d => d.name);

        expect(names).toContain('mcp__server_a__search');
        expect(names).not.toContain('write_file');
        expect(names).not.toContain('subagents');
    });

    test('parallel-editor（whitelist 含全部写/执行工具）保留写/执行能力；subagents 未列入白名单故不暴露', async () => {
        mockResolveTools(ALL_BUILTIN_TOOLS);
        const resolved = await resolveSubAgentAvailableTools(presetConfig('parallel-editor'), createContext());
        const names = resolved.map(d => d.name);

        expect(names).toContain('write_file');
        expect(names).toContain('execute_command');
        // whitelist 模式的 resolver 口径：未列入白名单的工具不暴露。
        // parallel-editor 预设未显式列出 subagents，因此即使具备写/执行能力也不会派发嵌套。
        expect(names).not.toContain('subagents');
    });

    test('whitelist 含全部写/执行工具且显式包含 subagents 时保留 subagents', async () => {
        mockResolveTools(ALL_BUILTIN_TOOLS);
        const resolved = await resolveSubAgentAvailableTools(
            createSubAgentConfig({ tools: { mode: 'whitelist', whitelist: [...ALL_BUILTIN_TOOLS] } }),
            createContext()
        );
        const names = resolved.map(d => d.name);

        expect(names).toContain('write_file');
        expect(names).toContain('execute_command');
        // 具备完整写/执行能力且白名单显式放行 → 允许嵌套派发
        expect(names).toContain('subagents');
    });

    test('mode all（General Worker 配置）保留 subagents', async () => {
        mockResolveTools(ALL_BUILTIN_TOOLS);
        const resolved = await resolveSubAgentAvailableTools(createSubAgentConfig(), createContext());
        const names = resolved.map(d => d.name);
        expect(names).toContain('subagents');
        expect(names).toContain('write_file');
    });

    test('blacklist 只排除 execute_command（写工具齐全）时 subagents 仍被裁剪（防执行权限逃逸）', async () => {
        mockResolveTools(ALL_BUILTIN_TOOLS);
        const resolved = await resolveSubAgentAvailableTools(
            createSubAgentConfig({ tools: { mode: 'blacklist', blacklist: ['execute_command'] } }),
            createContext()
        );
        const names = resolved.map(d => d.name);

        expect(names).toContain('write_file');
        expect(names).not.toContain('execute_command');
        // 缺 execute_command → 嵌套 General Worker 会把执行权限带回来，必须裁剪
        expect(names).not.toContain('subagents');
    });
});

describe('嵌套子代理权限隔离 - 父限制传播（executor 层）', () => {
    afterEach(() => {
        subAgentConcurrencyLimiter.release('restricted_child');
        subAgentConcurrencyLimiter.release('m6_empty_run');
        jest.clearAllMocks();
    });

    test('mode=all 的 General Worker 被只读父限制裁剪：无写工具、无 subagents，且不收到嵌套提示', async () => {
        mockResolveTools(ALL_BUILTIN_TOOLS);
        let resolveGenerate: (v: unknown) => void = () => { };
        const generateMock = jest.fn((_request: any) => new Promise(r => { resolveGenerate = r; }));
        const executor = createDefaultExecutor(createSubAgentConfig(), createContext({
            channelManager: { generate: generateMock } as any
        }));

        // 父 run 只读（无写/执行工具）→ inheritedToolFilter 只含只读工具
        const running = executor({
            agentType: 'general-worker',
            prompt: 'nested task',
            runId: 'restricted_child',
            depth: 2,
            parentRunId: 'parent_run',
            inheritedToolFilter: ['read_file', 'list_files', 'get_symbols', 'search_in_files']
        });

        await flushMicrotasks();
        expect(generateMock).toHaveBeenCalledTimes(1);

        // 子 run 自己的工具限制已注册（供更内层派发继承），内容 = 自身解析 ∩ 父限制
        expect(getRunAllowedTools('restricted_child')).toEqual(
            new Set(['read_file', 'list_files', 'get_symbols', 'search_in_files'])
        );

        // 模型可见的 toolOverrides 只有父限制内的工具
        const request = generateMock.mock.calls[0][0];
        const toolNames = request.toolOverrides.map((t: { name: string }) => t.name).sort();
        expect(toolNames).toEqual(['get_symbols', 'list_files', 'read_file', 'search_in_files']);
        expect(toolNames).not.toContain('write_file');
        expect(toolNames).not.toContain('execute_command');
        expect(toolNames).not.toContain('subagents');
        // 工具集不含 subagents → 不追加嵌套说明
        expect(request.dynamicSystemPrompt).not.toContain('subagents 工具');

        resolveGenerate(textResponse());
        const result = await running;
        expect(result.success).toBe(true);

        // run 结束后工具限制登记被清理（不残留内存）
        expect(getRunAllowedTools('restricted_child')).toBeUndefined();
    });

    test('M-6：可用工具为空集时拒绝一切工具调用（不把空集当“不校验”）', async () => {
        // 解析结果为空 → allowedToolNames 为空 Set
        mockResolveTools([]);
        const generateMock = jest.fn((_request: any): Promise<any> => Promise.resolve());
        generateMock
            .mockResolvedValueOnce(toolCallResponse('write_file', { path: 'x.txt' }))
            .mockResolvedValueOnce(textResponse());
        const executor = createDefaultExecutor(createSubAgentConfig({ maxIterations: 5 }), createContext({
            channelManager: { generate: generateMock } as any
        }));

        const result = await executor({
            agentType: 'tester',
            prompt: 'try to write',
            runId: 'm6_empty_run'
        });

        // 本轮 LLM 调用请求显式携带空 toolOverrides（空数组 = 声明无任何可用工具，
        // 不能传 undefined 让 ChannelManager 回退成渠道全量工具声明）
        expect(generateMock.mock.calls[0][0].toolOverrides).toEqual([]);
        // 工具调用被防御性拒绝（空集 = 无任何可用工具）
        expect(result.toolCalls).toHaveLength(1);
        expect(result.toolCalls![0].tool).toBe('write_file');
        expect(result.toolCalls![0].success).toBe(false);
        // 第二轮文本响应后 run 正常完成
        expect(result.success).toBe(true);
    });
});

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
