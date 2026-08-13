/**
 * GrayCode - 系统提示词管理器
 *
 * 负责组装和管理系统提示词
 * 
 * 分为两部分以最大化 API 提供商的 prompt caching：
 * 1. 静态系统提示词（可缓存）：操作系统、时区、用户语言、工作区路径、工具定义
 * 2. 动态上下文消息（不缓存）：时间、文件树、标签页、活动编辑器、诊断、固定文件
 *
 * 支持模板化系统提示词，使用 {{$MODULE_NAME}} 占位符引用模块
 *
 * 段落生成已抽离到 contextSections，占位符替换抽离到 templatePlaceholders，
 * 固定文件读取抽离到 pinnedFiles，忽略模式匹配抽离到 ignorePatterns，
 * 文本/指纹工具抽离到 textUtils。本类保持原有对外 API 完全不变。
 */

import * as vscode from 'vscode'
import type { PromptConfig, PromptContext } from './types'
import type { Content, ContentPart } from '../conversation'
import { getGlobalSettingsManager } from '../../core/settingsContext'
import type { PromptEntry, PromptEntryRole, ResolvedPromptModeSnapshot } from '../settings'
import { promptContextMessagesToText } from './promptContextCache'
import { PromptContextSectionBuilder } from './contextSections'
import {
    DYNAMIC_PROMPT_PLACEHOLDERS,
    getReferencedPromptPlaceholders as getTemplateReferencedPlaceholders,
    replacePromptPlaceholders as replaceTemplatePlaceholders,
} from './templatePlaceholders'
import { fingerprint, formatTodoListText } from './textUtils'
import { matchGlobPattern, shouldIgnorePath } from './ignorePatterns'

export {
    PINNED_FILE_MAX_BYTES,
    PINNED_FILE_MAX_TOTAL_BYTES,
    PINNED_FILE_CACHE_TTL_MS,
    PINNED_FILE_CACHE_MAX_ENTRIES,
    PINNED_FILE_CACHE_MAX_TOTAL_BYTES,
} from './pinnedFiles'
export { getGlobIgnoreRegexCacheStats } from './ignorePatterns'

export type DynamicRuntimeContext = {
    /** ConversationMetadata.custom['todoList'] */
    todoList?: unknown

    /** ConversationMetadata.custom['inputPinnedFiles'] */
    pinnedFiles?: unknown

    /** ConversationMetadata.custom['inputSkills'] */
    skills?: unknown

    /** 会话绑定的工作区 URI（记忆隔离：工具执行按工作区路由记忆存储） */
    workspaceUri?: string
}

export interface PromptContextBundle {
    /** 当前请求中位于真实聊天历史之前的非 system prompt context。 */
    beforeHistoryMessages: Content[]

    /** 当前请求中位于真实聊天历史之后的非 system prompt context。 */
    afterHistoryMessages: Content[]

    /** preserve 旧回合快照要插回原位的 before-history 动态子集。 */
    dynamicSnapshotBeforeHistoryMessages: Content[]

    /** preserve 旧回合快照要插回原位的 after-history 动态子集。 */
    dynamicSnapshotAfterHistoryMessages: Content[]

    /** 当前请求要插入的完整非 system prompt context（before + after），保留给旧调用兼容。 */
    messages: Content[]

    /** preserve 旧回合快照要插回原位的动态子集（dynamic before + dynamic after）。 */
    dynamicSnapshotMessages: Content[]

    /** messages 的纯文本拼接，用于 token 计数。 */
    text: string

    /** dynamicSnapshotMessages 的纯文本拼接，用于 preserve 历史 token 计数。 */
    dynamicSnapshotText: string

    /** entry 表示 chat_history 条目显式控制真实历史位置；legacy 表示沿用旧插入逻辑。 */
    historyPlacement: 'legacy' | 'entry'

    /** 各动态 section 的完整渲染值（key → wrapSection 后的文本），用于下一轮差分基准。 */
    sectionValues?: Record<string, string>

    /** 动态模板/条目内容指纹；模板变化时强制全量发送一轮。 */
    dynamicTemplateFingerprint?: string
}

/**
 * 跨回合差分基准：上一轮（最近一个带 turnDynamicContext 的用户回合）缓存的
 * 各动态 section 完整渲染值与模板指纹。
 *
 * 只有 preserve 策略会提供基准：它把历史快照回插到原位，模型能看到省略的 section，
 * 差分才是安全的；single 策略下省略会导致模型丢失基线信息，必须全量发送。
 */
export interface DynamicContextDiffBase {
    /** 上一轮各动态 section 的完整渲染值。缺失/空对象时视为无基准，全量发送。 */
    sectionValues?: Record<string, string>

    /** 上一轮的动态模板/条目内容指纹；与当前指纹不同时强制全量发送。 */
    templateFingerprint?: string
}

/**
 * 系统提示词管理器
 * 
 * 功能：
 * 1. 生成静态系统提示词（可缓存）
 * 2. 生成动态上下文消息（每次请求时插入，不存储）
 * 3. 支持自定义前缀/后缀
 * 4. 缓存和更新机制
 * 
 * 静态部分（放入系统提示词，可被 API provider 缓存）：
 * - 操作系统信息
 * - 时区
 * - 用户语言
 * - 工作区路径
 * - 工具定义（{{$TOOLS}}、{{$MCP_TOOLS}}）
 * 
 * 动态部分（作为 user 消息插入，不存储到历史记录）：
 * - 当前时间
 * - 工作区文件树
 * - 打开的标签页
 * - 当前活动编辑器
 * - 诊断信息
 * - 固定文件内容
 */
export class PromptManager {
    private config: PromptConfig
    private cachedPromptValue: string | null = null
    private lastGeneratedAt: number = 0
    private cachedPromptKey: string | null = null
    /** entries 模式下纯静态 system 提示词缓存（含动态占位符的 entry 不缓存，见 getSystemPrompt） */
    private cachedEntriesPromptValue: string | null = null
    private cachedEntriesPromptKey: string | null = null
    private lastEntriesGeneratedAt: number = 0
    /** 段落生成器（VSCode 副作用读取集中于此） */
    private readonly sections = new PromptContextSectionBuilder()
    
