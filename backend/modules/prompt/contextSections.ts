/**
 * GrayCode - Prompt 上下文段落生成器
 *
 * 负责生成各类上下文段落（环境信息、徽章格式、记忆说明、文件树、标签页、
 * 活动编辑器、诊断、固定文件），以及语言/系统信息等辅助读取。
 * 从 PromptManager.ts 抽离（纯重构，行为不变）。
 */

import * as vscode from 'vscode'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import type { PromptContext } from './types'
import { getWorkspaceFileTree, getWorkspaceRoot, getAllWorkspaces } from './fileTree'
import { getGlobalSettingsManager } from '../../core/settingsContext'
import { shouldIgnorePath } from './ignorePatterns'
import {
    PINNED_FILE_CACHE_TTL_MS,
    PINNED_FILE_MAX_BYTES,
    PINNED_FILE_MAX_TOTAL_BYTES,
    deletePinnedFileCacheEntry,
    getPinnedFileCacheEntry,
    normalizePinnedFiles,
    readPinnedFileCapped,
    setPinnedFileCache,
    touchPinnedFileCache,
} from './pinnedFiles'

export class PromptContextSectionBuilder {
    /**
     * 将内容包装为带标题的段落
     */
    wrapSection(title: string, content: string | null): string {
        if (!content) return ''
        return `====\n\n${title}\n\n${content}`
    }

    /**
     * 清理文本中的多余空行
     *
     * 将连续 3 个或以上的换行符压缩为 2 个
     */
    cleanupEmptyLines(text: string): string {
        return text.replace(/\n{3,}/g, '\n\n').trim()
    }

    /**
     * 获取用户语言环境
     *
     * 根据设置返回用户当前使用的语言
     * - 如果设置为 'auto'，使用 VS Code 的语言设置
     * - 否则使用用户选择的语言
     */
    getUserLanguage(): string {
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
     * 生成静态环境信息段落（用于系统提示词，可缓存）
     *
     * 包含：
     * - 工作区路径
     * - 操作系统信息
     * - 时区
     * - 用户语言
     */
    generateStaticEnvironmentSection(): string {
        const context = this.getContext()
        const lines: string[] = []

        // 工作区信息（支持多工作区）
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
    generateContextBadgeFormatSection(): string {
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

    /**
     * 生成记忆系统的使用说明。
     *
     * 优先从用户设置中读取自定义提示词（limcode.toolsConfig.memory.systemPrompt），
     * 否则使用内置默认值。
     */
    generateMemorySection(): string {
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

    /**
     * 生成文件树段落
     */
    generateFileTreeSection(maxDepth: number, ignorePatterns: string[]): string {
        const effectiveMaxDepth = maxDepth === -1 ? 100 : maxDepth  // -1 表示无限制，使用大值代替
        const fileTree = getWorkspaceFileTree(effectiveMaxDepth, ignorePatterns)

        if (!fileTree) {
            return ''
        }

        return `The following is a list of files in the current workspace:\n\n${fileTree}`
    }

    /**
     * 生成打开的标签页段落
     */
    generateOpenTabsSection(maxTabs: number, ignorePatterns: string[]): string {
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
                    if (workspaceFolder) {
                        // 获取相对路径
                        const relativePath = vscode.workspace.asRelativePath(uri, false)

                        // 检查是否应该被忽略
                        if (!shouldIgnorePath(relativePath, ignorePatterns)) {
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
    generateActiveEditorSection(ignorePatterns: string[]): string {
        const activeEditor = vscode.window.activeTextEditor
        if (!activeEditor) {
            return ''
        }

        const uri = activeEditor.document.uri
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)

        if (!workspaceFolder) {
            return ''
        }

        const relativePath = vscode.workspace.asRelativePath(uri, false)

        if (shouldIgnorePath(relativePath, ignorePatterns)) {
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
    generateDiagnosticsSection(): string {
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
    generatePinnedFilesSection(runtimePinnedFiles?: unknown): string {
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
        const allPinnedFiles = hasRuntimeOverride
            ? runtimeFiles.filter(file => file.enabled)
            : settingsManager.getEnabledPinnedFiles()

        const results: string[] = []
        let totalBytes = 0

        for (const pinnedFile of allPinnedFiles) {
            // 预算已耗尽：剩余文件注定被跳过（emittedBytes > 0 时必超限），提前 break
            // 退出循环，避免继续为它们做缓存命中检查/stat/read（04 批 LOW：预算检查
            // 在读取之后执行，超限文件仍白做一次磁盘探测）。
            if (totalBytes >= PINNED_FILE_MAX_TOTAL_BYTES) {
                break
            }
            const workspaceFolder = workspaceUriToFolder.get(pinnedFile.workspaceUri)
            if (!workspaceFolder) {
                continue
            }

            try {
                const filePath = pinnedFile.path
                const fullPath = path.isAbsolute(filePath)
                    ? filePath
                    : path.join(workspaceFolder.uri.fsPath, filePath)

                const now = Date.now()
                const cached = getPinnedFileCacheEntry(fullPath)
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
                        deletePinnedFileCacheEntry(fullPath)
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
     * 获取上下文信息
     */
    getContext(): PromptContext {
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
    getOSInfo(): string {
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
