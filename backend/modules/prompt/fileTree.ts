/**
 * 文件目录树工具 - 获取工作区文件列表，支持 gitignore 排除
 *
 * 支持多工作区（Multi-root Workspaces）
 */

import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { globPatternToRegExp } from './glob'

// ========== 忽略模式正则缓存 ==========
// 原实现每文件×每模式重复 new RegExp（shouldIgnore 在两个位置各编译一次），
// 大工作区下每条消息都会产生大量重复编译。这里按 `${flags}\u0000${source}` 缓存编译结果；
// 注意 flags 必须进 key：自定义忽略模式用 'i'，gitignore 通配模式用 ''（保持与旧实现一致）。
const ignoreRegexCache = new Map<string, RegExp>()
let ignoreRegexCompileCount = 0
let ignoreRegexHitCount = 0

function getCachedIgnoreRegex(source: string, flags: string): RegExp {
    const key = `${flags}\u0000${source}`
    const cached = ignoreRegexCache.get(key)
    if (cached) {
        ignoreRegexHitCount++
        return cached
    }
    const regex = new RegExp(source, flags)
    ignoreRegexCompileCount++
    if (ignoreRegexCache.size >= 512) {
        ignoreRegexCache.clear()
    }
    ignoreRegexCache.set(key, regex)
    return regex
}

/** 获取忽略模式正则缓存的统计（供测试断言编译次数） */
export function getIgnoreRegexCacheStats(): { compiles: number; hits: number; size: number } {
    return { compiles: ignoreRegexCompileCount, hits: ignoreRegexHitCount, size: ignoreRegexCache.size }
}

/**
 * 工作区信息
 */
interface WorkspaceInfo {
    name: string;
    fsPath: string;
}

/**
 * .gitignore 解析结果缓存：key=绝对路径；mtime 未变化时复用解析结果，
 * 避免每条消息都同步 existsSync + readFileSync 重读同一文件。
 */
interface GitignoreCacheEntry {
    mtimeMs: number
    patterns: string[]
}

const gitignoreCache = new Map<string, GitignoreCacheEntry>()

/**
 * 解析 .gitignore 文件，返回排除规则
 */
function parseGitignore(gitignorePath: string): string[] {
    let stat: fs.Stats
    try {
        stat = fs.statSync(gitignorePath)
    } catch {
        // 文件不存在或不可访问（替代旧 existsSync 的探测）
        gitignoreCache.delete(gitignorePath)
        return []
    }

    // mtime 未变化：直接复用上次解析结果
    const cached = gitignoreCache.get(gitignorePath)
    if (cached && cached.mtimeMs === stat.mtimeMs) {
        return cached.patterns
    }

    const content = fs.readFileSync(gitignorePath, 'utf8')
    const lines = content.split('\n')
    const patterns: string[] = []
    
    for (const line of lines) {
        const trimmed = line.trim()
        // 跳过空行和注释
        if (!trimmed || trimmed.startsWith('#')) {
            continue
        }
        patterns.push(trimmed)
    }

    if (gitignoreCache.size >= 64) {
        gitignoreCache.clear()
    }
    gitignoreCache.set(gitignorePath, { mtimeMs: stat.mtimeMs, patterns })
    return patterns
}

/**
 * 单条 gitignore 模式匹配判断（提取自原 shouldIgnore 循环，语义一致）：
 * - 目录模式（/ 结尾）仅在目标是目录时命中
 * - / 开头为仓库根锚定模式
 * - 含 * 时按 gitignore 通配（* 不跨段、** 跨任意段且可匹配零个目录段）
 * - 否则按精确匹配（含父目录前缀匹配）
 */
