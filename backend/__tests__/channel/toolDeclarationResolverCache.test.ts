/**
 * M-1 回归测试：ToolDeclarationResolver 声明缓存的行为契约。
 *
 * 覆盖：
 * - 相同解析输入（options + 设置指纹 + MCP 版本）命中缓存，不重复构建声明；
 * - options 变化（channelType/allowlist/denylist 等）→ 缓存键变化 → 重建；
 * - 设置指纹变化（toolsEnabled 等）→ 重建；
 * - MCP 工具列表版本事件（server:connected/disconnected/capabilities_updated）→ 失效重建；
 * - 语言进入缓存键：setLanguage('zh-CN') 首次解析构建中文声明、同语言第二次命中缓存；
 *   切 'en' 必须重建（英文声明不复用中文对象）；切回 'zh-CN' 命中中文缓存；
 *   'ja' 归并英文目录命中 en 缓存；测试结束恢复原语言；
 * - dispose() 移除全部 MCP 监听器（配合 executor 共享实例的生命周期管理）。
 */

import { ToolDeclarationResolver } from '../../modules/channel/ToolDeclarationResolver';
import { setLanguage, getActualLanguage } from '../../i18n';
import { getToolDescriptionLocalization } from '../../tools/localization/catalogs';
import { localizeToolDeclaration } from '../../tools/localization/localizeToolDeclaration';
import type { ToolDeclaration } from '../../tools/types';
import { clearToolDeclarationFactories } from '../../tools/toolDeclarationRegistry';

const DECLARATIONS: ToolDeclaration[] = [
    { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: {} } },
    { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: {} } },
    { name: 'search_in_files', description: 'Search files', parameters: { type: 'object', properties: {} } },
    // memory_note：zh-CN 目录已覆盖（catalogs/zh-CN/auxiliary.ts），en 目录当前未覆盖。
    // stub 用英文原文 + 简单 schema（含 required），用于验证「目录已覆盖工具的说明随语言切换」。
    {
        name: 'memory_note',
        description: 'Record a permanent memory note. One line of text, limited by the entryChars limit.',
        parameters: {
            type: 'object',
            required: ['text'],
            properties: {
                text: { type: 'string', description: 'The memory text to record.' }
            }
        }
    }
];

// 这些 stub 测试依赖「工厂未注册」的静态声明回退路径；工具声明工厂注册表是模块级单例，
// 组合根或其他测试可能注册过动态工厂（如 read_file 的多模态描述工厂）。每个用例前清空注册，
// 保证解析严格走「stub 声明 + 目录本地化」路径，不被工厂产物污染（未来新增注册也不会破坏本文件）。
beforeEach(() => {
    clearToolDeclarationFactories();
});

/** 可触发事件的最小 MCP 管理器 mock */
function createMcpManagerMock() {
    const listeners = new Map<string, Set<(e?: unknown) => void>>();
    return {
        addEventListener: jest.fn((type: string, listener: () => void) => {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type)!.add(listener);
        }),
        removeEventListener: jest.fn((type: string, listener: () => void) => {
            listeners.get(type)?.delete(listener);
        }),
        emit(type: string) {
            for (const listener of listeners.get(type) ?? []) listener();
        },
        getAllTools: jest.fn(() => []),
        listeners
    };
}

/**
 * 保持本地的 createHarness（createHarness 收敛批次）：ToolDeclarationResolver 专用 harness（唯一），
 * 形状与共享 fixtures 差异过大不收敛，见 ../__fixtures__/harnessFixtures.ts 头注释「未收敛」清单。
 */
function createHarness() {
    const toolRegistry = {
        getDeclarationsBy: jest.fn((_predicate: (name: string) => boolean) => DECLARATIONS.map(d => ({ ...d })))
    };
    const settingsManager = {
        getSettings: jest.fn(() => ({ toolsEnabled: {}, toolAutoExec: {}, toolsConfig: {} })),
        isToolEnabled: jest.fn(() => true),
        getGenerateImageConfig: jest.fn(() => ({}))
    };
    const mcpManager = createMcpManagerMock();
    const resolver = new ToolDeclarationResolver(toolRegistry as any, settingsManager as any, mcpManager as any);
    return { resolver, toolRegistry, settingsManager, mcpManager };
}

