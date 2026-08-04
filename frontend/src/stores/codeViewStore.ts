/**
 * 代码查看面板 Store（内嵌抽屉，与变更查看面板同布局体系）
 *
 * - 支持两种内容来源：磁盘文件（openPath，走 readFileForContext IPC，
 *   由扩展端做工作区包含校验）与内存内容（openContent，如 diff 新内容预览）。
 * - 语法检查为纯前端基础检查（utils/syntaxCheck），渲染时按需计算。
 * - 工作区文件树：面板打开时自动列出工作区根目录（listWorkspaceDirectory IPC），
 *   目录按需懒加载展开，点按文件即可查看代码。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { sendToExtension } from '../utils/vscode'
import { checkSyntax, type SyntaxIssue } from '../utils/syntaxCheck'
import { languageFromPath } from '../utils/languageFromPath'

/** 最近打开列表上限（会话内状态） */
const MAX_RECENT_FILES = 10

/** 工作区文件树条目 */
export interface CodeTreeNode {
  name: string
  /** 工作区相对路径（/ 分隔） */
  path: string
  type: 'directory' | 'file'
}

/** 工作区文件树目录缓存 key：相对目录路径（'' = 工作区根） */
export type TreeDirKey = string

export const useCodeViewStore = defineStore('codeView', () => {
  // 面板开关（仅会话内状态）
  const open = ref(false)
  // 文件路径（工作区相对或绝对路径，仅展示）
  const path = ref('')
  // 内容来源标记：'disk' 表示从磁盘加载，'memory' 表示内存内容
  const source = ref<'disk' | 'memory'>('disk')
  const content = ref('')
  const language = ref('plaintext')
  const loading = ref(false)
  const error = ref('')
  const issues = ref<SyntaxIssue[]>([])
  // 最近打开的文件（disk 来源）
  const recentFiles = ref<string[]>([])
  // 行跳转目标（面板内点击诊断条目触发）
  const scrollToLine = ref(0)

  // ============ 工作区文件树 ============
  /** 当前工作区 uri（file:// 形式），未打开工作区时为 null */
  const workspaceUri = ref<string | null>(null)
  /** 工作区显示名（根目录名） */
  const workspaceName = ref('')
  /** 文件树开关（面板内工具栏切换） */
  const treeVisible = ref(true)
  /** 目录 → 条目缓存（懒加载） */
  const treeDirEntries = ref<Record<string, CodeTreeNode[]>>({})
  /** 已展开的目录集合 */
  const treeExpanded = ref<Record<string, boolean>>({})
  /** 正在加载的目录（'' = 根目录） */
  const treeLoadingDir = ref<string | null>(null)
  /** 工作区加载错误信息 */
  const treeError = ref('')

  const issueCount = computed(() => issues.value.length)

  /** 根目录是否已加载 */
  const treeRootLoaded = computed(() => treeDirEntries.value[''] !== undefined)

  function setIssuesFor(code: string, lang: string): void {
    issues.value = checkSyntax(code, lang)
  }

  /**
   * 构造扩展端可解析的 file:// URI：
   * - 绝对路径/已有 file:// 前缀直接使用；
   * - 相对路径拼接当前工作区根目录（修复 file://相对路径 被 Uri 解析成 authority 的问题）。
   */
  function resolveFileUri(filePath: string): string {
    const trimmed = filePath.trim()
    if (trimmed.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) {
      return trimmed.startsWith('file://') ? trimmed : 'file://' + trimmed.replace(/^[/\\]+/, '')
    }
    if (workspaceUri.value) {
      return `${workspaceUri.value}/${trimmed}`
    }
    return 'file://' + trimmed
  }

  /** 用磁盘文件路径打开：走扩展端校验后读取 */
  async function openPath(filePath: string): Promise<boolean> {
    if (!filePath || !filePath.trim()) return false
    path.value = filePath
    language.value = languageFromPath(filePath)
    source.value = 'disk'
    open.value = true
    loading.value = true
    error.value = ''
    content.value = ''
    issues.value = []

    try {
      // 与 read_file 工具共享扩展端工作区校验（readFileForContext）
      const uri = resolveFileUri(filePath)
      const response = await sendToExtension<{
        success: boolean
        content?: string
        path?: string
        error?: string
      }>('readFileForContext', { uri })

      if (!response?.success) {
        error.value = response?.error || 'Failed to read file'
        loading.value = false
        return false
      }

      content.value = response.content || ''
      setIssuesFor(content.value, language.value)
      pushRecent(filePath)
      loading.value = false
      return true
    } catch (err: any) {
      error.value = err?.message || String(err)
      loading.value = false
      return false
    }
  }

  /** 用内存内容打开（如 diff 新内容、工具输出片段） */
  function openContent(filePath: string, fileContent: string): void {
    path.value = filePath || 'untitled'
    language.value = languageFromPath(filePath)
    source.value = 'memory'
    content.value = fileContent
    error.value = ''
    issues.value = []
    setIssuesFor(fileContent, language.value)
    loading.value = false
    open.value = true
  }

  /** 重新加载（仅 disk 来源） */
  function refresh(): void {
    if (source.value !== 'disk' || !path.value) return
    void openPath(path.value)
  }

  function close(): void {
    open.value = false
  }

  /** 手动打开空面板（dock 按钮入口）：自动加载工作区并列出根目录文件 */
  function openEmpty(): void {
    open.value = true
    void initWorkspace()
  }

  // ============ 工作区文件树逻辑 ============

  /** 获取工作区信息并加载根目录（面板打开时自动调用） */
  async function initWorkspace(): Promise<void> {
    try {
      const uri = await sendToExtension<string | null>('getWorkspaceUri', {})
      if (!uri) {
        workspaceUri.value = null
        workspaceName.value = ''
        treeError.value = ''
        return
      }
      if (workspaceUri.value !== uri) {
        workspaceUri.value = uri
        workspaceName.value = basenameOfUri(uri)
        treeDirEntries.value = {}
        treeExpanded.value = {}
        treeError.value = ''
      }
      await loadTreeDir('')
    } catch (err: any) {
      treeError.value = err?.message || String(err)
    }
  }

  function basenameOfUri(uri: string): string {
    try {
      const cleaned = uri.replace(/[/\\]+$/, '')
      const seg = cleaned.split('/').pop() || ''
      return decodeURIComponent(seg)
    } catch {
      return uri
    }
  }

  /** 懒加载某个目录的直属条目（'' = 工作区根目录） */
  async function loadTreeDir(dirPath: string): Promise<void> {
    const key = dirPath || ''
    if (treeDirEntries.value[key] !== undefined || treeLoadingDir.value === key) {
      return
    }
    treeLoadingDir.value = key
    treeError.value = ''
    try {
      const response = await sendToExtension<{
        success: boolean
        entries?: CodeTreeNode[]
        error?: string
        errorCode?: string
      }>('listWorkspaceDirectory', { path: key })
      if (!response?.success) {
        treeError.value = response?.error || 'Failed to list workspace directory'
        return
      }
      treeDirEntries.value = {
        ...treeDirEntries.value,
        [key]: response.entries || []
      }
    } catch (err: any) {
      treeError.value = err?.message || String(err)
    } finally {
      treeLoadingDir.value = null
    }
  }

  /** 展开/折叠目录 */
  function toggleTreeDir(node: CodeTreeNode): void {
    const key = node.path
    if (treeExpanded.value[key]) {
      treeExpanded.value = { ...treeExpanded.value, [key]: false }
      return
    }
    treeExpanded.value = { ...treeExpanded.value, [key]: true }
    void loadTreeDir(key)
  }

  /** 点按文件：在工作区相对路径上打开代码 */
  function openTreeFile(node: CodeTreeNode): void {
    void openPath(node.path)
  }

  /** 刷新文件树（重载根目录与已展开目录） */
  async function refreshTree(): Promise<void> {
    const dirs = Object.keys(treeExpanded.value).filter((d) => treeExpanded.value[d])
    treeDirEntries.value = {}
    treeExpanded.value = {}
    for (const d of dirs) {
      treeExpanded.value = { ...treeExpanded.value, [d]: true }
      await loadTreeDir(d)
    }
    await loadTreeDir('')
  }

  function setTreeVisible(visible: boolean): void {
    treeVisible.value = visible
  }

  function pushRecent(filePath: string): void {
    recentFiles.value = [
      filePath,
      ...recentFiles.value.filter((p) => p !== filePath)
    ].slice(0, MAX_RECENT_FILES)
  }

  function jumpToLine(line: number): void {
    scrollToLine.value = line
  }

  return {
    open,
    path,
    source,
    content,
    language,
    loading,
    error,
    issues,
    issueCount,
    recentFiles,
    scrollToLine,
    workspaceUri,
    workspaceName,
    treeVisible,
    treeDirEntries,
    treeExpanded,
    treeLoadingDir,
    treeError,
    treeRootLoaded,
    openPath,
    openContent,
    refresh,
    close,
    openEmpty,
    initWorkspace,
    loadTreeDir,
    toggleTreeDir,
    openTreeFile,
    refreshTree,
    setTreeVisible,
    jumpToLine
  }
})