function matchesGitignorePattern(relativePath: string, pattern: string, isDirectory: boolean): boolean {
    const baseName = path.basename(relativePath)
    let p = pattern

    // 处理目录模式（以 / 结尾）
    const isDirPattern = p.endsWith('/')
    if (isDirPattern) {
        p = p.slice(0, -1)
        if (!isDirectory) {
            return false
        }
    }

    // 处理以 / 开头的绝对路径模式
    const isAbsolute = p.startsWith('/')
    if (isAbsolute) {
        p = p.slice(1)
    }

    // 简单的模式匹配
    if (p.includes('*')) {
        // 通配符模式：gitignore 语义——* 不跨目录段、** 跨任意段且 **/ 零段可选
        const regex = getCachedIgnoreRegex('^' + globPatternToRegExp(p) + '$', '')
        return regex.test(baseName) || regex.test(relativePath.replace(/\\/g, '/'))
    }

    // 精确匹配 + 路径中包含该目录（startsWith(p + '/') 不再重复判断）
    if (baseName === p || relativePath === p || relativePath.includes('/' + p + '/') || relativePath.startsWith(p + '/')) {
        return true
    }
    return false
}

/**
 * 检查文件/目录是否应该被忽略
 *
 * gitignore 否定语义：支持 `!` 前缀（如 `*.log` + `!keep.log` 时 keep.log 重新包含）。
 * 采用「最后命中规则生效」求值：排除命中置 true，`!` 否定命中置 false。
 * 若某文件所在父目录已被排除，遍历时不会进入该目录，文件根本不会被求值——
 * 这与 git 的「不能重新包含被排除目录下的文件」语义天然一致。
 */
function shouldIgnore(relativePath: string, patterns: string[], isDirectory: boolean, customIgnorePatterns: string[] = []): boolean {
    const baseName = path.basename(relativePath)
    
    // 检查是否在自定义忽略列表中（从配置中获取；配置为明确排除，不支持否定）
    for (const ignore of customIgnorePatterns) {
        if (ignore.includes('*')) {
            // 通配符模式 - 支持 ** 匹配任意目录层级（gitignore 式：**/x 也匹配根级 x，* 不跨目录段）
            const regexStr = globPatternToRegExp(ignore)
            
            const regex = getCachedIgnoreRegex(`^${regexStr}$|/${regexStr}$|^${regexStr}/|/${regexStr}/`, 'i')
            if (regex.test(relativePath.replace(/\\/g, '/')) || regex.test(baseName)) {
                return true
            }
        } else if (baseName === ignore || relativePath === ignore) {
            return true
        }
    }
    
    // gitignore 规则
    if (patterns.some(p => p.startsWith('!'))) {
        // 存在 ! 否定规则：按 gitignore 语义完整求值（最后命中规则生效）
        let ignored = false
        for (const pattern of patterns) {
            if (pattern.startsWith('\\!')) {
                // 转义的 \! 视为字面 ! 开头的模式
                if (matchesGitignorePattern(relativePath, pattern.slice(1), isDirectory)) {
                    ignored = true
                }
            } else if (pattern.startsWith('!')) {
                if (matchesGitignorePattern(relativePath, pattern.slice(1), isDirectory)) {
                    ignored = false
                }
            } else if (matchesGitignorePattern(relativePath, pattern, isDirectory)) {
                ignored = true
            }
        }
        return ignored
    }

    // 无否定规则：保持原有早退快速路径（最常见的场景，避免逐条全量求值）
    for (const pattern of patterns) {
        // 转义的 \! 视为字面 ! 开头的模式（与否定分支处理一致）：
        // 快路径不按 gitignore 否定语义求值，但 \! 转义仍须还原，否则
        // 模式里的反斜杠与已归一化路径（不含 \）永不匹配，字面 ! 文件被误排除
        const normalized = pattern.startsWith('\\!') ? pattern.slice(1) : pattern
        if (matchesGitignorePattern(relativePath, normalized, isDirectory)) {
            return true
        }
    }
    
    return false
}

/**
 * 文件树节点
 */
interface FileTreeNode {
    name: string
    path: string
    isDirectory: boolean
    children?: FileTreeNode[]
}