const BASE_OPTIONS = {
    channelType: 'openai' as const,
    toolMode: 'function_call' as const,
    multimodalEnabled: false
};

describe('ToolDeclarationResolver 声明缓存', () => {
    test('相同输入命中缓存：第二次 resolve 不重复构建（getDeclarationsBy 只调用一次）', () => {
        const { resolver, toolRegistry } = createHarness();
        const first = resolver.resolve(BASE_OPTIONS);
        const second = resolver.resolve(BASE_OPTIONS);
        expect(first?.length).toBe(4);
        expect(second?.length).toBe(4);
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(1);
    });

    test('options 变化（channelType / allowlist）→ 缓存键变化 → 重建', () => {
        const { resolver, toolRegistry } = createHarness();
        resolver.resolve(BASE_OPTIONS);
        resolver.resolve({ ...BASE_OPTIONS, channelType: 'anthropic' });
        resolver.resolve({ ...BASE_OPTIONS, allowlist: ['read_file'] });
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(3);
    });

    test('设置指纹变化（toolsEnabled）→ 重建', () => {
        const { resolver, toolRegistry, settingsManager } = createHarness();
        resolver.resolve(BASE_OPTIONS);
        settingsManager.getSettings.mockReturnValue({ toolsEnabled: { read_file: true }, toolAutoExec: {}, toolsConfig: {} });
        resolver.resolve(BASE_OPTIONS);
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(2);
    });

    test('MCP 工具列表版本事件（connected/disconnected/capabilities_updated）→ 失效重建', () => {
        const { resolver, toolRegistry, mcpManager } = createHarness();
        resolver.resolve(BASE_OPTIONS);
        resolver.resolve(BASE_OPTIONS);
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(1);

        mcpManager.emit('server:connected');
        resolver.resolve(BASE_OPTIONS);
        mcpManager.emit('server:capabilities_updated');
        resolver.resolve(BASE_OPTIONS);
        mcpManager.emit('server:disconnected');
        resolver.resolve(BASE_OPTIONS);

        // 初始 1 次 + 3 次事件后各重建 1 次
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(4);
    });

    test('dispose() 移除全部 MCP 监听器（3 个事件类型各一次）', () => {
        const { resolver, mcpManager } = createHarness();
        resolver.dispose();
        expect(mcpManager.removeEventListener).toHaveBeenCalledTimes(3);
        const removedTypes = mcpManager.removeEventListener.mock.calls.map(call => call[0]).sort();
        expect(removedTypes).toEqual(['server:capabilities_updated', 'server:connected', 'server:disconnected']);
        // 事件派发不再触发版本递增（监听器已移除）
        const callsBefore = (mcpManager.listeners.get('server:connected')?.size ?? 0);
        expect(callsBefore).toBe(0);
    });
});

