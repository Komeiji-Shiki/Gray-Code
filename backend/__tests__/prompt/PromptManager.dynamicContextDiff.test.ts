/**
 * 动态上下文跨回合差分测试：
 *
 * preserve 策略下，新回合与上一轮（最近带 turnDynamicContext 的用户回合）逐 section 对比，
 * 相同 section 不再发送（模型从 preserve 回插的历史快照中仍可见），只发送变化部分；
 * 全部相同则整条动态消息省略 → 请求前缀与上轮一致 → provider 前缀缓存命中。
 *
 * 覆盖：
 * - legacy 模板模式（generateDynamicFromTemplate）
 * - 默认逻辑（无 dynamicTemplate，含 Current Time）
 * - entries 组装模式（动态 user 条目）
 * - 旧缓存（无 sectionValues）与模板指纹变化时的全量退化
 * - createTurnDynamicContext 的 preserve/single 分支
 */
import { clearGlobalContext, setGlobalSettingsManager } from '../../core/settingsContext';
import { PromptManager } from '../../modules/prompt';
import type { DynamicContextDiffBase, PromptContextBundle } from '../../modules/prompt/PromptManager';
import { deserializePromptContextCache, serializePromptContextCache } from '../../modules/prompt/promptContextCache';
import type { ResolvedPromptModeSnapshot, SystemPromptConfig } from '../../modules/settings/types';
import type { Content } from '../../modules/conversation/types';
import { ToolIterationLoopService } from '../../modules/api/chat/services/ToolIterationLoopService';

const runtimeWithTodo = (content: string) => ({
    todoList: [
        { id: 'a', content, status: 'pending' }
    ]
});

const legacyTemplateMode: ResolvedPromptModeSnapshot = {
    id: 'diff-legacy',
    name: 'Diff Legacy',
    template: 'static system',
    promptAssemblyMode: 'legacy',
    dynamicTemplateEnabled: true,
    dynamicTemplate: 'This is the current turn dynamic context.\n\n{{$TODO_LIST}}',
    promptEntries: []
};

const defaultMode: ResolvedPromptModeSnapshot = {
    id: 'diff-default',
    name: 'Diff Default',
    template: '',
    promptAssemblyMode: 'legacy',
    dynamicTemplateEnabled: true,
    dynamicTemplate: '',
    promptEntries: []
};

const entriesMode: ResolvedPromptModeSnapshot = {
    id: 'diff-entries',
    name: 'Diff Entries',
    template: 'static system',
    promptAssemblyMode: 'entries',
    dynamicTemplateEnabled: true,
    dynamicTemplate: '',
    promptEntries: [
        { id: 'system', name: 'System', type: 'prompt', enabled: true, role: 'system', order: 0, content: 'System static' },
        { id: 'chat-history', name: 'Chat History', type: 'chat_history', enabled: true, role: 'user', order: 10, content: '' },
        { id: 'dynamic-user', name: 'Dynamic user', type: 'prompt', enabled: true, role: 'user', order: 20, content: 'Dynamic context:\n\n{{$TODO_LIST}}' }
    ]
};

function createSettingsManagerMock(resolvedMode: ResolvedPromptModeSnapshot = legacyTemplateMode) {
    const config: Partial<SystemPromptConfig> = {
        customPrefix: '',
        customSuffix: '',
        dynamicTemplateEnabled: true,
        dynamicTemplate: '',
        dynamicContextStrategy: 'preserve',
        template: '',
        currentModeId: resolvedMode.id,
        modes: { [resolvedMode.id]: resolvedMode }
    };

    return {
        resolvePromptMode: jest.fn(() => resolvedMode),
        getSystemPromptConfig: jest.fn(() => config),
        getContextAwarenessConfig: jest.fn(() => ({
            includeWorkspaceFiles: false,
            includeOpenTabs: false,
            includeActiveEditor: false,
            ignorePatterns: []
        })),
        getPinnedFilesConfig: jest.fn(() => ({ sectionTitle: 'PINNED FILES CONTENT' })),
        getDiagnosticsConfig: jest.fn(() => ({ enabled: false })),
        getUISettings: jest.fn(() => ({ language: 'zh-CN' })),
        getToolsConfig: jest.fn(() => ({}))
    } as any;
}