/**
 * 文件树节点数量预算（目录+文件计数）。
 * 原实现 readdirSync 全同步递归遍历，maxDepth=-1 在调用方映射为 100 层，
 * 巨型目录树下每条消息都会遍历整棵目录树；这里对节点总数设上限，超出即截断并标记 truncated。
 * 调用方 getWorkspaceFileTree 为同步签名（PromptManager.generateFileTreeSection 同步调用），
 * 异步化需要改动整条调用链，故采用预算限制的最小方案。
 */
export const FILE_TREE_MAX_NODES = 10000

/** 递归共享的节点预算 */
interface FileTreeBudget {
    /** 剩余可添加节点数 */
    remaining: number
    /** 是否因超出预算被截断 */
    truncated: boolean
}

/**
 * 递归获取文件树
 */
function buildFileTree(
    dirPath: string,
    rootPath: string,
    patterns: string[],
    depth: number = 0,
    maxDepth: number = 2,
    customIgnorePatterns: string[] = [],
    budget: FileTreeBudget = { remaining: FILE_TREE_MAX_NODES, truncated: false }
): FileTreeNode[] {
    if (depth > maxDepth) {
        return []
    }
    if (budget.remaining <= 0) {
        budget.truncated = true
        return []
    }
    
    const nodes: FileTreeNode[] = []
    
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        
        for (const entry of entries) {
            if (budget.remaining <= 0) {
                budget.truncated = true
                break
            }

            const fullPath = path.join(dirPath, entry.name)
            const relativePath = path.relative(rootPath, fullPath).replace(/\\/g, '/')
            
            // 符号链接/路径逃逸防护：relative 结果以 .. 开头或含 /../ 段说明该条目
            // 已逃逸工作区根（根目录本身为符号链接、或 dirPath 经符号链接解析进入外部目录），
            // 直接跳过，避免文件树泄漏工作区外路径（04 批 LOW）。
            // 纵深防御：跨盘（Windows 不同驱动器）时 path.relative 返回绝对路径
            // （如 D:/...），不以 .. 开头也不含 /../ 段，需 isAbsolute 兜底。
            if (relativePath.startsWith('..') || relativePath.includes('/../') || path.isAbsolute(relativePath)) {
                continue
            }
            
            if (shouldIgnore(relativePath, patterns, entry.isDirectory(), customIgnorePatterns)) {
                continue
            }
            
            const node: FileTreeNode = {
                name: entry.name,
                path: relativePath,
                isDirectory: entry.isDirectory()
            }
            
            if (entry.isDirectory()) {
                const children = buildFileTree(fullPath, rootPath, patterns, depth + 1, maxDepth, customIgnorePatterns, budget)
                if (children.length > 0) {
                    node.children = children
                }
            }
            
            budget.remaining--
            nodes.push(node)
        }
        
        // 排序：目录在前，文件在后，按名称排序
        nodes.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) {
                return -1
            }
            if (!a.isDirectory && b.isDirectory) {
                return 1
            }
            return a.name.localeCompare(b.name)
        })
        
    } catch (error) {
        console.error(`[fileTree] Error reading directory ${dirPath}:`, error)
    }
    
    return nodes
}

/**
 * 将文件树转换为层级字符串
 * 一行一个文件或最内部文件夹
 */
function treeToLines(nodes: FileTreeNode[], prefix: string = ''): string[] {
    const lines: string[] = []
    
    for (const node of nodes) {
        if (node.isDirectory) {
            if (node.children && node.children.length > 0) {
                // 有子节点的目录，显示目录名并递归
                lines.push(`${prefix}${node.name}/`)
                lines.push(...treeToLines(node.children, prefix + '  '))
            } else {
                // 空目录（最内部文件夹）
                lines.push(`${prefix}${node.name}/`)
            }
        } else {
            // 文件
            lines.push(`${prefix}${node.name}`)
        }
    }
    
    return lines
}

