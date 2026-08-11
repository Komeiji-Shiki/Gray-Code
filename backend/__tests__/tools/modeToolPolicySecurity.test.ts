/**
 * 模式工具权限安全测试（SEC）。
 *
 * 覆盖：
 * 1. plan/design/review 模式的 toolPolicy 包含全部记忆指令（memory_wake/note/recall/compress/zoom/forget/config）；
 * 2. isSearchInFilesReplaceForbidden 判定口径：allowlist 授予 search_in_files 但未授予
 *    通用写工具时禁止 replace 模式，search 只读模式不受影响；code 模式（无 toolPolicy）不受限；
 * 3. ToolExecutionService 运行时门：ask/plan/design/review 模式下 search_in_files mode=replace
 *    被拒绝（权限漏洞回归），mode=search 放行，code 模式不受限；
 * 4. 用户自定义模式若显式授予写工具（如 write_file），replace 模式不被误伤。
 */

import { ToolExecutionService } from '../../modules/api/chat/services/ToolExecutionService';
import type { ResolvedPromptModeSnapshot } from '../../modules/settings/types';
import { MEMORY_TOOL_NAMES } from '../../modules/memory/types';
import {
    DESIGN_PROMPT_MODE,
    PLAN_PROMPT_MODE,
    REVIEW_PROMPT_MODE,
    ASK_PROMPT_MODE,
} from '../../modules/settings/promptModes';
import {
    isSearchInFilesReplaceForbidden,
    GENERAL_FILE_WRITE_TOOLS,
} from '../../modules/settings/modeToolsPolicy';
import { setGlobalSettingsManager } from '../../core/settingsContext';
import { SettingsManager, MemorySettingsStorage } from '../../modules/settings';
import type { FunctionCallInfo } from '../../modules/api/chat/utils';
import { ToolDeclarationResolver } from '../../modules/channel/ToolDeclarationResolver';
import type { ToolDeclaration } from '../../tools/types';

const SEARCH_DECLARATION: ToolDeclaration = {
    name: 'search_in_files',
    description: 'Search or search-and-replace content in workspace files.',
    parameters: {
        type: 'object',
        properties: {
            mode: { type: 'string', enum: ['search', 'replace'], description: 'Operation mode.', default: 'search' },
            query: { type: 'string' },
            replace: { type: 'string', description: '[Replace mode] Replacement string.' },
            maxFiles: { type: 'number', description: '[Replace mode] Maximum number of files.' }
        },
        required: ['query']
    }
};

const OTHER_DECLARATION: ToolDeclaration = {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } }
};

function createResolverHarness() {
    const toolRegistry = {
        getDeclarationsBy: jest.fn(() => [
            { ...SEARCH_DECLARATION, parameters: JSON.parse(JSON.stringify(SEARCH_DECLARATION.parameters)) },
            { ...OTHER_DECLARATION }
        ])
    };
    const settingsManager = {
        getSettings: jest.fn(() => ({ toolsEnabled: {}, toolAutoExec: {}, toolsConfig: {} })),
        isToolEnabled: jest.fn(() => true),
        getGenerateImageConfig: jest.fn(() => ({}))
    };
    const resolver = new ToolDeclarationResolver(toolRegistry as any, settingsManager as any, undefined as any);
    return { resolver };
}

