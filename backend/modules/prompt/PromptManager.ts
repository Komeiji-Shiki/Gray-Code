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
 */

import * as vscode from 'vscode'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import type { PromptConfig, PromptContext } from './types'
import type { Content, ContentPart } from '../conversation/types'
import { getWorkspaceFileTree, getWorkspaceFolderByUri, getWorkspaceRoot, getAllWorkspaces } from './fileTree'
import { getGlobalSettingsManager } from '../../core/settingsContext'
import type { PinnedFileItem, PromptEntry, PromptEntryRole, ResolvedPromptModeSnapshot } from '../settings'
import { promptContextMessagesToText } from './promptContextCache'
import { globPatternToRegExp } from './glob'

type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
type NormalizedTodoItem = { id: string; content: string; status: TodoStatus }

export type DynamicRuntimeContext = {
    /** ConversationMetadata.custom['todoList'] */
    todoList?: unknown

    /** ConversationMetadata.custom['inputPinnedFiles'] */
    pinnedFiles?: unknown

    /** ConversationMetadata.custom['inputSkills'] */
    skills?: unknown

    /** 当前对话绑定的工作区 URI（ConversationMetadata.workspaceUri）；未绑定则不限定 */
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

const DYNAMIC_PROMPT_PLACEHOLDERS = new Set([
    'TODO_LIST',
    'WORKSPACE_FILES',
    'OPEN_TABS',
    'ACTIVE_EDITOR',
    'DIAGNOSTICS',
    'PINNED_FILES',
    'SKILLS'
])

// ========== 模板占位符替换（单次扫描 + 回调查表） ==========
// 三处替换（generateFromTemplate / generateDynamicFromTemplate / renderPromptTemplateContent）
// 原先各自 for 循环逐键 new RegExp + replace，为 O(占位符数 × 模板长度) 的重复全串扫描；
// 合并为单个交替正则单次扫描，正则源模块级预编译（键集合固定为全部已知占位符）。
// 替换器用函数式 () => value 而非字符串替换值：JS replace 的替换字符串中
// $&/$`/$'/$$/$n 是特殊序列，值含这些字符（工作区路径/shell 脚本/自定义记忆提示词等）
// 会被静默改写（04 批 MEDIUM），函数式替换器天然规避。
const PROMPT_PLACEHOLDER_KEYS = [
    'ENVIRONMENT',
    'CONTEXT_BADGE_FORMAT',
    'TODO_LIST',
    'WORKSPACE_FILES',
    'OPEN_TABS',
    'ACTIVE_EDITOR',
    'DIAGNOSTICS',
    'PINNED_FILES',
    'SKILLS',
    'MEMORY',
    'TOOLS',
    'MCP_TOOLS'
] as const

/** 预编译的占位符交替正则：匹配 {{$KEY}}（KEY ∈ PROMPT_PLACEHOLDER_KEYS，均为 [A-Z_]+，无正则元字符） */
const PROMPT_PLACEHOLDER_REGEX = new RegExp(`\\{\\{\\$(?:${PROMPT_PLACEHOLDER_KEYS.join('|')})\\}\\}`, 'g')

// ========== 固定文件读取预算与缓存（热路径：每条消息都会组装动态上下文） ==========
//
// 调用链 getPromptContextBundle -> getLegacyDynamicContextMessages -> buildDynamicPromptModules
// -> generatePinnedFilesSection 全部为同步签名（ToolIterationLoopService / ContextTrimService /
// SettingsHandler 在同步位置调用），无法直接异步化，因此采用「TTL 缓存 + mtime 失效 + 大小限制」
// 的最小同步方案：
// - TTL 内零磁盘 I/O（不 stat、不 read）
// - TTL 过期后仅 stat 校验 mtime，未变更则复用缓存内容，变更才重读
// - 单文件超过 PINNED_FILE_MAX_BYTES 只读取前 N 字节并标记截断
// - 全部固定文件累计读取超过 PINNED_FILE_MAX_TOTAL_BYTES 时跳过剩余文件

/** 单文件大小上限（字节）：超过则只读取前 N 字节并标记截断 */
export const PINNED_FILE_MAX_BYTES = 1024 * 1024 // 1MB

/** 单次生成累计读取字节上限（字节）：超过则跳过剩余固定文件 */
export const PINNED_FILE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 // 2MB

/** 固定文件内容缓存 TTL（毫秒） */
export const PINNED_FILE_CACHE_TTL_MS = 5000

interface PinnedFileCacheEntry {
    content: string
    mtimeMs: number
    bytesRead: number
    truncated: boolean
    checkedAt: number
}

/** 固定文件内容缓存：key=绝对路径；TTL + mtime 双失效 */
const pinnedFileCache = new Map<string, PinnedFileCacheEntry>()

/** 固定文件内容缓存条目数上限（超出后按 LRU 淘汰最久未访问条目） */
export const PINNED_FILE_CACHE_MAX_ENTRIES = 32

/** 固定文件内容缓存累计内容字节预算（超出后继续淘汰最久未访问条目直到达标） */
export const PINNED_FILE_CACHE_MAX_TOTAL_BYTES = 16 * 1024 * 1024 // 16MB

/**
 * 写入固定文件缓存并执行 LRU 淘汰：
 * - 条目数超过 PINNED_FILE_CACHE_MAX_ENTRIES 时淘汰最久未访问（Map 头部）的条目
 * - 累计内容字节超过 PINNED_FILE_CACHE_MAX_TOTAL_BYTES 时继续淘汰直到达标
 */
function setPinnedFileCache(fullPath: string, entry: PinnedFileCacheEntry): void {
    pinnedFileCache.delete(fullPath)
    pinnedFileCache.set(fullPath, entry)
    let totalBytes = 0
    for (const [, cached] of pinnedFileCache) {
        totalBytes += cached.bytesRead
    }
    while (
        pinnedFileCache.size > PINNED_FILE_CACHE_MAX_ENTRIES ||
        totalBytes > PINNED_FILE_CACHE_MAX_TOTAL_BYTES
    ) {
        const oldestKey = pinnedFileCache.keys().next().value as string | undefined
        if (oldestKey === undefined) {
            break
        }
        const evicted = pinnedFileCache.get(oldestKey)
        pinnedFileCache.delete(oldestKey)
        if (evicted) {
            totalBytes -= evicted.bytesRead
        }
    }
}

/** 触碰缓存条目刷新 LRU 顺序（移到 Map 尾部 = 最近访问） */
function touchPinnedFileCache(fullPath: string): void {
    const cached = pinnedFileCache.get(fullPath)
    if (cached) {
        pinnedFileCache.delete(fullPath)
        pinnedFileCache.set(fullPath, cached)
    }
}

/**
 * 读取固定文件内容并应用单文件大小上限：
 * 小文件整体读取；大文件只读取前 PINNED_FILE_MAX_BYTES 字节（不把整文件载入内存）。
 */
function readPinnedFileCapped(fullPath: string, statSize: number): { content: string; bytesRead: number; truncated: boolean } {
    if (statSize <= PINNED_FILE_MAX_BYTES) {
        const content = fs.readFileSync(fullPath, 'utf-8')
        return { content, bytesRead: statSize, truncated: false }
    }

    const fd = fs.openSync(fullPath, 'r')
    try {
        const buffer = Buffer.alloc(PINNED_FILE_MAX_BYTES)
        const bytesRead = fs.readSync(fd, buffer, 0, PINNED_FILE_MAX_BYTES, 0)
        // 去掉被切断的多字节 UTF-8 字符留下的孤立 U+FFFD
        const content = buffer.subarray(0, bytesRead).toString('utf-8').replace(/[\uFFFD]{1,3}$/, '')
        return { content, bytesRead: Math.min(statSize, PINNED_FILE_MAX_BYTES), truncated: true }
    } finally {
        fs.closeSync(fd)
    }
}

// ========== 忽略模式正则缓存（matchGlobPattern 每文件×每模式重复 new RegExp 的修复） ==========
// 模块级缓存：key=原始模式，flags 固定为 'i'（与旧实现一致，注意大小写/标志一致性）；
// 大工作区下每条消息可省去大量重复编译。
const ignorePatternRegexCache = new Map<string, RegExp>()
let ignorePatternRegexCompileCount = 0
let ignorePatternRegexHitCount = 0

/** 获取忽略模式正则缓存的统计（供测试断言编译次数） */
export function getGlobIgnoreRegexCacheStats(): { compiles: number; hits: number; size: number } {
    return { compiles: ignorePatternRegexCompileCount, hits: ignorePatternRegexHitCount, size: ignorePatternRegexCache.size }
}

function isTodoStatus(value: unknown): value is TodoStatus {
    return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'cancelled'
}

function normalizeTodoList(raw: unknown): NormalizedTodoItem[] {
    if (!Array.isArray(raw)) return []
    const out: NormalizedTodoItem[] = []
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const id = (item as any).id
        const content = (item as any).content
        const status = (item as any).status
        if (typeof id !== 'string' || !id.trim()) continue
        if (typeof content !== 'string') continue
        if (!isTodoStatus(status)) continue
        out.push({ id: id.trim(), content, status })
    }
    return out
}