    // 缓存有效期（毫秒）- 1分钟
    private static readonly CACHE_TTL = 60000
    
    constructor(config: Partial<PromptConfig> = {}) {
        this.config = {
            includeWorkspaceFiles: true,
            maxDepth: 2,
            ...config
        }
    }
    
    /**
     * 更新配置
     */
    updateConfig(config: Partial<PromptConfig>): void {
        this.config = { ...this.config, ...config }
        // 清除缓存
        this.invalidateCache()
    }
    
    /**
     * 使缓存失效
     */
    invalidateCache(): void {
        this.cachedPromptValue = null
        this.cachedPromptKey = null
        this.lastGeneratedAt = 0
        this.cachedEntriesPromptValue = null
        this.cachedEntriesPromptKey = null
        this.lastEntriesGeneratedAt = 0
    }

    private resolvePromptModeSnapshot(modeSnapshot?: ResolvedPromptModeSnapshot): ResolvedPromptModeSnapshot | undefined {
        if (modeSnapshot) {
            return {
                ...modeSnapshot,
                toolPolicy: Array.isArray(modeSnapshot.toolPolicy)
                    ? [...modeSnapshot.toolPolicy]
                    : undefined
            }
        }

        const settingsManager = getGlobalSettingsManager()
        return settingsManager?.resolvePromptMode()
    }

    private buildPromptCacheKey(modeSnapshot?: ResolvedPromptModeSnapshot): string {
        const settingsManager = getGlobalSettingsManager()
        const promptConfig = settingsManager?.getSystemPromptConfig()
        const resolvedMode = this.resolvePromptModeSnapshot(modeSnapshot)
        const prefix = promptConfig?.customPrefix || ''
        const suffix = promptConfig?.customSuffix || ''
        // 模板文本必须纳入缓存键：只改模板（prefix/suffix/mode 不变）时，
        // 旧缓存会在最多 60 秒内返回过期提示词。模板可能很长，
        // 用指纹（长度 + FNV-1a 哈希）代替原文，控制 key 大小与比较成本。
        const template = resolvedMode?.template ?? promptConfig?.template ?? ''
        const memoryConfig = settingsManager?.getMemoryConfig?.()
        const memoryEnabled = memoryConfig?.enabled !== false
        const memoryPrompt = typeof memoryConfig?.systemPrompt === 'string' ? memoryConfig.systemPrompt : ''
        // 环境输入纳入缓存键：ENVIRONMENT 段含工作区集合与渲染语言——渲染用
        // getUserLanguage()（显式语言设置优先，'auto' 回落 vscode.env.language），
        // 键必须与其一致，否则显式设置语言后键不变、TTL 内滞留旧语言提示词（第五轮 LOW）。
        // 切换工作区/语言后若键不变，60s TTL 内会返回旧 ENVIRONMENT。
        const workspaceFingerprint = fingerprint(
            (vscode.workspace.workspaceFolders || [])
                .map(f => f.uri.fsPath)
                .sort()
                .join('\u0000')
        )
        const language = this.getUserLanguage()
        return `${resolvedMode?.id || 'default'}::${prefix}::${suffix}::template=${fingerprint(template)}::memory=${memoryEnabled}::${memoryPrompt}::ws=${workspaceFingerprint}::lang=${language}`
    }

    /**
     * entries 模式纯静态 system 提示词缓存键。
     * 任一 system entry 含动态占位符（TODO_LIST 等）时返回 null（结果依赖 runtime，不可缓存）。
     * 键覆盖：模式 id + 启用集合 + 顺序 + 内容指纹
     * （getEnabledPromptEntries 已按 enabled 过滤、order 排序，指纹前带 order 保证顺序变化即失效）。
     * ENVIRONMENT/MEMORY 的渲染值依赖 runtime 输入（工作区集合/渲染语言/记忆配置），
     * 仅内容指纹无法捕获——切工作区/改语言/改记忆后旧缓存会在 TTL 内滞留（04 批 MEDIUM）。
     * 与 buildPromptCacheKey（422-434）同款指纹逻辑：引用 {{$ENVIRONMENT}} 时键追加
     * ws/lang 指纹（lang 用 this.getUserLanguage()，与渲染一致、显式设置优先——第五轮 LOW
     * 修正：旧实现取 vscode.env.language，显式设置语言时键与渲染脱节），引用 {{$MEMORY}}
     * 时追加 memoryConfig 指纹；两者都未引用时键保持原样。
     */
    private buildEntriesStaticCacheKey(mode?: ResolvedPromptModeSnapshot): string | null {
        if (!this.usesPromptEntries(mode)) {
            return null
        }
        const entries = this.getEnabledPromptEntries(mode)
            .filter(entry => (entry.type || 'prompt') === 'prompt')
            .filter(entry => entry.role === 'system')
        if (entries.some(entry => this.hasDynamicPlaceholder(entry.content))) {
            return null
        }
        const contentFingerprint = fingerprint(
            entries.map(entry => `${entry.order ?? 0}\u0000${entry.content}`).join('\u0001')
        )
        let key = `${mode?.id || 'default'}::entries::${contentFingerprint}`
        const referencesEnvironment = entries.some(entry => entry.content.includes('{{$ENVIRONMENT}}'))
        const referencesMemory = entries.some(entry => entry.content.includes('{{$MEMORY}}'))
        if (referencesEnvironment || referencesMemory) {
            const settingsManager = getGlobalSettingsManager()
            if (referencesEnvironment) {
                const workspaceFingerprint = fingerprint(
                    (vscode.workspace.workspaceFolders || [])
                        .map(f => f.uri.fsPath)
                        .sort()
                        .join('\u0000')
                )
                // 与 buildPromptCacheKey 一致：语言用 this.getUserLanguage()（显式设置优先），
                // 与 ENVIRONMENT 渲染一致，避免显式设置语言后键不变、TTL 内滞留旧提示词（第五轮 LOW）。
                const language = this.getUserLanguage()
                key += `::ws=${workspaceFingerprint}::lang=${language}`
            }
            if (referencesMemory) {
                const memoryConfig = settingsManager?.getMemoryConfig?.()
                const memoryEnabled = memoryConfig?.enabled !== false
                const memoryPrompt = typeof memoryConfig?.systemPrompt === 'string' ? memoryConfig.systemPrompt : ''
                key += `::memory=${memoryEnabled}::${memoryPrompt}`
            }
        }
        return key
    }
    
