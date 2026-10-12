import { CHARACTER_PROMPT_MODULES } from '../../../shared/characterPromptModules';
import type { PromptConfig } from './types';
import type { Content } from '../conversation';
import type { PromptEntry, PromptEntryRole, ResolvedPromptModeSnapshot } from '../settings';
import {
    DYNAMIC_PROMPT_PLACEHOLDERS,
    getReferencedPromptPlaceholders as getTemplateReferencedPlaceholders,
    replacePromptPlaceholders as replaceTemplatePlaceholders,
} from './templatePlaceholders';
import { fingerprint, formatTodoListText } from './textUtils';
import type { DynamicRuntimeContext, DynamicContextDiffBase, PromptAssemblyHost } from './promptAssemblyTypes';

/** 只渲染模板、条目和动态模块；缓存键与回合拼装由调用方管理。 */
export class PromptTemplateRenderer {
    private readonly sections: PromptAssemblyHost['sections'];
    constructor(
        private readonly host: PromptAssemblyHost,
        private readonly readConfig: () => PromptConfig,
    ) {
        this.sections = host.sections;
    }

    private get config(): PromptConfig {
        return this.readConfig();
    }

    /**
     * 从模板生成系统提示词（静态部分）
     *
     * 只包含静态内容，可被 API provider 缓存：
     * - {{$ENVIRONMENT}} - 静态环境信息（操作系统、时区、用户语言、工作区路径）
     * - {{$CONTEXT_BADGE_FORMAT}} - lim-context 徽章结构说明（告诉 AI 标题/正文含义）
     * - {{$TOOLS}} - 工具定义（由外部填充）
     * - {{$MCP_TOOLS}} - MCP 工具定义（由外部填充）
     *
     * 动态内容（时间、文件树、标签页等）由 getDynamicContextMessages() 方法生成
     */
    generateFromTemplate(template: string, customPrefix: string, customSuffix: string, runtime?: DynamicRuntimeContext): string {
        // 自定义模板可能不引用这些段落，只构建实际用到的模块，避免无关的上下文与设置读取。
        const referencedKeys = this.getReferencedPromptPlaceholders(template);
        const modules: Record<string, string> = {
            ENVIRONMENT: referencedKeys.has('ENVIRONMENT') ? this.sections.wrapSection('ENVIRONMENT', this.sections.generateStaticEnvironmentSection()) : '',
            CONTEXT_BADGE_FORMAT: referencedKeys.has('CONTEXT_BADGE_FORMAT')
                ? this.sections.wrapSection('CONTEXT BADGE FORMAT', this.sections.generateContextBadgeFormatSection())
                : '',
            // 动态内容占位符 - 这些将被移到动态上下文消息中
            // 为了向后兼容，如果模板中包含 these placeholders，替换为空字符串
            WORKSPACE_FILES: '',
            OPEN_TABS: '',
            ACTIVE_EDITOR: '',
            DIAGNOSTICS: '',
            PINNED_FILES: '',
            // 工具定义由外部在发送前填充，这里返回占位符
            TOOLS: '{{$TOOLS}}',
            MCP_TOOLS: '{{$MCP_TOOLS}}',
            // 记忆系统使用说明（用户可在设置中自定义）
            MEMORY: referencedKeys.has('MEMORY') ? this.sections.generateMemorySection() : '',
        };

        // 替换模板中的占位符（使用 {{$xxx}} 格式）：单次交替正则扫描 + 回调查表替换
        // （旧实现逐键 new RegExp + replace 为 O(占位符数 × 模板长度)；且字符串替换值会展开 $ 特殊序列）
        for (const module of CHARACTER_PROMPT_MODULES) modules[module.id] ??= '';
        const result = this.replacePromptPlaceholders(template, modules).replace(
            /\{\{\s*(char|user|persona)\s*\}\}/gi,
            (match, key: string) => runtime?.characterMacros?.[key.toLowerCase()] ?? match,
        );

        // 清理多余的空行
        return this.sections.cleanupEmptyLines(result);
    }

