import { PromptTemplateRenderer } from './PromptTemplateRenderer'
import { StaticPromptCache } from './staticPromptCache'
import type { DynamicRuntimeContext, PromptContextBundle, DynamicContextDiffBase, PromptAssemblyHost } from './promptAssemblyTypes'
export type { DynamicRuntimeContext, PromptContextBundle, DynamicContextDiffBase, PromptAssemblyHost } from './promptAssemblyTypes'

import { DYNAMIC_CONTEXT_PREAMBLE } from '../../../shared/defaultPromptTemplates'
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

import type { PromptConfig, PromptContext } from './types'
import type { Content, ContentPart } from '../conversation'

import type { ResolvedPromptModeSnapshot } from '../settings';
import { promptContextMessagesToText } from './promptContextCache'
import { DYNAMIC_PROMPT_PLACEHOLDERS } from './templatePlaceholders';
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

/** Host-independent preset renderer. Hosts supply context readers; assembly and caching are shared. */
export class PromptAssembler {
    private readonly renderer: PromptTemplateRenderer
    private config: PromptConfig
    /** 段落生成器（VSCode 副作用读取集中于此） */
    private readonly sections: PromptAssemblyHost['sections']
    
    constructor(private readonly host: PromptAssemblyHost, config: Partial<PromptConfig> = {},
        private readonly staticCache = new StaticPromptCache()) {
        this.sections = host.sections
        this.renderer = new PromptTemplateRenderer(host, () => this.config)
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
        this.staticCache.clear()
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

        const settingsManager = this.host.settings()
        return settingsManager?.resolvePromptMode()
    }