    /**
     * 获取系统提示词（使用缓存）
     */
    getSystemPrompt(modeSnapshot?: ResolvedPromptModeSnapshot, forceRefresh: boolean = false, runtime?: DynamicRuntimeContext): string {
        const resolvedMode = this.resolvePromptModeSnapshot(modeSnapshot)
        if (this.usesPromptEntries(resolvedMode)) {
            // 预设条目允许 system 条目引用动态占位符，不能复用旧静态缓存。
            // 但全部 system entry 为纯静态（不含动态占位符）时，结果与 runtime 无关：
            // 按「模式 id + 启用集合 + 顺序 + 内容指纹」做 TTL 缓存，避免每条消息全量重渲染
            // （04 批 LOW：entries 组装模式下系统提示词完全不缓存）。
            const entriesCacheKey = this.buildEntriesStaticCacheKey(resolvedMode)
            if (entriesCacheKey) {
                const now = Date.now()
                if (!forceRefresh &&
                    this.cachedEntriesPromptValue !== null &&
                    this.cachedEntriesPromptKey === entriesCacheKey &&
                    (now - this.lastEntriesGeneratedAt) < PromptManager.CACHE_TTL) {
                    return this.cachedEntriesPromptValue
                }
                const value = this.generatePrompt(modeSnapshot, runtime)
                this.cachedEntriesPromptValue = value
                this.cachedEntriesPromptKey = entriesCacheKey
                this.lastEntriesGeneratedAt = now
                return value
            }
            // 含动态占位符：结果依赖 runtime，每次按请求重渲染
            return this.generatePrompt(modeSnapshot, runtime)
        }

        const now = Date.now()
        const cacheKey = this.buildPromptCacheKey(modeSnapshot)
        
        // 检查缓存是否有效
        if (!forceRefresh && 
            this.cachedPromptValue !== null &&
            this.cachedPromptKey === cacheKey &&
            (now - this.lastGeneratedAt) < PromptManager.CACHE_TTL) {
            return this.cachedPromptValue
        }
        
        // 生成新的提示词
        this.cachedPromptValue = this.generatePrompt(modeSnapshot, runtime)
        this.cachedPromptKey = cacheKey
        this.lastGeneratedAt = now
        
        return this.cachedPromptValue
    }
    
    /**
     * 强制刷新并获取系统提示词
     * 
     * 在以下情况下调用：
     * - 新对话的第一条消息
     * - 用户删除首条消息后重新发送
     * - 用户编辑首条消息后重试
     */
    refreshAndGetPrompt(modeSnapshot?: ResolvedPromptModeSnapshot, runtime?: DynamicRuntimeContext): string {
        return this.getSystemPrompt(modeSnapshot, true, runtime)
    }
    