    /**
     * 从动态模板生成上下文内容
     *
     * 支持的变量：
     * - {{$TODO_LIST}} - 当前会话的 TODO 列表（来自 ConversationMetadata.custom['todoList']）
     * - {{$WORKSPACE_FILES}} - 工作区文件树
     * - {{$OPEN_TABS}} - 打开的标签页
     * - {{$ACTIVE_EDITOR}} - 当前活动编辑器
     * - {{$DIAGNOSTICS}} - 诊断信息
     * - {{$PINNED_FILES}} - 固定文件内容
     * - {{$SKILLS}} - 当前会话启用的 Skills 列表
     */
    generateDynamicFromTemplate(
        template: string,
        contextConfig: any,
        runtime?: DynamicRuntimeContext,
        diffBase?: DynamicContextDiffBase,
    ): { content: string; sectionValues: Record<string, string>; templateFingerprint: string } {
        const referencedKeys = this.getReferencedPromptPlaceholders(template);
        const fullModules = this.buildDynamicPromptModules(contextConfig, runtime, referencedKeys);
        const templateFingerprint = fingerprint(template);
        const modules = this.applySectionDiff(fullModules, diffBase, templateFingerprint);
        const templateModules: Record<string, string> = {
            TODO_LIST: '',
            WORKSPACE_FILES: '',
            OPEN_TABS: '',
            ACTIVE_EDITOR: '',
            DIAGNOSTICS: '',
            PINNED_FILES: '',
            SKILLS: '',
            ...modules,
        };

        const result = this.replacePromptPlaceholders(template, templateModules);

        // 全部 section 与上一轮相同（被差分剔除）：整条动态消息不发，
        // 模型仍能从 preserve 回插的历史快照看到内容，请求前缀与上轮一致。
        // 例外：基准存在的 section 在当前消失（清空，如 TODO 清空/标签全关）时
        // 必须发送——否则模型持续持有过期快照（MEDIUM-2：消失的 section 不出现在
        // 当前 modules 里，Object.values().every 恒真导致整条消息持续被省略）。
        // 前置条件：模板至少引用一个动态占位符键（[...referencedKeys].some(k =>
        // DYNAMIC_PROMPT_PLACEHOLDERS.has(k))）。只引用非动态键（如 {{$ENVIRONMENT}}/
        // {{$MEMORY}}）的模板 modules 恒为空，every 对空对象恒真——若仅用
        // referencedKeys.size > 0 作前置条件，会误把含静态文本的整条消息省略（04 批 LOW）。
        const baseKeys = diffBase?.sectionValues ? Object.keys(diffBase.sectionValues) : [];
        const vanishedSection = baseKeys.some((key) => !(key in modules));
        const allSectionsOmitted =
            [...referencedKeys].some((key) => DYNAMIC_PROMPT_PLACEHOLDERS.has(key)) &&
            !!diffBase?.sectionValues &&
            Object.values(modules).every((value) => !value) &&
            !vanishedSection;
        return {
            content: allSectionsOmitted ? '' : this.sections.cleanupEmptyLines(result),
            // 完整 section 值（未差分）供下一轮作为对比基准。
            sectionValues: fullModules,
            templateFingerprint,
        };
    }

    buildDynamicPromptModules(contextConfig: any, runtime?: DynamicRuntimeContext, onlyKeys?: Set<string>): Record<string, string> {
        const settingsManager = this.host.settings();
        const modules: Record<string, string> = {};
        const shouldBuild = (key: string) => !onlyKeys || onlyKeys.has(key);

        if (shouldBuild('CURRENT_TIME')) modules['CURRENT_TIME'] = new Date().toISOString();

        if (shouldBuild('TODO_LIST')) {
            const todoText = formatTodoListText(runtime?.todoList);
            if (todoText) {
                modules['TODO_LIST'] = this.sections.wrapSection('TODO LIST', todoText);
            }
        }

        // 工作区文件树
        if (shouldBuild('WORKSPACE_FILES') && (contextConfig?.includeWorkspaceFiles ?? this.config.includeWorkspaceFiles)) {
            const fileTreeContent = this.sections.generateFileTreeSection(
                contextConfig?.maxFileDepth ?? this.config.maxDepth ?? 10,
                contextConfig?.ignorePatterns ?? [],
            );
            if (fileTreeContent) {
                modules['WORKSPACE_FILES'] = this.sections.wrapSection('WORKSPACE FILES', fileTreeContent);
            }
        }

        // 打开的标签页
        if (shouldBuild('OPEN_TABS') && contextConfig?.includeOpenTabs) {
            const openTabsContent = this.sections.generateOpenTabsSection(contextConfig.maxOpenTabs, contextConfig.ignorePatterns || []);
            if (openTabsContent) {
                modules['OPEN_TABS'] = this.sections.wrapSection('OPEN TABS', openTabsContent);
            }
        }

        // 当前活动编辑器
        if (shouldBuild('ACTIVE_EDITOR') && contextConfig?.includeActiveEditor) {
            const activeEditorContent = this.sections.generateActiveEditorSection(contextConfig.ignorePatterns || []);
            if (activeEditorContent) {
                modules['ACTIVE_EDITOR'] = this.sections.wrapSection('ACTIVE EDITOR', activeEditorContent);
            }
        }

        // 诊断信息
        if (shouldBuild('DIAGNOSTICS')) {
            const diagnosticsContent = this.sections.generateDiagnosticsSection();
            if (diagnosticsContent) {
                modules['DIAGNOSTICS'] = this.sections.wrapSection('DIAGNOSTICS', diagnosticsContent);
            }
        }

        // 固定文件内容
        if (shouldBuild('PINNED_FILES')) {
            const pinnedFilesContent = this.sections.generatePinnedFilesSection(runtime?.pinnedFiles);
            if (pinnedFilesContent) {
                const sectionTitle = settingsManager?.getPinnedFilesConfig()?.sectionTitle || 'PINNED FILES CONTENT';
                modules['PINNED_FILES'] = this.sections.wrapSection(sectionTitle, pinnedFilesContent);
            }
        }

        if (shouldBuild('SKILLS')) {
            const skillsText = this.generateSkillsSection(runtime?.skills);
            if (skillsText) {
                modules['SKILLS'] = this.sections.wrapSection('SKILLS', skillsText);
            }
        }

        for (const module of CHARACTER_PROMPT_MODULES) {
            if (shouldBuild(module.id) && runtime?.characterModules?.[module.id]) modules[module.id] = runtime.characterModules[module.id];
        }
        return modules;
    }