    private buildPromptCacheKey(modeSnapshot?: ResolvedPromptModeSnapshot, runtime?: DynamicRuntimeContext): string {
        const settingsManager = this.host.settings()
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
            this.host.workspacePaths()
                .sort()
                .join('\u0000')
        )
        const language = this.getUserLanguage()
        return `${resolvedMode?.id || 'default'}::${prefix}::${suffix}::template=${fingerprint(template)}`
            + `::memory=${memoryEnabled}::${memoryPrompt}::ws=${workspaceFingerprint}::lang=${language}`
            + `::host=${this.staticHostKey(template, runtime)}`
    }

    private staticHostKey(template: string, runtime?: DynamicRuntimeContext): string {
        // 平台静态段还受根目录名称/顺序、时区与工具权限影响，仅用工作区路径和设置值不足以共享。
        // 只读取模板实际引用的段落；角色宏虽不使用 {{$KEY}} 语法，也必须随当前角色变化。
        const macros = [...template.matchAll(/\{\{\s*(char|user|persona)\s*\}\}/gi)]
            .map(match => runtime?.characterMacros?.[match[1].toLowerCase()] ?? match[0])
        return JSON.stringify([
            template.includes('{{$ENVIRONMENT}}') ? this.sections.generateStaticEnvironmentSection() : null,
            template.includes('{{$MEMORY}}') ? this.sections.generateMemorySection() : null,
            template.includes('{{$CONTEXT_BADGE_FORMAT}}') ? this.sections.generateContextBadgeFormatSection() : null,
            macros,
        ])
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
    private buildEntriesStaticCacheKey(mode?: ResolvedPromptModeSnapshot, runtime?: DynamicRuntimeContext): string | null {
        if (!this.renderer.usesPromptEntries(mode)) {
            return null
        }
        const entries = this.renderer.getEnabledPromptEntries(mode)
            .filter(entry => (entry.type || 'prompt') === 'prompt')
            .filter(entry => entry.role === 'system' && entry.content.trim() !== '{{$WORLDBOOK_DEPTH}}')
        if (entries.some(entry => this.renderer.hasDynamicPlaceholder(entry.content))) {
            return null
        }
        const contentFingerprint = fingerprint(
            entries.map(entry => `${entry.order ?? 0}\u0000${entry.content}`).join('\u0001')
        )
        let key = `${mode?.id || 'default'}::entries::${contentFingerprint}`
        const referencesEnvironment = entries.some(entry => entry.content.includes('{{$ENVIRONMENT}}'))
        const referencesMemory = entries.some(entry => entry.content.includes('{{$MEMORY}}'))
        if (referencesEnvironment || referencesMemory) {
            const settingsManager = this.host.settings()
            if (referencesEnvironment) {
                const workspaceFingerprint = fingerprint(
                    this.host.workspacePaths()
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
        return `${key}::host=${this.staticHostKey(entries.map(entry => entry.content).join('\n'), runtime)}`
    }
    
    /**
     * 获取系统提示词（使用缓存）
     */
    getSystemPrompt(modeSnapshot?: ResolvedPromptModeSnapshot, forceRefresh: boolean = false, runtime?: DynamicRuntimeContext): string {
        const resolvedMode = this.resolvePromptModeSnapshot(modeSnapshot)
        const key = this.renderer.usesPromptEntries(resolvedMode)
            ? this.buildEntriesStaticCacheKey(resolvedMode, runtime)
            : this.buildPromptCacheKey(resolvedMode, runtime)
        // 动态条目继续使用本轮宿主；共享缓存仅保存已完整标识输入的静态结果。
        return key === null ? this.generatePrompt(resolvedMode, runtime)
            : this.staticCache.read(key, () => this.generatePrompt(resolvedMode, runtime), forceRefresh)
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
        const settingsManager = this.host.settings()
        const promptConfig = settingsManager?.getSystemPromptConfig()
        const resolvedMode = this.resolvePromptModeSnapshot(modeSnapshot)
        
        if (this.renderer.usesPromptEntries(resolvedMode)) {
            return this.renderer.getEnabledPromptEntries(resolvedMode)
                .filter(entry => (entry.type || 'prompt') === 'prompt')
                .filter(entry => entry.role === 'system' && entry.content.trim() !== '{{$WORLDBOOK_DEPTH}}')
                .map(entry => this.renderer.renderPromptEntryContent(entry.content, runtime))
                .filter(Boolean)
                .join('\n\n')
        }

        // 请求运行时必须显式使用本次解析出的模式快照，不能依赖全局当前模式。
        const template = resolvedMode?.template ?? promptConfig?.template ?? ''
        return this.renderer.generateFromTemplate(template, promptConfig?.customPrefix || '', promptConfig?.customSuffix || '', runtime)
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

    /**
     * 生成记忆系统的使用说明。
     *
     * 优先从用户设置中读取自定义提示词（limcode.toolsConfig.memory.systemPrompt），
     * 否则使用内置默认值。
     */
    private generateMemorySection(): string {
        return this.sections.generateMemorySection()
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

        if (this.renderer.usesPromptEntries(resolvedMode)) {
            const beforeHistoryMessages: Content[] = []
            const afterHistoryMessages: Content[] = []
            const dynamicSnapshotBeforeHistoryMessages: Content[] = []
            const dynamicSnapshotAfterHistoryMessages: Content[] = []
            const entries = this.renderer.getEnabledPromptEntries(resolvedMode)
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
                if (!this.renderer.hasDynamicPlaceholder(entry.content)) {
                    continue
                }
                for (const key of this.renderer.getReferencedPromptPlaceholders(entry.content)) {
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
                ? this.renderer.buildDynamicPromptModules(
                    this.host.settings()?.getContextAwarenessConfig(),
                    runtime,
                    dynamicEntryKeys
                )
                : {}
            const dynamicTemplateFingerprint = dynamicEntryFingerprintSource
                ? fingerprint(dynamicEntryFingerprintSource)
                : undefined

            for (let index = 0; index < entries.length; index++) {
                const entry = entries[index]
                if (entry.content.trim() === '{{$WORLDBOOK_DEPTH}}') {
                    const injections = runtime?.characterInjections ?? []
                    beforeHistoryMessages.push(...injections)
                    dynamicSnapshotBeforeHistoryMessages.push(...injections)
                    continue
                }
                if ((entry.type || 'prompt') !== 'prompt' || entry.role === 'system') {
                    continue
                }

                const role = this.renderer.entryRoleToContentRole(entry.role)
                if (role !== 'user' && role !== 'model') {
                    continue
                }

                // 差分基准指纹必须是聚合指纹（dynamicTemplateFingerprint）：diffBase.templateFingerprint
                // 存的就是聚合指纹，若按单条 entry 内容算指纹，多动态条目时永远与基准不相等，
                // 每次都会触发全量发送，差分功能失效。
                const text = this.renderer.renderPromptEntryContent(entry.content, runtime, options?.diffBase, sectionValues, dynamicTemplateFingerprint)
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

                if (this.renderer.hasDynamicPlaceholder(entry.content)) {
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
        const settingsManager = this.host.settings()
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
            const rendered = this.renderer.generateDynamicFromTemplate(dynamicTemplate, contextConfig, runtime, diffBase)
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
        
        // 前缀说明（与默认动态模板同一句）
        sections.push(DYNAMIC_CONTEXT_PREAMBLE)
        
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
            const sectionTitle = this.host.settings()?.getPinnedFilesConfig()?.sectionTitle || 'PINNED FILES CONTENT'
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
    
}