function truncateText(s: string, maxLen: number): string {
    const t = (s ?? '').replace(/\s+/g, ' ').trim()
    if (t.length <= maxLen) return t
    return t.slice(0, Math.max(0, maxLen - 1)) + '…'
}

/**
 * 轻量字符串指纹（FNV-1a 32 位 + 长度前缀）。
 * 用于把模板文本嵌入系统提示词缓存键：模板可能很长，直接拼原文会让 key 巨大；
 * 长度先筛掉绝大多数差异，哈希兜底区分等长但内容不同的模板。
 */
function fingerprint(s: string): string {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
    }
    return `${s.length}:${(h >>> 0).toString(36)}`
}

function formatTodoListText(raw: unknown): string {
    const todos = normalizeTodoList(raw)
    if (todos.length === 0) return ''

    const order: Record<TodoStatus, number> = {
        in_progress: 0,
        pending: 1,
        completed: 2,
        cancelled: 3
    }
    const sorted = [...todos].sort((a, b) => {
        const oa = order[a.status] ?? 9
        const ob = order[b.status] ?? 9
        if (oa !== ob) return oa - ob
        return a.id.localeCompare(b.id)
    })

    const counts: Record<TodoStatus, number> = {
        pending: 0,
        in_progress: 0,
        completed: 0,
        cancelled: 0
    }
    for (const t of todos) counts[t.status]++

    const MAX_ITEMS = 50
    const shown = sorted.slice(0, MAX_ITEMS)

    const lines: string[] = []
    lines.push(
        `Total: ${todos.length} | pending: ${counts.pending} | in_progress: ${counts.in_progress} | completed: ${counts.completed} | cancelled: ${counts.cancelled}`
    )
    for (const t of shown) {
        const content = truncateText(t.content, 200)
        lines.push(`- [${t.status}] ${content}  \`#${t.id}\``)
    }
    if (sorted.length > shown.length) {
        lines.push(`... and ${sorted.length - shown.length} more items.`)
    }

    return lines.join('\n')
}