/**
 * 文件树生成结果缓存：key=工作区路径+生成参数；TTL + 根目录 mtime + .gitignore mtime 三失效。
 * 每条消息都会同步 readdirSync 遍历整棵目录树，相同参数下 TTL 内零磁盘 I/O；
 * TTL 过期后 stat 根目录与 .gitignore 的 mtime，均未变化则复用缓存结果（与 pinnedFileCache 同模式）。
 *
 * .gitignore 自身 mtime 单独记录：修改忽略规则会改写 .gitignore 的 mtime，
 * 可在 TTL 过期校验时即时发现，无需等待整树重建。
 *
 * 设计局限：子目录内文件增删只反映在子目录 mtime 上，根目录 mtime 不更新，
 * 此类变化只能依赖 TTL 兜底失效（最多滞后 FILE_TREE_CACHE_TTL_MS），
 * 文件树内容可能短暂滞后于磁盘状态，属 TTL 缓存的固有取舍。
 */
interface FileTreeCacheEntry {
    result: string
    generatedAt: number
    rootMtimeMs: number
    /** .gitignore 自身 mtime（毫秒）；无 .gitignore 或不可访问时为 0 */
    gitignoreMtimeMs: number
}

/** 文件树生成结果缓存 TTL（毫秒） */
const FILE_TREE_CACHE_TTL_MS = 5000

/** 文件树生成结果缓存容量上限（超出后整体清空，与 ignoreRegexCache 同策略） */
const FILE_TREE_CACHE_MAX_ENTRIES = 32

const fileTreeCache = new Map<string, FileTreeCacheEntry>()

/**
 * 获取单个工作区的文件目录结构
 * @param workspacePath 工作区路径
 * @param maxDepth 最大深度
 * @param customIgnorePatterns 自定义忽略模式
 * @returns 文件列表字符串，一行一个
 */
function getSingleWorkspaceFileTree(workspacePath: string, maxDepth: number = 2, customIgnorePatterns: string[] = [], nodeBudget: number = FILE_TREE_MAX_NODES): string {
    const cacheKey = `${workspacePath}\u0000${maxDepth}\u0000${nodeBudget}\u0000${customIgnorePatterns.join('\u0001')}`
    const now = Date.now()
    const gitignorePath = path.join(workspacePath, '.gitignore')
    const cached = fileTreeCache.get(cacheKey)
    if (cached) {
        if (now - cached.generatedAt < FILE_TREE_CACHE_TTL_MS) {
            // TTL 内：零磁盘 I/O，直接复用缓存
            return cached.result
        }
        // TTL 过期：stat 根目录 mtime 与 .gitignore 自身 mtime，均未变化则复用并刷新时间戳。
        // .gitignore 内容变化会改写其自身 mtime（与 parseGitignore 的 mtime 复用判断同粒度），
        // 单独校验后改忽略规则可立即失效缓存，不必等下一次整树重建。
        // 注：子目录内文件增删只改子目录 mtime，根目录 mtime 不变，依赖 TTL 兜底失效
        // （最多滞后 FILE_TREE_CACHE_TTL_MS），属设计局限，见 FileTreeCacheEntry 注释。
        try {
            const rootMtimeMs = fs.statSync(workspacePath).mtimeMs
            let gitignoreMtimeMs: number
            try {
                gitignoreMtimeMs = fs.statSync(gitignorePath).mtimeMs
            } catch {
                // .gitignore 不可访问（如缓存后被删除）：mtime 记 0，与缓存值不一致即失效
                gitignoreMtimeMs = 0
            }
            if (rootMtimeMs === cached.rootMtimeMs && gitignoreMtimeMs === cached.gitignoreMtimeMs) {
                cached.generatedAt = now
                return cached.result
            }
        } catch {
            // 根目录不可访问：走重建路径（重建同样会失败并返回空树）
        }
    }

    // 解析 .gitignore
    const patterns = parseGitignore(gitignorePath)
    
    // 构建文件树（带节点预算）
    const budget: FileTreeBudget = { remaining: Math.max(0, nodeBudget), truncated: false }
    const tree = buildFileTree(workspacePath, workspacePath, patterns, 0, maxDepth, customIgnorePatterns, budget)
    
    // 转换为行列表；预算耗尽时追加截断标记，让模型知道文件树不完整
    const lines = treeToLines(tree)
    if (budget.truncated) {
        lines.push(`... (file tree truncated: exceeded ${nodeBudget} nodes)`)
    }
    
    const result = lines.join('\n')
    let rootMtimeMs = 0
    try {
        rootMtimeMs = fs.statSync(workspacePath).mtimeMs
    } catch {
        // 忽略：根目录不可访问时缓存仅按 TTL 失效
    }
    let gitignoreMtimeMs = 0
    try {
        gitignoreMtimeMs = fs.statSync(gitignorePath).mtimeMs
    } catch {
        // 忽略：无 .gitignore（或不可访问）时按 0 记录，出现/消失即与缓存值不一致而失效
    }
    if (fileTreeCache.size >= FILE_TREE_CACHE_MAX_ENTRIES) {
        fileTreeCache.clear()
    }
    fileTreeCache.set(cacheKey, { result, generatedAt: now, rootMtimeMs, gitignoreMtimeMs })
    return result
}