function diffBaseFrom(bundle: PromptContextBundle): DynamicContextDiffBase {
    return {
        sectionValues: bundle.sectionValues,
        templateFingerprint: bundle.dynamicTemplateFingerprint
    };
}

describe('PromptManager 动态上下文跨回合差分', () => {
    afterEach(() => {
        clearGlobalContext();
    });

    describe('legacy 模板模式', () => {
        it('无基准（首轮）时完整发送并带出 sectionValues 与模板指纹', () => {
            setGlobalSettingsManager(createSettingsManagerMock(legacyTemplateMode));
            const manager = new PromptManager({ includeWorkspaceFiles: false });

            const bundle = manager.getPromptContextBundle(legacyTemplateMode, runtimeWithTodo('task A'));

            expect(bundle.messages).toHaveLength(1);
            expect(bundle.text).toContain('TODO LIST');
            expect(bundle.text).toContain('task A');
            expect(bundle.sectionValues?.['TODO_LIST']).toContain('task A');
            expect(bundle.dynamicTemplateFingerprint).toBeDefined();
        });

        it('全部 section 与上一轮相同 → 当前轮不发送动态消息', () => {
            setGlobalSettingsManager(createSettingsManagerMock(legacyTemplateMode));
            const manager = new PromptManager({ includeWorkspaceFiles: false });

            const first = manager.getPromptContextBundle(legacyTemplateMode, runtimeWithTodo('task A'));
            const second = manager.getPromptContextBundle(legacyTemplateMode, runtimeWithTodo('task A'), { diffBase: diffBaseFrom(first) });

            expect(second.messages).toHaveLength(0);
            expect(second.text).toBe('');
            expect(second.dynamicSnapshotMessages).toHaveLength(0);
            // 下一轮差分基准仍然完整（本轮 section 值照常缓存）
            expect(second.sectionValues?.['TODO_LIST']).toContain('task A');
        });

        it('部分变化 → 只发送变化的 section，未变化的省略', () => {
            setGlobalSettingsManager(createSettingsManagerMock(legacyTemplateMode));
            const manager = new PromptManager({ includeWorkspaceFiles: false });

            const first = manager.getPromptContextBundle(legacyTemplateMode, runtimeWithTodo('task A'));
            const second = manager.getPromptContextBundle(legacyTemplateMode, runtimeWithTodo('task B'), { diffBase: diffBaseFrom(first) });

            expect(second.messages).toHaveLength(1);
            expect(second.text).toContain('task B');
            expect(second.text).not.toContain('task A');
            // 模板静态外壳保留，帮助模型理解消息结构
            expect(second.text).toContain('This is the current turn dynamic context.');
        });

        it('模板指纹变化 → 强制全量发送（模型需要看到新说明）', () => {
            setGlobalSettingsManager(createSettingsManagerMock(legacyTemplateMode));
            const manager = new PromptManager({ includeWorkspaceFiles: false });

            const first = manager.getPromptContextBundle(legacyTemplateMode, runtimeWithTodo('task A'));
            const staleFingerprint: DynamicContextDiffBase = {
                sectionValues: first.sectionValues,
                templateFingerprint: 'different-template-fingerprint'
            };
            const second = manager.getPromptContextBundle(legacyTemplateMode, runtimeWithTodo('task A'), { diffBase: staleFingerprint });

            expect(second.messages).toHaveLength(1);
            expect(second.text).toContain('task A');
        });

        it('旧缓存（无 sectionValues）→ 无基准，全量发送', () => {
            setGlobalSettingsManager(createSettingsManagerMock(legacyTemplateMode));
            const manager = new PromptManager({ includeWorkspaceFiles: false });

            const second = manager.getPromptContextBundle(legacyTemplateMode, runtimeWithTodo('task A'), { diffBase: {} });

            expect(second.messages).toHaveLength(1);
            expect(second.text).toContain('task A');
        });
    });

    describe('默认逻辑（无 dynamicTemplate）', () => {
        it('全部 section 相同 → 整条动态消息省略（Current Time 不触发发送）', () => {
            setGlobalSettingsManager(createSettingsManagerMock(defaultMode));
            const manager = new PromptManager({ includeWorkspaceFiles: false });

            const first = manager.getPromptContextBundle(defaultMode, runtimeWithTodo('task A'));
            expect(first.text).toContain('Current Time');
            expect(first.text).toContain('task A');

            const second = manager.getPromptContextBundle(defaultMode, runtimeWithTodo('task A'), { diffBase: diffBaseFrom(first) });
            expect(second.messages).toHaveLength(0);
            expect(second.text).toBe('');
        });

        it('部分变化 → 前缀说明 + Current Time + 变化的 section', () => {
            setGlobalSettingsManager(createSettingsManagerMock(defaultMode));
            const manager = new PromptManager({ includeWorkspaceFiles: false });

            const first = manager.getPromptContextBundle(defaultMode, runtimeWithTodo('task A'));
            const second = manager.getPromptContextBundle(defaultMode, runtimeWithTodo('task B'), { diffBase: diffBaseFrom(first) });

            expect(second.messages).toHaveLength(1);
            expect(second.text).toContain('Current Time');
            expect(second.text).toContain('task B');
            expect(second.text).not.toContain('task A');
        });
    });

    describe('entries 组装模式', () => {
        it('差分后动态条目只保留静态外壳，sectionValues 与指纹照常缓存', () => {
            setGlobalSettingsManager(createSettingsManagerMock(entriesMode));
            const manager = new PromptManager({ includeWorkspaceFiles: false });

            const first = manager.getPromptContextBundle(entriesMode, runtimeWithTodo('task A'));
            const dynamicMessage = first.messages.find(message => message.parts?.[0]?.text?.includes('Dynamic context'));
            expect(dynamicMessage).toBeDefined();
            expect(first.text).toContain('task A');
            expect(first.sectionValues?.['TODO_LIST']).toContain('task A');
            expect(first.dynamicTemplateFingerprint).toBeDefined();

            const second = manager.getPromptContextBundle(entriesMode, runtimeWithTodo('task A'), { diffBase: diffBaseFrom(first) });
            const secondDynamicMessage = second.messages.find(message => message.parts?.[0]?.text?.includes('Dynamic context'));
            expect(secondDynamicMessage).toBeDefined();
            expect(secondDynamicMessage!.parts![0].text).not.toContain('task A');
            expect(second.sectionValues?.['TODO_LIST']).toContain('task A');
        });

        it('变化的 section 在 entries 模式下正常发送', () => {
            setGlobalSettingsManager(createSettingsManagerMock(entriesMode));
            const manager = new PromptManager({ includeWorkspaceFiles: false });

            const first = manager.getPromptContextBundle(entriesMode, runtimeWithTodo('task A'));
            const second = manager.getPromptContextBundle(entriesMode, runtimeWithTodo('task B'), { diffBase: diffBaseFrom(first) });

            const dynamicMessage = second.messages.find(message => message.parts?.[0]?.text?.includes('Dynamic context'));
            expect(dynamicMessage).toBeDefined();
            expect(dynamicMessage!.parts![0].text).toContain('task B');
            expect(dynamicMessage!.parts![0].text).not.toContain('task A');
        });
    });

        it('LOW-3：动态条目 role 翻转（content 不变）→ 指纹变化 → 强制全量发送', () => {
            setGlobalSettingsManager(createSettingsManagerMock(entriesMode));
            const manager = new PromptManager({ includeWorkspaceFiles: false });
            const first = manager.getPromptContextBundle(entriesMode, runtimeWithTodo('task A'));

            // content / section 值完全相同，仅 role 从 user 改为 assistant（entry 层；渲染为 model）
            const entries = entriesMode.promptEntries ?? [];
            const roleFlippedMode: ResolvedPromptModeSnapshot = {
                ...entriesMode,
                promptEntries: [
                    ...entries.slice(0, 2),
                    { ...entries[2]!, role: 'assistant' }
                ]
            };
            const second = manager.getPromptContextBundle(roleFlippedMode, runtimeWithTodo('task A'), { diffBase: diffBaseFrom(first) });

            // 指纹必须随 role 变化（否则差分按值比较全同 → 整条省略 → 模型持续看到旧 role）
            expect(second.dynamicTemplateFingerprint).not.toBe(first.dynamicTemplateFingerprint);
            const dynamicMessage = second.messages.find(message => message.parts?.[0]?.text?.includes('Dynamic context'));
            expect(dynamicMessage).toBeDefined();
            expect(dynamicMessage!.role).toBe('model');
            expect(second.text).toContain('task A');
        });

        it('LOW-3：动态条目 fakeThought 增删（content 不变）→ 指纹变化 → 强制全量发送', () => {
            setGlobalSettingsManager(createSettingsManagerMock(entriesMode));
            const manager = new PromptManager({ includeWorkspaceFiles: false });
            const first = manager.getPromptContextBundle(entriesMode, runtimeWithTodo('task A'));

            // content 不变，仅新增 fakeThought（伪造思考）
            const entries = entriesMode.promptEntries ?? [];
            const thoughtMode: ResolvedPromptModeSnapshot = {
                ...entriesMode,
                promptEntries: [
                    ...entries.slice(0, 2),
                    { ...entries[2]!, fakeThought: '（思考中）' }
                ]
            };
            const second = manager.getPromptContextBundle(thoughtMode, runtimeWithTodo('task A'), { diffBase: diffBaseFrom(first) });

            expect(second.dynamicTemplateFingerprint).not.toBe(first.dynamicTemplateFingerprint);
            const dynamicMessage = second.messages.find(message => message.parts?.[0]?.text?.includes('Dynamic context'));
            expect(dynamicMessage).toBeDefined();
            expect(second.text).toContain('task A');

            // 反向：删除 fakeThought 同样改变指纹（增删双向）
            const third = manager.getPromptContextBundle(entriesMode, runtimeWithTodo('task A'), { diffBase: diffBaseFrom(second) });
            expect(third.dynamicTemplateFingerprint).not.toBe(second.dynamicTemplateFingerprint);
        });

    describe('promptContextCache 序列化', () => {
        it('sectionValues 与 dynamicTemplateFingerprint round-trip 保留', () => {
            const bundle: PromptContextBundle = {
                beforeHistoryMessages: [{ role: 'user', parts: [{ text: 'ctx' }] }],
                afterHistoryMessages: [],
                dynamicSnapshotBeforeHistoryMessages: [],
                dynamicSnapshotAfterHistoryMessages: [],
                messages: [{ role: 'user', parts: [{ text: 'ctx' }] }],
                dynamicSnapshotMessages: [],
                text: 'ctx',
                dynamicSnapshotText: '',
                historyPlacement: 'legacy',
                sectionValues: { TODO_LIST: '====\n\nTODO LIST\n\ntask A' },
                dynamicTemplateFingerprint: 'fp-abc'
            };

            const restored = deserializePromptContextCache(serializePromptContextCache(bundle));

            expect(restored.sectionValues).toEqual({ TODO_LIST: '====\n\nTODO LIST\n\ntask A' });
            expect(restored.dynamicTemplateFingerprint).toBe('fp-abc');
        });

        it('旧缓存（无 section 字段）反序列化为 undefined，不抛错', () => {
            const legacy = JSON.stringify({
                version: 2,
                beforeHistoryMessages: [{ role: 'user', text: 'old ctx' }],
                afterHistoryMessages: [],
                dynamicSnapshotBeforeHistoryMessages: [],
                dynamicSnapshotAfterHistoryMessages: [],
                contextText: 'old ctx',
                dynamicSnapshotText: '',
                historyPlacement: 'legacy'
            });

            const restored = deserializePromptContextCache(legacy);

            expect(restored.contextText).toBe('old ctx');
            expect(restored.sectionValues).toBeUndefined();
            expect(restored.dynamicTemplateFingerprint).toBeUndefined();
        });
    });
});