function normalizePinnedFiles(raw: unknown): PinnedFileItem[] {
    if (!Array.isArray(raw)) return []
    return raw
        .filter((item): item is PinnedFileItem => (
            !!item
            && typeof (item as any).id === 'string'
            && typeof (item as any).path === 'string'
            && typeof (item as any).workspaceUri === 'string'
            && typeof (item as any).enabled === 'boolean'
            && typeof (item as any).addedAt === 'number'
        ))
        .map(item => ({ ...item }))
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

    private buildPromptCacheKey(modeSnapshot?: ResolvedPromptModeSnapshot, runtime?: DynamicRuntimeContext): string {
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
        // 缓存键含工作区指纹：ENVIRONMENT 等内容依赖工作区/渲染语言，
        // 切换工作区/语言后必须换键，60s TTL 内不会返回旧 ENVIRONMENT。
        // 语言优先取用户设置（getUserLanguage() 解析 'auto' 为 vscode.env.language），
        // 与渲染侧保持一致（两者不一致、TTL 内会返回旧语言提示词，修复 LOW 级）。
        const workspaceFingerprint = fingerprint(
            (vscode.workspace.workspaceFolders || [])
                .map(f => f.uri.fsPath)
                .sort()
                .join('\u0000')
        )
        const language = this.getUserLanguage()
        // 对话绑定工作区（fork 多工作区语义）：会话 A/B 绑不同工作区时 ENVIRONMENT
        // 内容不同（Current Workspace 行），键必须含绑定 URI，否则共享缓存会把
        // 会话 A 的提示词泄漏到会话 B 的缓存提示词。
        const workspacePart = runtime?.workspaceUri ?? ''
        return `${resolvedMode?.id || 'default'}::${prefix}::${suffix}::template=${fingerprint(template)}::memory=${memoryEnabled}::${memoryPrompt}::ws=${workspaceFingerprint}::lang=${language}::wsUri=${workspacePart}`
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
        const cacheKey = this.buildPromptCacheKey(modeSnapshot, runtime)
        
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
        const template = resolvedMode?.template || promptConfig?.template || ''
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
            'ENVIRONMENT': this.wrapSection('ENVIRONMENT', this.generateStaticEnvironmentSection(runtime)),
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
                contextConfig?.ignorePatterns ?? [],
                runtime
            )
            if (fileTreeContent) {
                modules['WORKSPACE_FILES'] = this.wrapSection('WORKSPACE FILES', fileTreeContent)
            }
        }
        
        // 打开的标签页
        if (shouldBuild('OPEN_TABS') && contextConfig?.includeOpenTabs) {
            const openTabsContent = this.generateOpenTabsSection(
                contextConfig.maxOpenTabs,
                contextConfig.ignorePatterns || [],
                runtime?.workspaceUri
            )
            if (openTabsContent) {
                modules['OPEN_TABS'] = this.wrapSection('OPEN TABS', openTabsContent)
            }
        }
        
        // 当前活动编辑器
        if (shouldBuild('ACTIVE_EDITOR') && contextConfig?.includeActiveEditor) {
            const activeEditorContent = this.generateActiveEditorSection(
                contextConfig.ignorePatterns || [],
                runtime?.workspaceUri
            )
            if (activeEditorContent) {
                modules['ACTIVE_EDITOR'] = this.wrapSection('ACTIVE EDITOR', activeEditorContent)
            }
        }
        
        // 诊断信息
        if (shouldBuild('DIAGNOSTICS')) {
            const diagnosticsContent = this.generateDiagnosticsSection(runtime?.workspaceUri)
            if (diagnosticsContent) {
                modules['DIAGNOSTICS'] = this.wrapSection('DIAGNOSTICS', diagnosticsContent)
            }
        }
        
        // 固定文件内容
        if (shouldBuild('PINNED_FILES')) {
            const pinnedFilesContent = this.generatePinnedFilesSection(runtime?.pinnedFiles, runtime?.workspaceUri)
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
        if (!content) return ''
        return `====\n\n${title}\n\n${content}`
    }
    
    /**
     * 清理文本中的多余空行
     * 
     * 将连续 3 个或以上的换行符压缩为 2 个
     */
    private cleanupEmptyLines(text: string): string {
        return text.replace(/\n{3,}/g, '\n\n').trim()
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
    private generateStaticEnvironmentSection(runtime?: DynamicRuntimeContext): string {
        const context = this.getContext()
        const lines: string[] = []
        
        // 工作区信息（支持多工作区）
        const targetFolder = runtime?.workspaceUri ? getWorkspaceFolderByUri(runtime.workspaceUri) : undefined
        if (runtime?.workspaceUri) {
            // 对话绑定工作区：只显示该工作区；文件夹已关闭时不泄漏其他工作区
            if (targetFolder) {
                lines.push(`Current Workspace: ${targetFolder.uri.fsPath}`)
            } else {
                lines.push('No workspace open')
            }
        } else {
            const workspaces = getAllWorkspaces()
            if (workspaces.length === 0) {
                lines.push('No workspace open')
            } else if (workspaces.length === 1) {
                lines.push(`Current Workspace: ${workspaces[0].fsPath}`)
            } else {
                lines.push('Multi-root Workspace:')
                for (const ws of workspaces) {
                    lines.push(`  - ${ws.name}: ${ws.fsPath}`)
                }
                lines.push('')
                lines.push('Use "workspace_name/path" format to access files in specific workspace.')
            }
        }
        
        if (context.os) {
            lines.push(`Operating System: ${context.os}`)
        }
        
        if (context.timezone) {
            lines.push(`Timezone: ${context.timezone}`)
        }
        
        // User language environment
        const userLanguage = this.getUserLanguage()
        if (userLanguage) {
            lines.push(`User Language: ${userLanguage}`)
            lines.push(`Please respond using the user's language by default.`)
        }
        
        return lines.join('\n')
    }

    /**
     * 生成 lim-context 徽章结构说明（静态）
     *
     * 目的：让模型明确区分“标题属性”和“正文内容”，
     * 避免把 binary 徽章按文本内容解析。
     */
    private generateContextBadgeFormatSection(): string {
        // 修改原因：旧示例使用了 "新建文件夹 (10).zip" 这种看起来像真实用户文件的名称，
        //          导致模型在 system prompt 中看到后误以为用户实际附加了该文件。
        // 修改方式：改用明显虚构的 "example-report.pdf"，并标注 "(example)"。
        return [
            'Context chips are serialized inline with this XML-like structure (example):',
            '<lim-context type="file" path="example-report.pdf" binary="true" title="example-report.pdf (example)">',
            '',
            '</lim-context>',
            '',
            'Field meanings:',
            '- type: context kind (file | text | snippet).',
            '- path: source file path (usually workspace-relative) when type="file".',
            '- title: chip display title shown to users. This is the title, NOT the body content.',
            '- binary="true": indicates non-text/binary attachment context. In this case, the tag body is intentionally empty and must NOT be parsed as text content.',
            '',
            'Important parsing rules:',
            '- The BODY content is only the text between opening/closing tags.',
            '- The TITLE is only the title attribute value.',
            '- If binary="true", treat this block as a structural reference/attachment marker only; do not try to summarize or infer textual body from title/path/file name.'
        ].join('\n')
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
        const settingsManager = getGlobalSettingsManager();
        const memoryConfig = settingsManager?.getMemoryConfig?.();
        if (memoryConfig?.enabled === false) {
            return '';
        }
        const userPrompt = typeof memoryConfig?.systemPrompt === 'string' ? memoryConfig.systemPrompt.trim() : '';

        if (userPrompt) {
            return this.wrapSection('MEMORY', userPrompt);
        }

        // 默认内置提示词
        const defaultPrompt = [
            '启动时必须主动激活记忆',
            '',
            '在每次会话中，在进行任何其他工具调用之前运行 memory_wake，然后严格按照其提示执行，直到一切结束。',
            '',
            '记忆包含两部分：全局记忆（所有工作区共享）与当前工作区记忆（按工作区隔离），memory_wake 会同时输出两者，注意区分 --- Global memory --- 与 --- Workspace memory --- 标注；记录新记忆时 memory_note 默认写入当前工作区的记忆存储。',
            '',
            '工作期间可主动记录记忆',
            '',
            '当你学到新东西，或发生值得保留的事情时，调用 memory_note。',
            '',
            '这包括你受到的大的启发，对效率有大幅提升的发现、用户教给你的事实或见解、你了解到的关于他们生活的任何信息，以及任何具有持久影响的事件。',
            '',
            '记忆笔记应始终是持久的：对未来的会话仍然有用，可能用于完全不相关的任务。如果一条笔记只在当前任务结束前有用 → 不要记录。',
            '',
            '绝不记录：',
            '- 工作日志：已完成的任务、已完成的轮次、提交、推送、已运行的验证。Git 历史已包含所有这些。',
            '- 临时状态：当前进度、后续步骤、你暂存了哪些文件。',
            '- 仅限单次任务的操作规则，对未来会话无用。',
            '',
            '如有疑问，不要记录。几条精炼的记忆胜过嘈杂的日志。',
            '',
            '不要记录冗余的记忆。',
            '',
            '如果 memory_note 或 memory_wake 要求压缩：在你进行下一步操作之前执行 memory_compress。',
            '',
        ].join('\n');

        return this.wrapSection('MEMORY', defaultPrompt);
    }


    private getReferencedPromptPlaceholders(template: string): Set<string> {
        const keys = new Set<string>()
        const regex = /\{\{\$([A-Z_]+)\}\}/g
        let match: RegExpExecArray | null
        while ((match = regex.exec(template)) !== null) {
            keys.add(match[1])
        }
        return keys
    }

    /**
     * 用查表替换模板中的 {{$KEY}} 占位符（单次交替正则扫描，见模块级 PROMPT_PLACEHOLDER_REGEX）。
     * 函数式替换器 () => value 天然规避 JS replace 替换字符串的 $&/$`/$'/$$/$n 特殊序列展开
     * （值可能来自工作区路径/固定文件内容/用户记忆提示词等不可信内容）。
     * 查表未命中的占位符保持原样（与旧逐键替换行为一致）。
     */
    private replacePromptPlaceholders(template: string, modules: Record<string, string>): string {
        return template.replace(PROMPT_PLACEHOLDER_REGEX, (placeholder) => {
            const key = placeholder.slice(3, -2) // 去掉 '{{$' 前缀与 '}}' 后缀
            const value = modules[key]
            return typeof value === 'string' ? value : placeholder
        })
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
            modules['ENVIRONMENT'] = this.wrapSection('ENVIRONMENT', this.generateStaticEnvironmentSection(runtime))
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
        Object.assign(
            modules,
            this.applySectionDiff(
                prebuiltModules ?? this.buildDynamicPromptModules(contextConfig, runtime, referencedKeys),
                diffBase,
                templateFingerprintOverride ?? fingerprint(template)
            )
        )

        const result = this.replacePromptPlaceholders(template, modules)

        return this.cleanupEmptyLines(result)
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
                contextConfig?.ignorePatterns ?? [],
                runtime
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
                contextConfig.ignorePatterns || [],
                runtime?.workspaceUri
            )
            if (openTabsContent) {
                sectionValues['OPEN_TABS'] = this.wrapSection('OPEN TABS', openTabsContent)
                sections.push(sectionValues['OPEN_TABS'])
            }
        }
        
        // 当前活动编辑器
        if (contextConfig?.includeActiveEditor) {
            const activeEditorContent = this.generateActiveEditorSection(
                contextConfig.ignorePatterns || [],
                runtime?.workspaceUri
            )
            if (activeEditorContent) {
                sectionValues['ACTIVE_EDITOR'] = this.wrapSection('ACTIVE EDITOR', activeEditorContent)
                sections.push(sectionValues['ACTIVE_EDITOR'])
            }
        }
        
        // 诊断信息
        const diagnosticsContent = this.generateDiagnosticsSection(runtime?.workspaceUri)
        if (diagnosticsContent) {
            sectionValues['DIAGNOSTICS'] = this.wrapSection('DIAGNOSTICS', diagnosticsContent)
            sections.push(sectionValues['DIAGNOSTICS'])
        }
        
        // 固定文件内容
        const pinnedFilesContent = this.generatePinnedFilesSection(runtime?.pinnedFiles, runtime?.workspaceUri)
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
        const settingsManager = getGlobalSettingsManager()
        const uiSettings = settingsManager?.getUISettings()
        const languageSetting = uiSettings?.language || 'auto'
        
        if (languageSetting === 'auto') {
            // 使用 VS Code 的语言设置
            return vscode.env.language || 'en'
        }
        
        return languageSetting
    }
    
    /**
     * 生成文件树段落
     */
    private generateFileTreeSection(maxDepth: number, ignorePatterns: string[], runtime?: DynamicRuntimeContext): string {
        const effectiveMaxDepth = maxDepth === -1 ? 100 : maxDepth  // -1 表示无限制，使用大值代替
        const fileTree = getWorkspaceFileTree(effectiveMaxDepth, ignorePatterns, undefined, runtime?.workspaceUri)
        
        if (!fileTree) {
            return ''
        }
        
        return `The following is a list of files in the current workspace:\n\n${fileTree}`
    }
    
    /**
     * 生成打开的标签页段落
     */
    private generateOpenTabsSection(maxTabs: number, ignorePatterns: string[], workspaceUri?: string): string {
        const workspaceFolders = vscode.workspace.workspaceFolders
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return ''
        }
        
        const tabs: string[] = []
        
        // 遍历所有 tab groups
        for (const tabGroup of vscode.window.tabGroups.all) {
            for (const tab of tabGroup.tabs) {
                // 只处理文件类型的 tab
                if (tab.input instanceof vscode.TabInputText) {
                    const uri = tab.input.uri
                    
                    // 检查是否在工作区内
                    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)
                    // 绑定工作区时：不在任何工作区内的标签页跳过，非绑定工作区的标签页跳过
                    if (workspaceUri && (!workspaceFolder || workspaceFolder.uri.toString() !== workspaceUri)) {
                        continue
                    }
                    if (workspaceFolder) {
                        // 获取相对路径
                        const relativePath = vscode.workspace.asRelativePath(uri, false)
                        
                        // 检查是否应该被忽略
                        if (!this.shouldIgnorePath(relativePath, ignorePatterns)) {
                            tabs.push(relativePath)
                        }
                    }
                }
            }
        }
        
        // 去重
        const uniqueTabs = [...new Set(tabs)]
        
        // 应用最大数量限制
        const effectiveMaxTabs = maxTabs === -1 ? uniqueTabs.length : maxTabs
        const limitedTabs = uniqueTabs.slice(0, effectiveMaxTabs)
        
        if (limitedTabs.length === 0) {
            return ''
        }
        
        let result = `Currently open files in editor:\n`
        for (const tab of limitedTabs) {
            result += `  - ${tab}\n`
        }
        
        if (uniqueTabs.length > limitedTabs.length) {
            result += `  ... and ${uniqueTabs.length - limitedTabs.length} more files`
        }
        
        return result
    }
    
    /**
     * 生成当前活动编辑器段落
     */
    private generateActiveEditorSection(ignorePatterns: string[], workspaceUri?: string): string {
        const activeEditor = vscode.window.activeTextEditor
        if (!activeEditor) {
            return ''
        }
        
        const uri = activeEditor.document.uri
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)
        
        if (!workspaceFolder) {
            return ''
        }
        
        // 绑定工作区时只显示该工作区的活动编辑器
        if (workspaceUri && workspaceFolder.uri.toString() !== workspaceUri) {
            return ''
        }
        
        const relativePath = vscode.workspace.asRelativePath(uri, false)
        
        if (this.shouldIgnorePath(relativePath, ignorePatterns)) {
            return ''
        }
        
        return `Currently active file: ${relativePath}`
    }
    
    /**
     * 生成诊断信息段落
     *
     * 从 VSCode 获取工作区的诊断信息（错误、警告等）
     * 根据配置过滤严重程度和文件范围
     */
    private generateDiagnosticsSection(workspaceUri?: string): string {
        const settingsManager = getGlobalSettingsManager()
        if (!settingsManager) {
            return ''
        }
        
        const diagnosticsConfig = settingsManager.getDiagnosticsConfig()
        
        // 如果功能未启用，返回空
        if (!diagnosticsConfig.enabled) {
            return ''
        }
        
        const workspaceFolders = vscode.workspace.workspaceFolders
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return ''
        }
        
        // 获取所有诊断信息
        const allDiagnostics = vscode.languages.getDiagnostics()
        
        // 严重程度映射
        const severityMap: Record<vscode.DiagnosticSeverity, 'error' | 'warning' | 'information' | 'hint'> = {
            [vscode.DiagnosticSeverity.Error]: 'error',
            [vscode.DiagnosticSeverity.Warning]: 'warning',
            [vscode.DiagnosticSeverity.Information]: 'information',
            [vscode.DiagnosticSeverity.Hint]: 'hint'
        }
        
        // 严重程度显示名称
        const severityLabels: Record<string, string> = {
            'error': 'Error',
            'warning': 'Warning',
            'information': 'Info',
            'hint': 'Hint'
        }
        
        // 获取打开的文件 URI 列表（如果需要只显示打开文件的诊断）
        const openFileUris = new Set<string>()
        if (diagnosticsConfig.openFilesOnly) {
            for (const tabGroup of vscode.window.tabGroups.all) {
                for (const tab of tabGroup.tabs) {
                    if (tab.input instanceof vscode.TabInputText) {
                        openFileUris.add(tab.input.uri.toString())
                    }
                }
            }
        }
        
        const fileResults: string[] = []
        let fileCount = 0
        
        for (const [uri, diagnostics] of allDiagnostics) {
            // 检查文件数量限制
            if (diagnosticsConfig.maxFiles !== -1 && fileCount >= diagnosticsConfig.maxFiles) {
                break
            }
            
            // 检查是否在工作区内
            if (diagnosticsConfig.workspaceOnly) {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)
                if (!workspaceFolder) {
                    continue
                }
            }
            
            // 绑定工作区时只显示该工作区的诊断
            if (workspaceUri) {
                const wsFolder = vscode.workspace.getWorkspaceFolder(uri)
                if (!wsFolder || wsFolder.uri.toString() !== workspaceUri) {
                    continue
                }
            }
            
            // 如果只显示打开文件的诊断
            if (diagnosticsConfig.openFilesOnly && !openFileUris.has(uri.toString())) {
                continue
            }
            
            // 过滤诊断信息
            const filteredDiagnostics = diagnostics
                .filter(d => {
                    const severity = severityMap[d.severity]
                    return diagnosticsConfig.includeSeverities.includes(severity)
                })
                .slice(0, diagnosticsConfig.maxDiagnosticsPerFile === -1 ? undefined : diagnosticsConfig.maxDiagnosticsPerFile)
            
            if (filteredDiagnostics.length > 0) {
                const relativePath = vscode.workspace.asRelativePath(uri, false)
                const lines: string[] = []
                
                for (const d of filteredDiagnostics) {
                    const severity = severityMap[d.severity]
                    const severityLabel = severityLabels[severity]
                    const line = d.range.start.line + 1 // 转为 1-based 行号
                    const source = d.source ? ` (${d.source})` : ''
                    lines.push(`  Line ${line}: [${severityLabel}] ${d.message}${source}`)
                }
                
                fileResults.push(`${relativePath}:\n${lines.join('\n')}`)
                fileCount++
            }
        }
        
        // 即使没有任何诊断信息，也返回一段提示，告诉 AI 当前“所选严重程度”下没有报错/警告等。
        // 这样在 {{$DIAGNOSTICS}} 占位符处不会完全空白，AI 也能明确知道：
        // - 诊断功能已启用
        // - 当前过滤条件下没有发现问题
        const selectedSeverities = (diagnosticsConfig.includeSeverities || [])
            .map(s => severityLabels[s] || s)
            .join(', ')

        if (fileResults.length === 0) {
            const scopeDesc = diagnosticsConfig.openFilesOnly
                ? 'open files only'
                : (diagnosticsConfig.workspaceOnly ? 'workspace files only' : 'all files')

            return `No diagnostics were found in the workspace (scope: ${scopeDesc}, severities: ${selectedSeverities || 'none'}).`
        }
        
        return `The following diagnostics were found in the workspace:\n\n${fileResults.join('\n\n')}`
    }
    
    /**
     * 生成固定文件内容段落
     *
     * 按工作区过滤固定文件，支持多工作区场景
     * 支持会话级覆盖（runtimePinnedFiles）
     */
    private generatePinnedFilesSection(runtimePinnedFiles?: unknown, workspaceUri?: string): string {
        const settingsManager = getGlobalSettingsManager()
        if (!settingsManager) {
            return ''
        }
        
        const workspaceFolders = vscode.workspace.workspaceFolders
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return ''
        }

        const hasRuntimeOverride = runtimePinnedFiles !== undefined
        const runtimeFiles = hasRuntimeOverride ? normalizePinnedFiles(runtimePinnedFiles) : []
        const workspaceUriToFolder = new Map(workspaceFolders.map(folder => [folder.uri.toString(), folder]))
        const allPinnedFiles = (hasRuntimeOverride
            ? runtimeFiles.filter(file => file.enabled)
            : settingsManager.getEnabledPinnedFiles())
            // 绑定工作区时只显示该工作区的固定文件；旧数据无 workspaceUri 的固定文件视为任意工作区有效
            .filter(file => !workspaceUri || !file.workspaceUri || file.workspaceUri === workspaceUri)
        
        const results: string[] = []
        let totalBytes = 0
        
        for (const pinnedFile of allPinnedFiles) {
            // 预算已耗尽：剩余文件注定被跳过（emittedBytes > 0 时必超限），提前 break
            // 退出循环，避免继续为它们做缓存命中检查/stat/read（04 批 LOW：预算检查
            // 在读取之后执行，超限文件仍白做一次磁盘探测）。
            if (totalBytes >= PINNED_FILE_MAX_TOTAL_BYTES) {
                break
            }
            let workspaceFolder = pinnedFile.workspaceUri
                ? workspaceUriToFolder.get(pinnedFile.workspaceUri)
                : undefined;
            if (!workspaceFolder) {
                // 旧数据没有 workspaceUri（或目标文件夹已关闭）：回退绑定工作区 / 第一个文件夹
                workspaceFolder = workspaceUri
                    ? (getWorkspaceFolderByUri(workspaceUri) ?? undefined)
                    : workspaceFolders[0];
            }
            if (!workspaceFolder) {
                continue
            }

            try {
                const filePath = pinnedFile.path
                const fullPath = path.isAbsolute(filePath)
                    ? filePath
                    : path.join(workspaceFolder.uri.fsPath, filePath)

                const now = Date.now()
                const cached = pinnedFileCache.get(fullPath)
                let content: string
                let truncated: boolean

                if (cached && now - cached.checkedAt < PINNED_FILE_CACHE_TTL_MS) {
                    // TTL 内：零磁盘 I/O，直接复用缓存；不累计读取字节（发出字节仍计入总预算）
                    content = cached.content
                    truncated = cached.truncated
                    touchPinnedFileCache(fullPath)
                } else {
                    let stat: fs.Stats
                    try {
                        stat = fs.statSync(fullPath)
                    } catch {
                        // 文件不存在或不可访问（替代旧 existsSync + readFileSync 的探测）
                        pinnedFileCache.delete(fullPath)
                        continue
                    }

                    if (cached && cached.mtimeMs === stat.mtimeMs) {
                        // 未变更：只刷新检查时间，不重读磁盘；不累计读取字节（发出字节仍计入总预算）
                        cached.checkedAt = now
                        content = cached.content
                        truncated = cached.truncated
                        touchPinnedFileCache(fullPath)
                    } else {
                        const read = readPinnedFileCapped(fullPath, stat.size)
                        setPinnedFileCache(fullPath, {
                            content: read.content,
                            mtimeMs: stat.mtimeMs,
                            bytesRead: read.bytesRead,
                            truncated: read.truncated,
                            checkedAt: now
                        })
                        content = read.content
                        truncated = read.truncated
                    }
                }

                // 总字节预算：约束本轮实际发出的内容字节（含 TTL 缓存命中——缓存只省磁盘 I/O，
                // 发出内容仍占上下文预算），累计超限则跳过剩余文件。旧实现缓存命中不计字节，
                // 全部文件缓存后每轮发出内容可远超 2MB，预算形同虚设（04 批 LOW）。
                const emittedBytes = Buffer.byteLength(content, 'utf8')
                if (totalBytes + emittedBytes > PINNED_FILE_MAX_TOTAL_BYTES) {
                    console.warn(`[PromptManager] Skipping pinned file ${pinnedFile.path}: total pinned file bytes would exceed ${PINNED_FILE_MAX_TOTAL_BYTES}`)
                    continue
                }
                totalBytes += emittedBytes

                const displayPath = workspaceFolders.length > 1
                    ? `${workspaceFolder.name}/${pinnedFile.path}`
                    : pinnedFile.path

                results.push(`--- ${displayPath} ---\n${content}${truncated ? `\n[truncated: file exceeds ${PINNED_FILE_MAX_BYTES} bytes]` : ''}`)
            } catch (error: any) {
                console.warn(`Failed to read pinned file ${pinnedFile.path}:`, error.message)
            }
        }
        
        if (results.length === 0) {
            return ''
        }
        
        return `The following are pinned files that should be read and considered for every response:\n\n${results.join('\n\n')}`
    }
    
    /**
     * 检查路径是否应该被忽略
     */
    private shouldIgnorePath(relativePath: string, ignorePatterns: string[]): boolean {
        for (const pattern of ignorePatterns) {
            if (this.matchGlobPattern(relativePath, pattern)) {
                return true
            }
        }
        return false
    }
    
    /**
     * 简单的 glob 模式匹配
     */
    private matchGlobPattern(path: string, pattern: string): boolean {
        // 通配符展开语义见 glob.ts（gitignore 式：**/ 零段可选，* 不跨目录段）；
        // 先整体转义正则元字符（含 . [ ( + ? 等），避免用户配置含这些字符时 new RegExp 抛 SyntaxError。
        // 正则源由 pattern 确定性推导、flags 固定为 'i'，可按 pattern 缓存编译结果，避免重复编译。
        let regex = ignorePatternRegexCache.get(pattern)
        if (!regex) {
            const regexPattern = globPatternToRegExp(pattern)
            regex = new RegExp(`^${regexPattern}$|/${regexPattern}$|^${regexPattern}/|/${regexPattern}/`, 'i')
            ignorePatternRegexCompileCount++
            if (ignorePatternRegexCache.size >= 512) {
                ignorePatternRegexCache.clear()
            }
            ignorePatternRegexCache.set(pattern, regex)
        } else {
            ignorePatternRegexHitCount++
        }
        return regex.test(path.replace(/\\/g, '/'))
    }
    
    /**
     * 获取上下文信息
     */
    private getContext(): PromptContext {
        const now = new Date()
        
        return {
            workspaceRoot: getWorkspaceRoot(),
            currentTime: now.toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            os: this.getOSInfo()
        }
    }
    
    /**
     * 获取操作系统信息
     */
    private getOSInfo(): string {
        const platform = os.platform()
        const release = os.release()
        
        switch (platform) {
            case 'win32':
                return `Windows ${release}`
            case 'darwin':
                return `macOS ${release}`
            case 'linux':
                return `Linux ${release}`
            default:
                return `${platform} ${release}`
        }
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
