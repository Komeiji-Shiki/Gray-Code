import { formatOpenTabsSection, formatActiveEditorSection, formatDiagnosticsSection } from './editorSections'
import { generateContextBadgeFormatSection, generateMemorySection } from './commonSections'
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
    generateContextBadgeFormatSection(): string { return generateContextBadgeFormatSection(getGlobalSettingsManager()) }

    /**
     * 生成记忆系统的使用说明。
     *
     * 优先从用户设置中读取自定义提示词（limcode.toolsConfig.memory.systemPrompt），
     * 否则使用内置默认值。
     */
    generateMemorySection(): string { return generateMemorySection(getGlobalSettingsManager()) }

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
        if (!vscode.workspace.workspaceFolders?.length) return ''
        const tabs: string[] = []
        for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText && vscode.workspace.getWorkspaceFolder(tab.input.uri))
                tabs.push(vscode.workspace.asRelativePath(tab.input.uri, false))
        }
        return formatOpenTabsSection(tabs, maxTabs, ignorePatterns)
    }

    /**
     * 生成当前活动编辑器段落
     */
    generateActiveEditorSection(ignorePatterns: string[]): string {
        const editor = vscode.window.activeTextEditor
        if (!editor || !vscode.workspace.getWorkspaceFolder(editor.document.uri)) return ''
        return formatActiveEditorSection(vscode.workspace.asRelativePath(editor.document.uri, false), ignorePatterns)
    }

    /**
     * 生成诊断信息段落
     *
     * 从 VSCode 获取工作区的诊断信息（错误、警告等）
     * 根据配置过滤严重程度和文件范围
     */
    generateDiagnosticsSection(): string {
        const settings = getGlobalSettingsManager()
        if (!settings || !vscode.workspace.workspaceFolders?.length) return ''
        const config = settings.getDiagnosticsConfig()
        if (!config.enabled) return ''
        const openUris = new Set<string>()
        if (config.openFilesOnly) for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputText) openUris.add(tab.input.uri.toString())
        }
        const severities = ['error', 'warning', 'information', 'hint'] as const
        function* files() {
            for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) yield {
                path: vscode.workspace.asRelativePath(uri, false),
                inWorkspace: !!vscode.workspace.getWorkspaceFolder(uri), open: openUris.has(uri.toString()),
                diagnostics: diagnostics.map(item => ({ severity: severities[item.severity], line: item.range.start.line + 1, message: item.message, source: item.source }))
            }
        }
        return formatDiagnosticsSection(config, files())
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