/**
 * 获取工作区文件目录结构（支持多工作区）
 * @param maxDepth 最大深度
 * @param customIgnorePatterns 自定义忽略模式
 * @returns 文件列表字符串，一行一个
 */
export function getWorkspaceFileTree(maxDepth: number = 2, customIgnorePatterns: string[] = [], nodeBudget: number = FILE_TREE_MAX_NODES): string {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return ''
    }
    
    // 单工作区模式
    if (workspaceFolders.length === 1) {
        return getSingleWorkspaceFileTree(workspaceFolders[0].uri.fsPath, maxDepth, customIgnorePatterns, nodeBudget)
    }
    
    // 多工作区模式：总节点预算按根均分（余数给第一个根），避免每根各用完整预算
    // 导致总节点数达 N×10000（04 批 LOW）。均分后每根预算固定，缓存 key（含
    // nodeBudget）依然稳定可复用；共享 budget 对象会让缓存 key 随已消耗量漂移，无法复用 TTL 缓存。
    const sections: string[] = []
    const rootCount = workspaceFolders.length
    const perRootBudget = Math.max(0, Math.floor(nodeBudget / rootCount))
    
    for (let i = 0; i < rootCount; i++) {
        const folder = workspaceFolders[i]
        const workspaceName = folder.name
        const workspacePath = folder.uri.fsPath
        // 第一个根吸收均分余数，保证多根总预算恰为 nodeBudget
        const budget = i === 0 ? nodeBudget - perRootBudget * (rootCount - 1) : perRootBudget
        const fileTree = getSingleWorkspaceFileTree(workspacePath, maxDepth, customIgnorePatterns, budget)
        
        if (fileTree) {
            // 添加工作区标题和缩进的文件树
            sections.push(`[${workspaceName}]`)
            // 给每行添加缩进
            const indentedTree = fileTree.split('\n').map(line => '  ' + line).join('\n')
            sections.push(indentedTree)
        }
    }
    
    return sections.join('\n\n')
}

/**
 * 获取所有工作区信息
 */
export function getAllWorkspaces(): WorkspaceInfo[] {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return []
    }
    
    return workspaceFolders.map(folder => ({
        name: folder.name,
        fsPath: folder.uri.fsPath
    }))
}

/**
 * 获取工作区根目录路径（默认返回第一个）
 */
export function getWorkspaceRoot(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return undefined
    }
    return workspaceFolders[0].uri.fsPath
}