describe('ToolDeclarationResolver 声明收敛（search_in_files 只读化）', () => {
    test('受限模式下 search_in_files 声明移除 replace 枚举与 replace 专属参数', () => {
        const { resolver } = createResolverHarness();
        const mode = makeMode('ask', READONLY_LIKE_POLICY);
        const declarations = resolver.resolve({
            channelType: 'openai',
            toolMode: 'function_call',
            multimodalEnabled: false,
            promptModeSnapshot: mode
        })!;
        const search = declarations.find(d => d.name === 'search_in_files')!;
        const modeProp = (search.parameters as any).properties.mode;
        expect(modeProp.enum).toEqual(['search']);
        expect((search.parameters as any).properties.replace).toBeUndefined();
        expect((search.parameters as any).properties.maxFiles).toBeUndefined();
        // 搜索必备参数保留
        expect((search.parameters as any).properties.query).toBeDefined();
    });

    test('受限模式下其他工具声明不受影响', () => {
        const { resolver } = createResolverHarness();
        const mode = makeMode('review', [...READONLY_LIKE_POLICY, 'create_review']);
        const declarations = resolver.resolve({
            channelType: 'openai',
            toolMode: 'function_call',
            multimodalEnabled: false,
            promptModeSnapshot: mode
        })!;
        const baseline = resolver.resolve({
            channelType: 'openai',
            toolMode: 'function_call',
            multimodalEnabled: false
        })!;
        const readFile = declarations.find(d => d.name === 'read_file')!;
        const baselineReadFile = baseline.find(d => d.name === 'read_file')!;
        expect(readFile.parameters).toEqual(baselineReadFile.parameters);
    });

    test('code 模式（无 toolPolicy）与授予写工具的模式：声明保持完整 replace 能力', () => {
        const { resolver } = createResolverHarness();
        const codeDecls = resolver.resolve({
            channelType: 'openai',
            toolMode: 'function_call',
            multimodalEnabled: false
        })!;
        const codeSearch = codeDecls.find(d => d.name === 'search_in_files')!;
        expect((codeSearch.parameters as any).properties.mode.enum).toEqual(['search', 'replace']);

        const writeMode = makeMode('custom', ['search_in_files', 'write_file']);
        const writeDecls = resolver.resolve({
            channelType: 'openai',
            toolMode: 'function_call',
            multimodalEnabled: false,
            promptModeSnapshot: writeMode
        })!;
        const writeSearch = writeDecls.find(d => d.name === 'search_in_files')!;
        expect((writeSearch.parameters as any).properties.mode.enum).toEqual(['search', 'replace']);
        expect((writeSearch.parameters as any).properties.replace).toBeDefined();
    });

    test('声明缓存：不同 toolPolicy 的模式互不污染（受限模式 → 完整模式）', () => {
        const { resolver } = createResolverHarness();
        const restricted = resolver.resolve({
            channelType: 'openai',
            toolMode: 'function_call',
            multimodalEnabled: false,
            promptModeSnapshot: makeMode('ask', READONLY_LIKE_POLICY)
        })!;
        expect((restricted.find(d => d.name === 'search_in_files')!.parameters as any).properties.mode.enum).toEqual(['search']);

        // 同一 resolver 实例、不同模式快照：完整声明不受之前受限模式缓存影响
        const unrestricted = resolver.resolve({
            channelType: 'openai',
            toolMode: 'function_call',
            multimodalEnabled: false,
            promptModeSnapshot: makeMode('custom', ['search_in_files', 'write_file'])
        })!;
        expect((unrestricted.find(d => d.name === 'search_in_files')!.parameters as any).properties.mode.enum).toEqual(['search', 'replace']);
    });
});

function makeCall(name: string, args: Record<string, unknown>): FunctionCallInfo {
    return { id: `call-${name}-${Math.random()}`, name, args } as FunctionCallInfo;
}

function makeMode(id: string, toolPolicy: string[]): ResolvedPromptModeSnapshot {
    return {
        id,
        name: id,
        toolPolicy,
    } as unknown as ResolvedPromptModeSnapshot;
}

/** 与内置模式一致的受限 allowlist（含 search_in_files、不含通用写工具） */
const READONLY_LIKE_POLICY = ['read_file', 'list_files', 'find_files', 'search_in_files'];

async function createService(): Promise<ToolExecutionService> {
    const settingsManager = new SettingsManager(new MemorySettingsStorage());
    await settingsManager.initialize();
    setGlobalSettingsManager(settingsManager);
    return new ToolExecutionService(undefined, undefined, settingsManager as any);
}

async function runCall(service: ToolExecutionService, call: FunctionCallInfo, mode?: ResolvedPromptModeSnapshot) {
    const result = await service.executeFunctionCallsWithResults(
        [call],
        undefined,
        undefined,
        undefined,
        undefined,
        mode
    );
    return result.toolResults[0].result as Record<string, unknown>;
}

describe('plan/design/review 模式记忆指令', () => {
    test('design 模式 toolPolicy 包含全部记忆工具', () => {
        for (const name of MEMORY_TOOL_NAMES) {
            expect(DESIGN_PROMPT_MODE.toolPolicy).toContain(name);
        }
    });

    test('plan 模式 toolPolicy 包含全部记忆工具', () => {
        for (const name of MEMORY_TOOL_NAMES) {
            expect(PLAN_PROMPT_MODE.toolPolicy).toContain(name);
        }
    });

    test('review 模式 toolPolicy 包含全部记忆工具', () => {
        for (const name of MEMORY_TOOL_NAMES) {
            expect(REVIEW_PROMPT_MODE.toolPolicy).toContain(name);
        }
    });

    test('ask 模式保持只读定位：不包含记忆写工具', () => {
        // ask 是纯问答模式，未被授予记忆指令（用户仅要求 plan/design/review）
        expect(ASK_PROMPT_MODE.toolPolicy).not.toContain('memory_note');
    });

    test('内置模式仍包含 search_in_files 搜索能力（只封 replace、不封搜索）', () => {
        expect(DESIGN_PROMPT_MODE.toolPolicy).toContain('search_in_files');
        expect(PLAN_PROMPT_MODE.toolPolicy).toContain('search_in_files');
        expect(REVIEW_PROMPT_MODE.toolPolicy).toContain('search_in_files');
        expect(ASK_PROMPT_MODE.toolPolicy).toContain('search_in_files');
    });
});