describe('ToolDeclarationResolver 语言缓存（声明本地化）', () => {
    let originalLanguage: ReturnType<typeof getActualLanguage>;

    beforeEach(() => {
        originalLanguage = getActualLanguage();
    });

    afterEach(() => {
        // 恢复原语言，避免污染同文件其他测试与后续测试文件
        setLanguage(originalLanguage);
    });

    /**
     * 解析结果应与「目录本地化应用器」产出一致：
     * 目录已覆盖时即本地化说明，目录未覆盖时两边都保留原文。
     */
    function expectLocalizedAs(expectedLang: 'zh-CN' | 'en', declarations: ToolDeclaration[]): void {
        for (const decl of DECLARATIONS) {
            const localized = localizeToolDeclaration(decl, getToolDescriptionLocalization(expectedLang, decl.name));
            const resolved = declarations.find(d => d.name === decl.name)!;
            expect(resolved.description).toBe(localized.description);
        }
    }

    test('setLanguage(zh-CN) 第一次 resolve 构建中文声明，同语言第二次命中缓存', () => {
        const { resolver, toolRegistry } = createHarness();
        setLanguage('zh-CN');
        const first = resolver.resolve(BASE_OPTIONS)!;
        const second = resolver.resolve(BASE_OPTIONS)!;
        // 第二次命中缓存：不重复构建（getDeclarationsBy 只调用一次）
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(1);
        // 命中返回浅克隆数组，元素引用稳定（声明对象是解析时的私有快照）
        expect(second.length).toBe(first.length);
        for (let i = 0; i < first.length; i++) {
            expect(second[i]).toBe(first[i]);
        }
        // 中文声明与 zh-CN 目录应用器产物一致（目录已覆盖时即中文说明）
        expectLocalizedAs('zh-CN', first);
    });

    test('切 setLanguage(en) 必须重新构建：英文声明不复用中文对象', () => {
        const { resolver, toolRegistry } = createHarness();
        setLanguage('zh-CN');
        const zh = resolver.resolve(BASE_OPTIONS)!;
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(1);

        setLanguage('en');
        const en = resolver.resolve(BASE_OPTIONS)!;
        // 语言变化 → 缓存键变化 → 重建
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(2);
        expect(en.length).toBe(zh.length);
        // 英文声明是新构建对象，不能复用中文缓存中的对象引用
        for (let i = 0; i < en.length; i++) {
            expect(en[i]).not.toBe(zh[i]);
        }
        // 英文结果与 en 目录应用器产物一致（目录未覆盖时保持原始英文声明）
        expectLocalizedAs('en', en);
    });

    test('再次 setLanguage(zh-CN) 命中中文缓存（不重复构建）', () => {
        const { resolver, toolRegistry } = createHarness();
        setLanguage('zh-CN');
        const zh1 = resolver.resolve(BASE_OPTIONS)!;
        setLanguage('en');
        resolver.resolve(BASE_OPTIONS);
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(2);

        setLanguage('zh-CN');
        const zh2 = resolver.resolve(BASE_OPTIONS)!;
        // zh-CN 缓存条目仍在：直接命中，不重建
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(2);
        expect(zh2.length).toBe(zh1.length);
        for (let i = 0; i < zh1.length; i++) {
            expect(zh2[i]).toBe(zh1[i]);
        }
    });

    test('setLanguage(ja) 归并为英文目录：命中 en 缓存（内容与引用一致）', () => {
        const { resolver, toolRegistry } = createHarness();
        setLanguage('en');
        const en = resolver.resolve(BASE_OPTIONS)!;
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(1);

        setLanguage('ja');
        const ja = resolver.resolve(BASE_OPTIONS)!;
        // ja 经 resolveLocalizationLanguage 归并为 en：缓存键相同 → 命中 en 缓存，不重建
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(1);
        expect(ja.length).toBe(en.length);
        for (let i = 0; i < en.length; i++) {
            expect(ja[i]).toBe(en[i]);
        }
    });

    test('目录已覆盖工具（memory_note）：zh-CN 解析出中文说明，en 不含中文字符', () => {
        const { resolver, toolRegistry } = createHarness();
        const originalEnglish = DECLARATIONS.find(decl => decl.name === 'memory_note')!.description;

        setLanguage('zh-CN');
        const zh = resolver.resolve(BASE_OPTIONS)!;
        const zhMemory = zh.find(decl => decl.name === 'memory_note')!;
        // zh-CN 目录覆盖了 memory_note：顶层说明与参数说明均为中文
        expect(zhMemory.description).toMatch(/[\u4e00-\u9fff]/);
        const zhCatalog = getToolDescriptionLocalization('zh-CN', 'memory_note')!;
        expect(zhMemory.description).toBe(zhCatalog.description);
        expect(zhMemory.parameters.properties.text.description).toBe(zhCatalog.parameters!['text']);

        setLanguage('en');
        const en = resolver.resolve(BASE_OPTIONS)!;
        const enMemory = en.find(decl => decl.name === 'memory_note')!;
        // en 目录当前未覆盖 memory_note：保留原始英文声明；
        // 即使并行修复合入 en memory_* 英文覆盖，覆盖文本同样不含中文字符——两种情况下都断言无 CJK
        expect(enMemory.description).not.toMatch(/[\u4e00-\u9fff]/);
        const enCatalog = getToolDescriptionLocalization('en', 'memory_note');
        if (enCatalog) {
            expect(enMemory.description).toBe(enCatalog.description ?? originalEnglish);
        } else {
            expect(enMemory.description).toBe(originalEnglish);
        }
        // 语言切换 → 缓存键变化 → 重建（zh-CN 与 en 各构建一次）
        expect(toolRegistry.getDeclarationsBy).toHaveBeenCalledTimes(2);
    });
});