    /**
     * 对动态 section 模块做跨回合差分：与上一轮（diffBase）相同的 section 置空，
     * 变化/新增的 section 保留。模板指纹不同（模板/条目内容被修改）时强制全量发送。
     *
     * 无基准（首轮、旧缓存、single 策略）时不做差分，保持原行为。
     */
    applySectionDiff(modules: Record<string, string>, diffBase?: DynamicContextDiffBase, currentTemplateFingerprint?: string): Record<string, string> {
        if (!diffBase?.sectionValues) {
            return modules;
        }
        // 模板/条目内容变化：模型需要看到新说明，全量发送一轮（含未变化 section）。
        if (currentTemplateFingerprint && diffBase.templateFingerprint !== currentTemplateFingerprint) {
            return modules;
        }
        const result: Record<string, string> = {};
        for (const [key, value] of Object.entries(modules)) {
            result[key] = diffBase.sectionValues[key] === value ? '' : value;
        }
        return result;
    }

    usesPromptEntries(mode?: ResolvedPromptModeSnapshot): boolean {
        return mode?.promptAssemblyMode === 'entries';
    }

    getEnabledPromptEntries(mode?: ResolvedPromptModeSnapshot): PromptEntry[] {
        if (!Array.isArray(mode?.promptEntries)) {
            return [];
        }

        return [...mode.promptEntries].filter((entry) => !!entry && entry.enabled !== false).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }

    entryRoleToContentRole(role: PromptEntryRole): Content['role'] {
        if (role === 'assistant') return 'model';
        if (role === 'user') return 'user';
        return 'system';
    }