describe('ToolIterationLoopService.createTurnDynamicContext 差分基准', () => {
    afterEach(() => {
        clearGlobalContext();
    });

    function createService(history: Content[]) {
        const conversationManager = {
            getHistoryRef: jest.fn().mockResolvedValue(history),
            getCustomMetadata: jest.fn().mockResolvedValue([
                { id: 'a', content: 'task A', status: 'pending' }
            ]),
            getMetadata: jest.fn().mockResolvedValue(null)
        };
        const service = new ToolIterationLoopService(
            {} as any,
            conversationManager as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any
        );
        return { service, conversationManager };
    }

    it('preserve：以上一轮缓存为基准，全部相同 → 新回合动态消息为空', async () => {
        setGlobalSettingsManager(createSettingsManagerMock(legacyTemplateMode));
        const manager = new PromptManager({ includeWorkspaceFiles: false });
        const firstBundle = manager.getPromptContextBundle(legacyTemplateMode, runtimeWithTodo('task A'));
        const history: Content[] = [
            {
                id: 'msg-1',
                role: 'user',
                isUserInput: true,
                turnDynamicContext: serializePromptContextCache(firstBundle),
                turnDynamicContextStrategy: 'preserve',
                parts: [{ text: 'first user' }]
            }
        ];
        const { service } = createService(history);
        service.setPromptManager(manager);

        const cache = await service.createTurnDynamicContext('conv-1', 'msg-2', legacyTemplateMode, 'preserve');
        const restored = deserializePromptContextCache(cache);

        // 与上一轮完全相同：差分后无动态消息，但 sectionValues 仍完整缓存供下轮对比
        expect(restored.beforeHistoryMessages).toHaveLength(0);
        expect(restored.contextText).toBe('');
        expect(restored.sectionValues?.['TODO_LIST']).toContain('task A');
    });

    it('preserve：上一轮是旧缓存（无 sectionValues）→ 全量发送', async () => {
        setGlobalSettingsManager(createSettingsManagerMock(legacyTemplateMode));
        const manager = new PromptManager({ includeWorkspaceFiles: false });
        const legacyCache = serializePromptContextCache({
            messages: [{ role: 'user', parts: [{ text: 'old ctx' }] }],
            beforeHistoryMessages: [{ role: 'user', parts: [{ text: 'old ctx' }] }],
            dynamicSnapshotMessages: [],
            text: 'old ctx',
            dynamicSnapshotText: '',
            historyPlacement: 'legacy'
        });
        const history: Content[] = [
            {
                id: 'msg-1',
                role: 'user',
                isUserInput: true,
                turnDynamicContext: legacyCache,
                parts: [{ text: 'first user' }]
            }
        ];
        const { service } = createService(history);
        service.setPromptManager(manager);

        const cache = await service.createTurnDynamicContext('conv-1', 'msg-2', legacyTemplateMode, 'preserve');
        const restored = deserializePromptContextCache(cache);

        expect(restored.beforeHistoryMessages).toHaveLength(1);
        expect(restored.contextText).toContain('task A');
    });

    it('single：不取历史基准，始终全量发送', async () => {
        setGlobalSettingsManager(createSettingsManagerMock(legacyTemplateMode));
        const manager = new PromptManager({ includeWorkspaceFiles: false });
        const history: Content[] = [
            {
                id: 'msg-1',
                role: 'user',
                isUserInput: true,
                turnDynamicContext: 'unused cache',
                parts: [{ text: 'first user' }]
            }
        ];
        const { service, conversationManager } = createService(history);
        service.setPromptManager(manager);

        const cache = await service.createTurnDynamicContext('conv-1', 'msg-2', legacyTemplateMode, 'single');
        const restored = deserializePromptContextCache(cache);

        expect(restored.beforeHistoryMessages).toHaveLength(1);
        expect(restored.contextText).toContain('task A');
        // single 不读历史基准（getHistoryRef 甚至不会被调用）
        expect(conversationManager.getHistoryRef).not.toHaveBeenCalled();
    });
});