describe('isSearchInFilesReplaceForbidden 判定口径', () => {
    test('allowlist 含 search_in_files 但无通用写工具：禁止 replace', () => {
        expect(isSearchInFilesReplaceForbidden(['search_in_files', 'read_file'])).toBe(true);
        expect(isSearchInFilesReplaceForbidden(['search_in_files'])).toBe(true);
    });

    test('allowlist 含 search_in_files 且含任一通用写工具：允许 replace（无权限逃逸）', () => {
        expect(isSearchInFilesReplaceForbidden(['search_in_files', 'write_file'])).toBe(false);
        expect(isSearchInFilesReplaceForbidden(['search_in_files', 'apply_diff'])).toBe(false);
        expect(isSearchInFilesReplaceForbidden(['search_in_files', 'delete_file'])).toBe(false);
    });

    test('allowlist 不含 search_in_files：不限制（由 allowlist 本身拒绝工具）', () => {
        expect(isSearchInFilesReplaceForbidden(['read_file'])).toBe(false);
        expect(isSearchInFilesReplaceForbidden([])).toBe(false);
    });

    test('无 toolPolicy（code 模式）：不受限制', () => {
        expect(isSearchInFilesReplaceForbidden(undefined)).toBe(false);
    });

    test('GENERAL_FILE_WRITE_TOOLS 覆盖全部通用写工具', () => {
        for (const name of ['write_file', 'apply_diff', 'insert_code', 'delete_code', 'delete_file', 'create_directory']) {
            expect(GENERAL_FILE_WRITE_TOOLS.has(name)).toBe(true);
        }
    });
});

describe('ToolExecutionService 运行时门（search_in_files replace 权限漏洞回归）', () => {
    let service: ToolExecutionService;

    beforeEach(async () => {
        service = await createService();
    });

    test.each([
        ['ask', makeMode('ask', READONLY_LIKE_POLICY)],
        ['plan', makeMode('plan', [...READONLY_LIKE_POLICY, 'create_plan', 'update_plan'])],
        ['design', makeMode('design', [...READONLY_LIKE_POLICY, 'create_design', 'update_design'])],
        ['review', makeMode('review', [...READONLY_LIKE_POLICY, 'create_review'])],
    ])('%s 模式：search_in_files mode=replace 被拒绝', async (_label, mode) => {
        const result = await runCall(service, makeCall('search_in_files', { query: 'a', mode: 'replace', replace: 'b' }), mode);
        expect(result.rejected).toBe(true);
        expect((result.error as string) || '').toContain('mode "replace" is not allowed');
    });

    test.each([
        ['ask', makeMode('ask', READONLY_LIKE_POLICY)],
        ['plan', makeMode('plan', [...READONLY_LIKE_POLICY, 'create_plan', 'update_plan'])],
        ['design', makeMode('design', [...READONLY_LIKE_POLICY, 'create_design', 'update_design'])],
        ['review', makeMode('review', [...READONLY_LIKE_POLICY, 'create_review'])],
    ])('%s 模式：search_in_files 只读搜索不受影响', async (_label, mode) => {
        const result = await runCall(service, makeCall('search_in_files', { query: 'a' }), mode);
        // 未被模式策略拒绝（工具因无 registry 返回 not found，而非权限拒绝）
        expect(result.rejected).toBeFalsy();
        expect((result.error as string) || '').not.toContain('not allowed');
    });

    test('code 模式（无 toolPolicy）：replace 模式不受限', async () => {
        const result = await runCall(service, makeCall('search_in_files', { query: 'a', mode: 'replace', replace: 'b' }), makeMode('code', []));
        expect(result.rejected).toBeFalsy();
        expect((result.error as string) || '').not.toContain('not allowed');
    });

    test('自定义模式显式授予 write_file：replace 模式不误伤', async () => {
        const mode = makeMode('custom', ['search_in_files', 'write_file']);
        const result = await runCall(service, makeCall('search_in_files', { query: 'a', mode: 'replace', replace: 'b' }), mode);
        expect(result.rejected).toBeFalsy();
        expect((result.error as string) || '').not.toContain('not allowed');
    });

    test('未被 allowlist 收录的工具仍被拒绝（既有行为不回归）', async () => {
        const mode = makeMode('ask', ['read_file']);
        const result = await runCall(service, makeCall('execute_command', { command: 'x' }), mode);
        expect(result.rejected).toBe(true);
        expect((result.error as string) || '').toContain('not allowed in mode');
    });
});