    hasDynamicPlaceholder(content: string): boolean {
        if (/\{\{outlet::[^}]+\}\}/.test(content)) return true;
        for (const key of DYNAMIC_PROMPT_PLACEHOLDERS) {
            if (content.includes(`{{$${key}}}`)) {
                return true;
            }
        }
        return false;
    }

    generateSkillsSection(raw: unknown): string {
        if (!Array.isArray(raw)) {
            return '';
        }

        const lines = raw
            .filter((item) => item && typeof item === 'object')
            .map((item) => {
                const name = typeof (item as any).name === 'string' ? (item as any).name.trim() : '';
                const description = typeof (item as any).description === 'string' ? (item as any).description.trim() : '';
                const id = typeof (item as any).id === 'string' ? (item as any).id.trim() : '';
                if (!name && !id) return '';
                const label = name || id;
                return description ? `- ${label}: ${description}` : `- ${label}`;
            })
            .filter(Boolean);

        return lines.join('\n');
    }

    getReferencedPromptPlaceholders(template: string): Set<string> {
        return getTemplateReferencedPlaceholders(template);
    }

    /**
     * 用查表替换模板中的 {{$KEY}} 占位符（单次交替正则扫描，见模块级 PROMPT_PLACEHOLDER_REGEX）。
     * 函数式替换器 () => value 天然规避 JS replace 替换字符串的 $&/$`/$'/$$/$n 特殊序列展开
     * （值可能来自工作区路径/固定文件内容/用户记忆提示词等不可信内容）。
     * 查表未命中的占位符保持原样（与旧逐键替换行为一致）。
     */
    replacePromptPlaceholders(template: string, modules: Record<string, string>): string {
        return replaceTemplatePlaceholders(template, modules);
    }

    renderPromptTemplateContent(
        template: string,
        runtime?: DynamicRuntimeContext,
        diffBase?: DynamicContextDiffBase,
        prebuiltModules?: Record<string, string>,
        templateFingerprintOverride?: string,
    ): string {
        const settingsManager = this.host.settings();
        const contextConfig = settingsManager?.getContextAwarenessConfig();
        const referencedKeys = this.getReferencedPromptPlaceholders(template);

        const modules: Record<string, string> = {
            ENVIRONMENT: '',
            CONTEXT_BADGE_FORMAT: '',
            TODO_LIST: '',
            WORKSPACE_FILES: '',
            OPEN_TABS: '',
            ACTIVE_EDITOR: '',
            DIAGNOSTICS: '',
            PINNED_FILES: '',
            SKILLS: '',
            MEMORY: '',
            TOOLS: '{{$TOOLS}}',
            MCP_TOOLS: '{{$MCP_TOOLS}}',
        };
        if (referencedKeys.has('ENVIRONMENT')) {
            modules['ENVIRONMENT'] = this.sections.wrapSection('ENVIRONMENT', this.sections.generateStaticEnvironmentSection());
        }
        if (referencedKeys.has('CONTEXT_BADGE_FORMAT')) {
            modules['CONTEXT_BADGE_FORMAT'] = this.sections.wrapSection('CONTEXT BADGE FORMAT', this.sections.generateContextBadgeFormatSection());
        }
        if (referencedKeys.has('MEMORY')) {
            modules['MEMORY'] = this.sections.generateMemorySection();
        }
        // prebuiltModules 由 getPromptContextBundle 一次性生成并复用，避免每条 entry 重复渲染文件树/诊断。
        // 差分指纹：entries 模式下传聚合指纹（全部动态条目内容拼接后的指纹），与上一轮缓存基准一致；
        // 否则对单条模板内容算指纹（legacy 等路径的原有行为）。
        const fullModules = prebuiltModules ?? this.buildDynamicPromptModules(contextConfig, runtime, referencedKeys);
        // vanished 检测：基准存在但当前消失的 section（清空，如 TODO 清空/标签全关）必须让
        // 本条条目发送——否则差分后渲染结果为空串时调用方（getPromptContextBundle）按
        // `if (!text.trim()) continue` 跳过，模型持续持有过期快照。与 template 路径
        // （generateDynamicFromTemplate）和 legacy 路径（getLegacyDynamicContextMessages）
        // 的 vanished 口径一致；范围收窄到本条模板实际引用的动态占位符。
        const baseKeys = diffBase?.sectionValues ? Object.keys(diffBase.sectionValues) : [];
        const vanishedSection = baseKeys.some(
            (key) => DYNAMIC_PROMPT_PLACEHOLDERS.has(key) && referencedKeys.has(key) && !!diffBase?.sectionValues?.[key] && !(key in fullModules),
        );
        const dynamicFingerprint = templateFingerprintOverride ?? fingerprint(template);
        const dynamicModules = this.applySectionDiff(fullModules, diffBase, dynamicFingerprint);
        const onlyDynamicPlaceholders =
            referencedKeys.size > 0 &&
            [...referencedKeys].every((key) => DYNAMIC_PROMPT_PLACEHOLDERS.has(key)) &&
            !/\{\{\s*(?:char|user|persona)\s*\}\}/i.test(template);
        // 没有动态内容可发送时，连同本条说明文字一起省略；静态模块仍按原模板输出。
        if (
            onlyDynamicPlaceholders &&
            diffBase?.sectionValues &&
            diffBase.templateFingerprint === dynamicFingerprint &&
            !vanishedSection &&
            [...referencedKeys].every((key) => !dynamicModules[key]?.trim())
        )
            return '';
        Object.assign(modules, dynamicModules);

        for (const module of CHARACTER_PROMPT_MODULES) modules[module.id] ??= '';
        const result = this.replacePromptPlaceholders(template, modules).replace(
            /\{\{\s*(char|user|persona)\s*\}\}/gi,
            (match, key: string) => runtime?.characterMacros?.[key.toLowerCase()] ?? match,
        );
        let output = this.sections.cleanupEmptyLines(result);
        if (vanishedSection) {
            // 清空也属于变化，明确说明哪些内容已移除，避免只留下无法表达清空的说明文字。
            const vanished = baseKeys.filter(
                (key) => DYNAMIC_PROMPT_PLACEHOLDERS.has(key) && referencedKeys.has(key) && !!diffBase?.sectionValues?.[key] && !(key in fullModules),
            );
            output = [output, this.sections.wrapSection('DYNAMIC CONTEXT', `The following dynamic sections are now empty: ${vanished.join(', ')}`)]
                .filter(Boolean)
                .join('\n\n');
        }
        return output;
    }

    renderPromptEntryContent(
        content: string,
        runtime?: DynamicRuntimeContext,
        diffBase?: DynamicContextDiffBase,
        prebuiltModules?: Record<string, string>,
        templateFingerprintOverride?: string,
    ): string {
        const expanded = content.replace(/\{\{outlet::([^}]+)\}\}/g, (_match, name: string) => runtime?.characterOutlets?.[name.trim()] ?? '');
        return this.renderPromptTemplateContent(expanded, runtime, diffBase, prebuiltModules, templateFingerprintOverride);
    }
}