    /**
     * 生成系统提示词
     *
     * 始终使用模板模式生成提示词
     * 用户可以通过设置自定义模板内容
     * 根据当前模式使用对应的模板
     */
    private generatePrompt(modeSnapshot?: ResolvedPromptModeSnapshot, runtime?: DynamicRuntimeContext): string {
        const settingsManager = getGlobalSettingsManager()
        const promptConfig = settingsManager?.getSystemPromptConfig()
        const resolvedMode = this.resolvePromptModeSnapshot(modeSnapshot)
        
        if (this.usesPromptEntries(resolvedMode)) {
            return this.getEnabledPromptEntries(resolvedMode)
                .filter(entry => (entry.type || 'prompt') === 'prompt')
                .filter(entry => entry.role === 'system')
                .map(entry => this.renderPromptEntryContent(entry.content, runtime))
                .filter(Boolean)
                .join('\n\n')
        }

        // 请求运行时必须显式使用本次解析出的模式快照，不能依赖全局当前模式。
        const template = resolvedMode?.template ?? promptConfig?.template ?? ''
        return this.generateFromTemplate(template, promptConfig?.customPrefix || '', promptConfig?.customSuffix || '', runtime)
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
    private generateFromTemplate(template: string, customPrefix: string, customSuffix: string, runtime?: DynamicRuntimeContext): string {
        // 静态模块（不会频繁变化）
        const modules: Record<string, string> = {
            'ENVIRONMENT': this.wrapSection('ENVIRONMENT', this.generateStaticEnvironmentSection()),
            'CONTEXT_BADGE_FORMAT': this.wrapSection('CONTEXT BADGE FORMAT', this.generateContextBadgeFormatSection()),
            // 动态内容占位符 - 这些将被移到动态上下文消息中
            // 为了向后兼容，如果模板中包含 these placeholders，替换为空字符串
            'WORKSPACE_FILES': '',
            'OPEN_TABS': '',
            'ACTIVE_EDITOR': '',
            'DIAGNOSTICS': '',
            'PINNED_FILES': '',
            // 工具定义由外部在发送前填充，这里返回占位符
            'TOOLS': '{{$TOOLS}}',
            'MCP_TOOLS': '{{$MCP_TOOLS}}',
            // 记忆系统使用说明（用户可在设置中自定义）
            'MEMORY': this.generateMemorySection()
        }
        
        // 替换模板中的占位符（使用 {{$xxx}} 格式）：单次交替正则扫描 + 回调查表替换
        // （旧实现逐键 new RegExp + replace 为 O(占位符数 × 模板长度)；且字符串替换值会展开 $ 特殊序列）
        const result = this.replacePromptPlaceholders(template, modules)
        
        // 清理多余的空行
        return this.cleanupEmptyLines(result)
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
    private generateDynamicFromTemplate(
        template: string,
        contextConfig: any,
        runtime?: DynamicRuntimeContext,
        diffBase?: DynamicContextDiffBase
    ): { content: string; sectionValues: Record<string, string>; templateFingerprint: string } {
        const referencedKeys = this.getReferencedPromptPlaceholders(template)
        const fullModules = this.buildDynamicPromptModules(contextConfig, runtime, referencedKeys)
        const templateFingerprint = fingerprint(template)
        const modules = this.applySectionDiff(fullModules, diffBase, templateFingerprint)
        const templateModules: Record<string, string> = {
            'TODO_LIST': '',
            'WORKSPACE_FILES': '',
            'OPEN_TABS': '',
            'ACTIVE_EDITOR': '',
            'DIAGNOSTICS': '',
            'PINNED_FILES': '',
            'SKILLS': '',
            ...modules
        }

        const result = this.replacePromptPlaceholders(template, templateModules)

        // 全部 section 与上一轮相同（被差分剔除）：整条动态消息不发，
        // 模型仍能从 preserve 回插的历史快照看到内容，请求前缀与上轮一致。
        // 例外：基准存在的 section 在当前消失（清空，如 TODO 清空/标签全关）时
        // 必须发送——否则模型持续持有过期快照（MEDIUM-2：消失的 section 不出现在
        // 当前 modules 里，Object.values().every 恒真导致整条消息持续被省略）。
        // 前置条件：模板至少引用一个动态占位符键（[...referencedKeys].some(k =>
        // DYNAMIC_PROMPT_PLACEHOLDERS.has(k))）。只引用非动态键（如 {{$ENVIRONMENT}}/
        // {{$MEMORY}}）的模板 modules 恒为空，every 对空对象恒真——若仅用
        // referencedKeys.size > 0 作前置条件，会误把含静态文本的整条消息省略（04 批 LOW）。
        const baseKeys = diffBase?.sectionValues ? Object.keys(diffBase.sectionValues) : []
        const vanishedSection = baseKeys.some(key => !(key in modules))
        const allSectionsOmitted = [...referencedKeys].some(key => DYNAMIC_PROMPT_PLACEHOLDERS.has(key)) &&
            !!diffBase?.sectionValues &&
            Object.values(modules).every(value => !value) &&
            !vanishedSection
        return {
            content: allSectionsOmitted ? '' : this.cleanupEmptyLines(result),
            // 完整 section 值（未差分）供下一轮作为对比基准。
            sectionValues: fullModules,
            templateFingerprint
        }
    }

    private buildDynamicPromptModules(contextConfig: any, runtime?: DynamicRuntimeContext, onlyKeys?: Set<string>): Record<string, string> {
        const settingsManager = getGlobalSettingsManager()
        const modules: Record<string, string> = {}
        const shouldBuild = (key: string) => !onlyKeys || onlyKeys.has(key)

        if (shouldBuild('TODO_LIST')) {
            const todoText = formatTodoListText(runtime?.todoList)
            if (todoText) {
                modules['TODO_LIST'] = this.wrapSection('TODO LIST', todoText)
            }
        }
        
        // 工作区文件树
        if (shouldBuild('WORKSPACE_FILES') && (contextConfig?.includeWorkspaceFiles ?? this.config.includeWorkspaceFiles)) {
            const fileTreeContent = this.generateFileTreeSection(
                contextConfig?.maxFileDepth ?? this.config.maxDepth ?? 10,
                contextConfig?.ignorePatterns ?? []
            )
            if (fileTreeContent) {
                modules['WORKSPACE_FILES'] = this.wrapSection('WORKSPACE FILES', fileTreeContent)
            }
        }
        
        // 打开的标签页
        if (shouldBuild('OPEN_TABS') && contextConfig?.includeOpenTabs) {
            const openTabsContent = this.generateOpenTabsSection(
                contextConfig.maxOpenTabs,
                contextConfig.ignorePatterns || []
            )
            if (openTabsContent) {
                modules['OPEN_TABS'] = this.wrapSection('OPEN TABS', openTabsContent)
            }
        }
        
        // 当前活动编辑器
        if (shouldBuild('ACTIVE_EDITOR') && contextConfig?.includeActiveEditor) {
            const activeEditorContent = this.generateActiveEditorSection(
                contextConfig.ignorePatterns || []
            )
            if (activeEditorContent) {
                modules['ACTIVE_EDITOR'] = this.wrapSection('ACTIVE EDITOR', activeEditorContent)
            }
        }
        
        // 诊断信息
        if (shouldBuild('DIAGNOSTICS')) {
            const diagnosticsContent = this.generateDiagnosticsSection()
            if (diagnosticsContent) {
                modules['DIAGNOSTICS'] = this.wrapSection('DIAGNOSTICS', diagnosticsContent)
            }
        }
        
        // 固定文件内容
        if (shouldBuild('PINNED_FILES')) {
            const pinnedFilesContent = this.generatePinnedFilesSection(runtime?.pinnedFiles)
            if (pinnedFilesContent) {
                const sectionTitle = settingsManager?.getPinnedFilesConfig()?.sectionTitle || 'PINNED FILES CONTENT'
                modules['PINNED_FILES'] = this.wrapSection(sectionTitle, pinnedFilesContent)
            }
        }

        if (shouldBuild('SKILLS')) {
            const skillsText = this.generateSkillsSection(runtime?.skills)
            if (skillsText) {
                modules['SKILLS'] = this.wrapSection('SKILLS', skillsText)
            }
        }

        return modules
    }
    
    /**
     * 将内容包装为带标题的段落
     */
    private wrapSection(title: string, content: string | null): string {
        return this.sections.wrapSection(title, content)
    }
    
    /**
     * 清理文本中的多余空行
     * 
     * 将连续 3 个或以上的换行符压缩为 2 个
     */
    private cleanupEmptyLines(text: string): string {
        return this.sections.cleanupEmptyLines(text)
    }

    /**
     * 对动态 section 模块做跨回合差分：与上一轮（diffBase）相同的 section 置空，
     * 变化/新增的 section 保留。模板指纹不同（模板/条目内容被修改）时强制全量发送。
     *
     * 无基准（首轮、旧缓存、single 策略）时不做差分，保持原行为。
     */
    private applySectionDiff(
        modules: Record<string, string>,
        diffBase?: DynamicContextDiffBase,
        currentTemplateFingerprint?: string
    ): Record<string, string> {
        if (!diffBase?.sectionValues) {
            return modules
        }
        // 模板/条目内容变化：模型需要看到新说明，全量发送一轮（含未变化 section）。
        if (
            currentTemplateFingerprint &&
            diffBase.templateFingerprint !== currentTemplateFingerprint
        ) {
            return modules
        }
        const result: Record<string, string> = {}
        for (const [key, value] of Object.entries(modules)) {
            result[key] = diffBase.sectionValues[key] === value ? '' : value
        }
        return result
    }
    
    /**
     * 生成静态环境信息段落（用于系统提示词，可缓存）
     * 
     * 包含：
     * - 工作区路径
     * - 操作系统信息
     * - 时区
     * - 用户语言
     */
    private generateStaticEnvironmentSection(): string {
        return this.sections.generateStaticEnvironmentSection()
    }

    /**
     * 生成 lim-context 徽章结构说明（静态）
     *
     * 目的：让模型明确区分“标题属性”和“正文内容”，
     * 避免把 binary 徽章按文本内容解析。
     */
    private generateContextBadgeFormatSection(): string {
        return this.sections.generateContextBadgeFormatSection()
    }

    private usesPromptEntries(mode?: ResolvedPromptModeSnapshot): boolean {
        return mode?.promptAssemblyMode === 'entries'
    }

    private getEnabledPromptEntries(mode?: ResolvedPromptModeSnapshot): PromptEntry[] {
        if (!Array.isArray(mode?.promptEntries)) {
            return []
        }

        return [...mode.promptEntries]
            .filter(entry => !!entry && entry.enabled !== false)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    }

    private entryRoleToContentRole(role: PromptEntryRole): Content['role'] {
        if (role === 'assistant') return 'model'
        if (role === 'user') return 'user'
        return 'system'
    }

    private hasDynamicPlaceholder(content: string): boolean {
        for (const key of DYNAMIC_PROMPT_PLACEHOLDERS) {
            if (content.includes(`{{$${key}}}`)) {
                return true
            }
        }
        return false
    }

    private generateSkillsSection(raw: unknown): string {
        if (!Array.isArray(raw)) {
            return ''
        }

        const lines = raw
            .filter(item => item && typeof item === 'object')
            .map(item => {
                const name = typeof (item as any).name === 'string' ? (item as any).name.trim() : ''
                const description = typeof (item as any).description === 'string' ? (item as any).description.trim() : ''
                const id = typeof (item as any).id === 'string' ? (item as any).id.trim() : ''
                if (!name && !id) return ''
                const label = name || id
                return description ? `- ${label}: ${description}` : `- ${label}`
            })
            .filter(Boolean)

        return lines.join('\n')
    }

    /**
     * 生成记忆系统的使用说明。
     *
     * 优先从用户设置中读取自定义提示词（limcode.toolsConfig.memory.systemPrompt），
     * 否则使用内置默认值。
     */
    private generateMemorySection(): string {
        return this.sections.generateMemorySection()
    }


    private getReferencedPromptPlaceholders(template: string): Set<string> {
        return getTemplateReferencedPlaceholders(template)
    }

    /**
     * 用查表替换模板中的 {{$KEY}} 占位符（单次交替正则扫描，见模块级 PROMPT_PLACEHOLDER_REGEX）。
     * 函数式替换器 () => value 天然规避 JS replace 替换字符串的 $&/$`/$'/$$/$n 特殊序列展开
     * （值可能来自工作区路径/固定文件内容/用户记忆提示词等不可信内容）。
     * 查表未命中的占位符保持原样（与旧逐键替换行为一致）。
     */
    private replacePromptPlaceholders(template: string, modules: Record<string, string>): string {
        return replaceTemplatePlaceholders(template, modules)
    }

    private renderPromptTemplateContent(
        template: string,
        runtime?: DynamicRuntimeContext,
        diffBase?: DynamicContextDiffBase,
        prebuiltModules?: Record<string, string>,
        templateFingerprintOverride?: string
    ): string {
        const settingsManager = getGlobalSettingsManager()
        const contextConfig = settingsManager?.getContextAwarenessConfig()
        const referencedKeys = this.getReferencedPromptPlaceholders(template)

        const modules: Record<string, string> = {
            'ENVIRONMENT': '',
            'CONTEXT_BADGE_FORMAT': '',
            'TODO_LIST': '',
            'WORKSPACE_FILES': '',
            'OPEN_TABS': '',
            'ACTIVE_EDITOR': '',
            'DIAGNOSTICS': '',
            'PINNED_FILES': '',
            'SKILLS': '',
            'MEMORY': '',
            'TOOLS': '{{$TOOLS}}',
            'MCP_TOOLS': '{{$MCP_TOOLS}}'
        }
        if (referencedKeys.has('ENVIRONMENT')) {
            modules['ENVIRONMENT'] = this.wrapSection('ENVIRONMENT', this.generateStaticEnvironmentSection())
        }
        if (referencedKeys.has('CONTEXT_BADGE_FORMAT')) {
            modules['CONTEXT_BADGE_FORMAT'] = this.wrapSection('CONTEXT BADGE FORMAT', this.generateContextBadgeFormatSection())
        }
        if (referencedKeys.has('MEMORY')) {
            modules['MEMORY'] = this.generateMemorySection()
        }
        // prebuiltModules 由 getPromptContextBundle 一次性生成并复用，避免每条 entry 重复渲染文件树/诊断。
        // 差分指纹：entries 模式下传聚合指纹（全部动态条目内容拼接后的指纹），与上一轮缓存基准一致；
        // 否则对单条模板内容算指纹（legacy 等路径的原有行为）。
        const fullModules = prebuiltModules ?? this.buildDynamicPromptModules(contextConfig, runtime, referencedKeys)
        // vanished 检测：基准存在但当前消失的 section（清空，如 TODO 清空/标签全关）必须让
        // 本条条目发送——否则差分后渲染结果为空串时调用方（getPromptContextBundle）按
        // `if (!text.trim()) continue` 跳过，模型持续持有过期快照。与 template 路径
        // （generateDynamicFromTemplate）和 legacy 路径（getLegacyDynamicContextMessages）
        // 的 vanished 口径一致；范围收窄到本条模板实际引用的动态占位符。
        const baseKeys = diffBase?.sectionValues ? Object.keys(diffBase.sectionValues) : []
        const vanishedSection = baseKeys.some(key =>
            DYNAMIC_PROMPT_PLACEHOLDERS.has(key) && referencedKeys.has(key) && !(key in fullModules)
        )
        Object.assign(
            modules,
            this.applySectionDiff(fullModules, diffBase, templateFingerprintOverride ?? fingerprint(template))
        )

        const result = this.replacePromptPlaceholders(template, modules)
        let output = this.cleanupEmptyLines(result)
        if (vanishedSection && !output) {
            // 模板仅引用已消失的占位符（无静态外壳）时渲染结果为空串：发送最小非空标记
            // （复用 wrapSection 标题格式），让模型感知 section「不再存在」。
            const vanished = baseKeys.filter(key =>
                DYNAMIC_PROMPT_PLACEHOLDERS.has(key) && referencedKeys.has(key) && !(key in fullModules)
            )
            output = this.wrapSection('DYNAMIC CONTEXT', `The following dynamic sections are now empty: ${vanished.join(', ')}`)
        }
        return output
    }

    private renderPromptEntryContent(
        content: string,
        runtime?: DynamicRuntimeContext,
        diffBase?: DynamicContextDiffBase,
        prebuiltModules?: Record<string, string>,
        templateFingerprintOverride?: string
    ): string {
        return this.renderPromptTemplateContent(content, runtime, diffBase, prebuiltModules, templateFingerprintOverride)
    }
    
    /**
     * 获取动态上下文消息
     * 
     * 返回动态上下文消息（包含时间、文件树、标签页、诊断等）
     * 
     * **重要：** 这些消息应该只在用户主动发送消息时插入，
     * 在 AI 连续调用工具的迭代循环中不应该重复添加。
     * 
     * 这样做的好处：
     * 1. 避免重复发送相同的上下文信息，节省 token
     * 2. 减少 AI 处理的冗余信息
     * 3. 动态上下文反映的是用户发送消息时的状态
     * 
     * 输出格式：
     * - 前缀说明："这是当前可以使用的全局变量信息，如不需要请忽略"
     * - 中间：动态上下文内容（文件树、标签页、诊断等）
     * 
     * @returns 动态上下文消息数组（一条 user 消息）
     */
    getDynamicContextMessages(modeSnapshot?: ResolvedPromptModeSnapshot, runtime?: DynamicRuntimeContext): Content[] {
        return this.getPromptContextBundle(modeSnapshot, runtime).messages
    }

    getPromptContextBundle(
        modeSnapshot?: ResolvedPromptModeSnapshot,
        runtime?: DynamicRuntimeContext,
        options?: { diffBase?: DynamicContextDiffBase }
    ): PromptContextBundle {
        const resolvedMode = this.resolvePromptModeSnapshot(modeSnapshot)

        if (this.usesPromptEntries(resolvedMode)) {
            const beforeHistoryMessages: Content[] = []
            const afterHistoryMessages: Content[] = []
            const dynamicSnapshotBeforeHistoryMessages: Content[] = []
            const dynamicSnapshotAfterHistoryMessages: Content[] = []
            const entries = this.getEnabledPromptEntries(resolvedMode)
            const chatHistoryIndex = entries.findIndex(entry => entry.type === 'chat_history')
            const historyPlacement: PromptContextBundle['historyPlacement'] = chatHistoryIndex >= 0 ? 'entry' : 'legacy'

            // 动态条目（非 system、含动态占位符）：收集引用的 section 并集并一次性渲染，
            // 供所有条目差分渲染复用，避免每条 entry 重复生成文件树/诊断。
            const dynamicEntryKeys = new Set<string>()
            let dynamicEntryFingerprintSource = ''
            for (const entry of entries) {
                if ((entry.type || 'prompt') !== 'prompt' || entry.role === 'system') {
                    continue
                }
                if (!this.hasDynamicPlaceholder(entry.content)) {
                    continue
                }
                for (const key of this.getReferencedPromptPlaceholders(entry.content)) {
                    if (DYNAMIC_PROMPT_PLACEHOLDERS.has(key)) {
                        dynamicEntryKeys.add(key)
                    }
                }
                // 用不可见分隔符（'\u0000'）连接各条内容：无分隔符时 ['AB','C'] 与 ['A','BC']
                // 拼接结果相同，指纹无法捕获条目边界变化；分隔符保证内容重新分布
                // （新增/删除/合并条目）也会改变聚合指纹。
                // LOW-3：role / fakeThought 也必须纳入指纹源——差分按值比较只覆盖 content，
                // 动态条目 role 从 user 改为 model、或伪造思考增删修改而 content 不变时，
                // 指纹不变 → 全部未变判定省略 → 模型持续看到旧 role/旧伪造思考。
                dynamicEntryFingerprintSource += `${entry.role}\u0000${entry.fakeThought ?? ''}\u0000${entry.content}\u0000`
            }
            const sectionValues = dynamicEntryKeys.size > 0
                ? this.buildDynamicPromptModules(
                    getGlobalSettingsManager()?.getContextAwarenessConfig(),
                    runtime,
                    dynamicEntryKeys
                )
                : {}
            const dynamicTemplateFingerprint = dynamicEntryFingerprintSource
                ? fingerprint(dynamicEntryFingerprintSource)
                : undefined

            for (let index = 0; index < entries.length; index++) {
                const entry = entries[index]
                if ((entry.type || 'prompt') !== 'prompt' || entry.role === 'system') {
                    continue
                }

                const role = this.entryRoleToContentRole(entry.role)
                if (role !== 'user' && role !== 'model') {
                    continue
                }

                // 差分基准指纹必须是聚合指纹（dynamicTemplateFingerprint）：diffBase.templateFingerprint
                // 存的就是聚合指纹，若按单条 entry 内容算指纹，多动态条目时永远与基准不相等，
                // 每次都会触发全量发送，差分功能失效。
                const text = this.renderPromptEntryContent(entry.content, runtime, options?.diffBase, sectionValues, dynamicTemplateFingerprint)
                if (!text.trim()) {
                    continue
                }

                const parts: ContentPart[] = [{ text }]
                // 伪造思考：assistant 条目配置了 fakeThought 时，在正文前附加 thought part。
                // 是否随请求回传由渠道 sendHistoryThoughts（发送历史思考内容）在发送侧控制，
                // 与真实历史思考的语义保持一致。
                if (role === 'model' && entry.fakeThought?.trim()) {
                    parts.unshift({ text: entry.fakeThought.trim(), thought: true })
                }

                const message: Content = {
                    role,
                    parts
                }
                const targetMessages = historyPlacement === 'entry' && index > chatHistoryIndex
                    ? afterHistoryMessages
                    : beforeHistoryMessages
                targetMessages.push(message)

                if (this.hasDynamicPlaceholder(entry.content)) {
                    // 快照消息用于 preserve 策略回插历史。保留完整 parts（含伪造思考）：
                    // 缓存层已能无损保存 thought part，回插时由 formatter 按渠道
                    // 「发送历史思考内容」开关统一过滤，与直发路径字节一致。
                    const targetSnapshotMessages = historyPlacement === 'entry' && index > chatHistoryIndex
                        ? dynamicSnapshotAfterHistoryMessages
                        : dynamicSnapshotBeforeHistoryMessages
                    targetSnapshotMessages.push(message)
                }
            }

            const messages = [...beforeHistoryMessages, ...afterHistoryMessages]
            const dynamicSnapshotMessages = [
                ...dynamicSnapshotBeforeHistoryMessages,
                ...dynamicSnapshotAfterHistoryMessages
            ]

            return {
                beforeHistoryMessages,
                afterHistoryMessages,
                dynamicSnapshotBeforeHistoryMessages,
                dynamicSnapshotAfterHistoryMessages,
                messages,
                dynamicSnapshotMessages,
                text: promptContextMessagesToText(messages),
                dynamicSnapshotText: promptContextMessagesToText(dynamicSnapshotMessages),
                historyPlacement,
                sectionValues,
                dynamicTemplateFingerprint
            }
        }

        const legacy = this.getLegacyDynamicContextMessages(modeSnapshot, runtime, options?.diffBase)
        const messages = legacy.messages
        const text = promptContextMessagesToText(messages)
        return {
            beforeHistoryMessages: messages,
            afterHistoryMessages: [],
            dynamicSnapshotBeforeHistoryMessages: messages,
            dynamicSnapshotAfterHistoryMessages: [],
            messages,
            dynamicSnapshotMessages: messages,
            text,
            dynamicSnapshotText: text,
            historyPlacement: 'legacy',
            sectionValues: legacy.sectionValues,
            dynamicTemplateFingerprint: legacy.templateFingerprint
        }
    }

    private getLegacyDynamicContextMessages(
        modeSnapshot?: ResolvedPromptModeSnapshot,
        runtime?: DynamicRuntimeContext,
        diffBase?: DynamicContextDiffBase
    ): { messages: Content[]; sectionValues: Record<string, string>; templateFingerprint?: string } {
        const settingsManager = getGlobalSettingsManager()
        const promptConfig = settingsManager?.getSystemPromptConfig()
        const contextConfig = settingsManager?.getContextAwarenessConfig()
        const resolvedMode = this.resolvePromptModeSnapshot(modeSnapshot)
        
        // 检查是否启用动态上下文模板（使用本次请求的模式快照）
        const dynamicTemplateEnabled = resolvedMode?.dynamicTemplateEnabled ?? promptConfig?.dynamicTemplateEnabled ?? true
        if (!dynamicTemplateEnabled) {
            return { messages: [], sectionValues: {}, templateFingerprint: undefined }
        }
        
        const dynamicTemplate = resolvedMode?.dynamicTemplate || promptConfig?.dynamicTemplate || ''
        if (dynamicTemplate.trim()) {
            const rendered = this.generateDynamicFromTemplate(dynamicTemplate, contextConfig, runtime, diffBase)
            if (rendered.content) {
                return {
                    messages: [{
                        role: 'user' as const,
                        parts: [{ text: rendered.content }]
                    }],
                    sectionValues: rendered.sectionValues,
                    templateFingerprint: rendered.templateFingerprint
                }
            }
            return {
                messages: [],
                sectionValues: rendered.sectionValues,
                templateFingerprint: rendered.templateFingerprint
            }
        }
        
        // 否则使用默认逻辑
        const sections: string[] = []
        const sectionValues: Record<string, string> = {}
        
        // 前缀说明
        sections.push('This is the current turn\'s dynamic context information you can use. It may change between turns. Continue with the previous task if the information is not needed and ignore it.')
        
        // 当前时间
        const now = new Date()
        sections.push(`Current Time: ${now.toISOString()}`)

        // TODO 列表（来自会话元数据）
        const todoText = formatTodoListText(runtime?.todoList)
        if (todoText) {
            sectionValues['TODO_LIST'] = this.wrapSection('TODO LIST', todoText)
            sections.push(sectionValues['TODO_LIST'])
        }

        // 工作区文件树
        if (contextConfig?.includeWorkspaceFiles ?? this.config.includeWorkspaceFiles) {
            const fileTreeContent = this.generateFileTreeSection(
                contextConfig?.maxFileDepth ?? this.config.maxDepth ?? 10,
                contextConfig?.ignorePatterns ?? []
            )
            if (fileTreeContent) {
                sectionValues['WORKSPACE_FILES'] = this.wrapSection('WORKSPACE FILES', fileTreeContent)
                sections.push(sectionValues['WORKSPACE_FILES'])
            }
        }
        
        // 打开的标签页
        if (contextConfig?.includeOpenTabs) {
            const openTabsContent = this.generateOpenTabsSection(
                contextConfig.maxOpenTabs,
                contextConfig.ignorePatterns || []
            )
            if (openTabsContent) {
                sectionValues['OPEN_TABS'] = this.wrapSection('OPEN TABS', openTabsContent)
                sections.push(sectionValues['OPEN_TABS'])
            }
        }
        
        // 当前活动编辑器
        if (contextConfig?.includeActiveEditor) {
            const activeEditorContent = this.generateActiveEditorSection(
                contextConfig.ignorePatterns || []
            )
            if (activeEditorContent) {
                sectionValues['ACTIVE_EDITOR'] = this.wrapSection('ACTIVE EDITOR', activeEditorContent)
                sections.push(sectionValues['ACTIVE_EDITOR'])
            }
        }
        
        // 诊断信息
        const diagnosticsContent = this.generateDiagnosticsSection()
        if (diagnosticsContent) {
            sectionValues['DIAGNOSTICS'] = this.wrapSection('DIAGNOSTICS', diagnosticsContent)
            sections.push(sectionValues['DIAGNOSTICS'])
        }
        
        // 固定文件内容
        const pinnedFilesContent = this.generatePinnedFilesSection(runtime?.pinnedFiles)
        if (pinnedFilesContent) {
            const sectionTitle = getGlobalSettingsManager()?.getPinnedFilesConfig()?.sectionTitle || 'PINNED FILES CONTENT'
            sectionValues['PINNED_FILES'] = this.wrapSection(sectionTitle, pinnedFilesContent)
            sections.push(sectionValues['PINNED_FILES'])
        }

        // 跨回合差分：与上一轮相同的 section 不发（preserve 回插的历史快照中仍可见）。
        // Current Time 不参与差分触发：有 section 变化时随消息一起发送，全部未变则整条省略。
        // 关键：对比「基准 key 集合 vs 当前 key 集合」——基准存在的 section 在当前消失
        // （清空，如 TODO 清空/标签全关/诊断清除）时必须发送，模型才能感知「不再存在」；
        // 否则剩余 section 未变时整条省略，模型持续持有过期快照（MEDIUM-2）。
        const sectionKeys = Object.keys(sectionValues)
        const baseKeys = diffBase?.sectionValues ? Object.keys(diffBase.sectionValues) : []
        const vanishedSection = baseKeys.some(key => !(key in sectionValues))
        let anySectionChanged = false
        for (const key of sectionKeys) {
            if (diffBase?.sectionValues?.[key] === sectionValues[key]) {
                const sectionIndex = sections.indexOf(sectionValues[key])
                if (sectionIndex >= 0) {
                    sections.splice(sectionIndex, 1)
                }
            } else {
                anySectionChanged = true
            }
        }
        if (vanishedSection) {
            anySectionChanged = true // section 消失本身即变化信号，不得整体省略
        }
        if (sectionKeys.length > 0 && !anySectionChanged) {
            return { messages: [], sectionValues, templateFingerprint: undefined }
        }
        
        // 返回单个动态上下文消息（清理多余空行）
        const content = this.cleanupEmptyLines(sections.join('\n\n'))
        return {
            messages: [{
                role: 'user' as const,
                parts: [{ text: content }]
            }],
            sectionValues,
            templateFingerprint: undefined
        }
    }
    
    /**
     * 获取动态上下文的纯文本内容
     * 
     * 用于 token 计数，返回实际填充后的动态内容
     * （包括文件树、标签页、诊断信息等的实际内容）
     * 
     * @returns 动态上下文的纯文本，如果没有内容则返回空字符串
     */
    getDynamicContextText(modeSnapshot?: ResolvedPromptModeSnapshot, runtime?: DynamicRuntimeContext): string {
        return this.getPromptContextBundle(modeSnapshot, runtime).text
    }
    
    /**
     * 获取用户语言环境
     *
     * 根据设置返回用户当前使用的语言
     * - 如果设置为 'auto'，使用 VS Code 的语言设置
     * - 否则使用用户选择的语言
     */
    private getUserLanguage(): string {
        return this.sections.getUserLanguage()
    }
    
    /**
     * 生成文件树段落
     */
    private generateFileTreeSection(maxDepth: number, ignorePatterns: string[]): string {
        return this.sections.generateFileTreeSection(maxDepth, ignorePatterns)
    }
    
    /**
     * 生成打开的标签页段落
     */
    private generateOpenTabsSection(maxTabs: number, ignorePatterns: string[]): string {
        return this.sections.generateOpenTabsSection(maxTabs, ignorePatterns)
    }
    
    /**
     * 生成当前活动编辑器段落
     */
    private generateActiveEditorSection(ignorePatterns: string[]): string {
        return this.sections.generateActiveEditorSection(ignorePatterns)
    }
    
    /**
     * 生成诊断信息段落
     *
     * 从 VSCode 获取工作区的诊断信息（错误、警告等）
     * 根据配置过滤严重程度和文件范围
     */
    private generateDiagnosticsSection(): string {
        return this.sections.generateDiagnosticsSection()
    }
    
    /**
     * 生成固定文件内容段落
     *
     * 按工作区过滤固定文件，支持多工作区场景
     * 支持会话级覆盖（runtimePinnedFiles）
     */
    private generatePinnedFilesSection(runtimePinnedFiles?: unknown): string {
        return this.sections.generatePinnedFilesSection(runtimePinnedFiles)
    }
    
    /**
     * 检查路径是否应该被忽略
     */
    private shouldIgnorePath(relativePath: string, ignorePatterns: string[]): boolean {
        return shouldIgnorePath(relativePath, ignorePatterns)
    }
    
    /**
     * 简单的 glob 模式匹配
     */
    private matchGlobPattern(path: string, pattern: string): boolean {
        return matchGlobPattern(path, pattern)
    }
    
    /**
     * 获取上下文信息
     */
    private getContext(): PromptContext {
        return this.sections.getContext()
    }
    
    /**
     * 获取操作系统信息
     */
    private getOSInfo(): string {
        return this.sections.getOSInfo()
    }
    
}

// 导出单例创建函数
let globalPromptManager: PromptManager | null = null

export function getPromptManager(): PromptManager {
    if (!globalPromptManager) {
        globalPromptManager = new PromptManager()
    }
    return globalPromptManager
}

export function setPromptManager(manager: PromptManager): void {
    globalPromptManager = manager
}
