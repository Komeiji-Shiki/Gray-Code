<script setup lang="ts">
/**
 * 代码查看面板（内嵌抽屉）
 *
 * - 只读代码查看：行号 + 语法高亮（highlight.js）
 * - 基础语法检查：utils/syntaxCheck 提供 JSON/JS/TS/HTML/XML/CSS/Python 等
 *   括号/字符串/标签平衡与 JSON 解析错误，错误行标记 + 诊断列表 + 点击跳转
 * - 支持从工作区打开文件（disk）与查看内存内容（memory，如 diff 新内容）
 * - 工作区文件树：面板打开时自动列出工作区根目录，目录懒加载展开，
 *   点按文件即可查看代码
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '@/i18n'
import { useCodeViewStore, type CodeTreeNode } from '@/stores/codeViewStore'
import { getFileIcon, getFolderIcon } from '@/utils/fileIcons'
import { hljs } from '@/utils/highlightSetup'
import { issuesByLine } from '@/utils/syntaxCheck'

const props = withDefaults(defineProps<{ visible?: boolean }>(), { visible: true })

const emit = defineEmits<{ close: [] }>()

const codeViewStore = useCodeViewStore()
const { t } = useI18n()

// ============ 工作区文件树 ============

interface TreeRow {
  node: CodeTreeNode
  depth: number
}

/** 将已加载/已展开的目录缓存拍平成带缩进的行序列 */
const treeRows = computed<TreeRow[]>(() => {
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number) => {
    const entries = codeViewStore.treeDirEntries[dir] || []
    for (const node of entries) {
      rows.push({ node, depth })
      if (node.type === 'directory' && codeViewStore.treeExpanded[node.path]) {
        walk(node.path, depth + 1)
      }
    }
  }
  walk('', 0)
  return rows
})

const treeLoading = computed(
  () => codeViewStore.treeLoadingDir !== null
)

function onToggleDir(node: CodeTreeNode) {
  codeViewStore.toggleTreeDir(node)
}

function onOpenFile(node: CodeTreeNode) {
  codeViewStore.openTreeFile(node)
}

// 面板每次变为可见时自动加载工作区并列出根目录
watch(() => props.visible, (visible) => {
  if (visible) void codeViewStore.initWorkspace()
})

// ============ 路径输入 / 打开 ============
const pathInput = ref('')
const pathError = ref('')

async function handleOpenPath() {
  const target = pathInput.value.trim()
  if (!target) return
  pathError.value = ''
  const ok = await codeViewStore.openPath(target)
  if (!ok) {
    pathError.value = t('components.codeView.errors.openFailed')
  }
}

function handleOpenRecent(filePath: string) {
  pathInput.value = filePath
  void codeViewStore.openPath(filePath)
}

// ============ 语法高亮 ============

/** languageFromPath 的 id → highlight.js 语言名 */
function hljsLanguage(lang: string): string {
  const map: Record<string, string> = {
    typescriptreact: 'typescript',
    javascriptreact: 'javascript',
    vue: 'xml',
    shellscript: 'bash',
    dockerfile: 'dockerfile',
    plaintext: 'plaintext'
  }
  return map[lang] || lang
}

/** 整块高亮后按行拆分（浏览器对跨行 span 容错渲染，可接受） */
const highlightedLines = computed<Array<{ html: string; hasError: boolean }>>(() => {
  const code = codeViewStore.content
  if (!code) return []
  const lines = code.split('\n')
  if (lines.length > 20000) return lines.map(() => ({ html: '', hasError: false }))

  let html: string
  try {
    const lang = hljsLanguage(codeViewStore.language)
    const result = hljs.getLanguage(lang)
      ? hljs.highlight(code, { language: lang, ignoreIllegals: true })
      : hljs.highlightAuto(code)
    html = result.value
  } catch {
    html = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  const htmlLines = html.split('\n')
  const byLine = issuesByLine(codeViewStore.issues)
  return htmlLines.map((lineHtml, index) => ({
    html: lineHtml,
    hasError: byLine.has(index + 1)
  }))
})

// ============ 诊断跳转 ============

const codeScrollEl = ref<HTMLElement | null>(null)

function jumpToLine(line: number) {
  codeViewStore.jumpToLine(line)
  nextTick(() => {
    const el = codeScrollEl.value?.querySelector(`[data-line="${line}"]`)
    el?.scrollIntoView({ block: 'center' })
  })
}

watch(() => codeViewStore.scrollToLine, (line) => {
  if (line > 0) jumpToLine(line)
})

// 切换文件/刷新后重置路径输入
watch(() => codeViewStore.path, (p) => {
  if (p) pathInput.value = p
})

// ============ 行跳转输入 ============
const jumpInput = ref('')
function handleJumpInput() {
  const line = parseInt(jumpInput.value, 10)
  if (Number.isFinite(line) && line > 0) {
    jumpToLine(line)
  }
}

const totalLines = computed(() => codeViewStore.content.split('\n').length)

function onClose() {
  emit('close')
}
</script>

<template>
  <section v-show="props.visible" class="code-panel">
    <!-- 面板头部 -->
    <header class="code-header">
      <span class="codicon codicon-code code-header-icon"></span>
      <span class="code-title">{{ t('components.codeView.title') }}</span>
      <span v-if="codeViewStore.source === 'memory'" class="code-source-badge">
        {{ t('components.codeView.memorySource') }}
      </span>
      <span class="code-path" :title="codeViewStore.path">{{ codeViewStore.path }}</span>
      <div class="code-header-actions">
        <button
          class="code-btn"
          type="button"
          :disabled="codeViewStore.source !== 'disk' || !codeViewStore.path"
          :title="t('components.codeView.refresh')"
          @click="codeViewStore.refresh()"
        ><span class="codicon codicon-refresh"></span>
        </button>
        <button
          class="code-btn code-close-btn"
          type="button"
          :title="t('components.codeView.close')"
          @click="onClose"
        ><span class="codicon codicon-close"></span>
        </button>
      </div>
    </header>

    <!-- 打开工具栏 -->
    <div class="code-toolbar">
      <button
        class="code-btn code-tree-toggle"
        :class="{ active: codeViewStore.treeVisible }"
        type="button"
        :title="t('components.codeView.workspaceFiles')"
        @click="codeViewStore.setTreeVisible(!codeViewStore.treeVisible)"
      ><span class="codicon codicon-files"></span>
      </button>
      <input
        v-model="pathInput"
        class="code-path-input"
        type="text"
        :placeholder="t('components.codeView.pathPlaceholder')"
        spellcheck="false"
        @keydown.enter="handleOpenPath"
      />
      <button class="code-btn primary" type="button" @click="handleOpenPath">
        {{ t('components.codeView.open') }}
      </button>
      <input
        v-model="jumpInput"
        class="code-jump-input"
        type="text"
        :placeholder="t('components.codeView.jumpToLine')"
        @keydown.enter="handleJumpInput"
      />
      <select
        v-if="codeViewStore.recentFiles.length > 0"
        class="code-recent-select"
        :value="''"
        @change="handleOpenRecent(($event.target as HTMLSelectElement).value)"
      >
        <option value="" disabled>{{ t('components.codeView.recent') }}</option>
        <option
          v-for="file in codeViewStore.recentFiles"
          :key="file"
          :value="file"
        >{{ file }}
        </option>
      </select>
    </div>

    <div v-if="pathError" class="code-path-error">
      <span class="codicon codicon-error"></span>
      <span>{{ pathError }}</span>
    </div>

    <!-- 主体：左侧工作区文件树 + 右侧代码内容 -->
    <div class="code-main">
      <!-- 工作区文件树（自动打开工作区并列出文件） -->
      <aside v-if="codeViewStore.treeVisible" class="code-tree">
        <div class="code-tree-header">
          <span class="codicon codicon-folder-opened code-tree-root-icon"></span>
          <span class="code-tree-root-name" :title="codeViewStore.workspaceName || ''">
            {{ codeViewStore.workspaceName || t('components.codeView.workspaceFiles') }}
          </span>
          <button
            class="code-tree-refresh"
            type="button"
            :title="t('components.codeView.refreshTree')"
            :disabled="treeLoading"
            @click="codeViewStore.refreshTree()"
          ><span class="codicon codicon-refresh"></span>
          </button>
        </div>

        <div v-if="!codeViewStore.workspaceUri" class="code-tree-hint">
          <span class="codicon codicon-folder code-tree-hint-icon"></span>
          <span>{{ t('components.codeView.noWorkspace') }}</span>
        </div>
        <div v-else-if="codeViewStore.treeError" class="code-tree-error">
          {{ codeViewStore.treeError }}
        </div>
        <div v-else class="code-tree-scroll">
          <template v-if="treeRows.length === 0">
            <div v-if="treeLoading" class="code-tree-hint">
              <i class="codicon codicon-loading spin"></i>
            </div>
            <div v-else class="code-tree-hint">{{ t('components.codeView.treeEmpty') }}</div>
          </template>
          <button
            v-for="(row, rowIndex) in treeRows"
            :key="rowIndex"
            class="code-tree-item"
            :class="{
              directory: row.node.type === 'directory',
              open: row.node.path === codeViewStore.path
            }"
            type="button"
            :style="{ paddingLeft: 8 + row.depth * 14 + 'px' }"
            @click="row.node.type === 'directory' ? onToggleDir(row.node) : onOpenFile(row.node)"
          >
            <span v-if="row.node.type === 'directory'" class="codicon codicon-chevron-right code-tree-chevron" :class="{ rotated: codeViewStore.treeExpanded[row.node.path] }"></span>
            <span v-else class="code-tree-spacer"></span>
            <i
              v-if="row.node.type === 'directory'"
              :class="'codicon ' + getFolderIcon(!!codeViewStore.treeExpanded[row.node.path])"
              class="code-tree-icon"
            ></i>
            <i v-else :class="getFileIcon(row.node.name)" class="code-tree-icon"></i>
            <span class="code-tree-name" :title="row.node.path">{{ row.node.name }}</span>
            <span
              v-if="row.node.type === 'directory' && treeLoading && codeViewStore.treeLoadingDir === row.node.path"
              class="codicon codicon-loading spin code-tree-loading"
            ></span>
          </button>
        </div>
      </aside>

      <!-- 代码内容区 -->
      <div class="code-content">
        <!-- 空状态 -->
        <div v-if="!codeViewStore.path && !codeViewStore.loading" class="code-empty">
          <span class="codicon codicon-code code-empty-icon"></span>
          <span>{{ t('components.codeView.empty') }}</span>
        </div>

        <!-- 加载中 -->
        <div v-else-if="codeViewStore.loading" class="code-loading">
          <i class="codicon codicon-loading spin"></i>
        </div>

        <!-- 错误 -->
        <div v-else-if="codeViewStore.error && !codeViewStore.content" class="code-load-error">
          <span class="codicon codicon-error"></span>
          <span>{{ codeViewStore.error }}</span>
        </div>

        <!-- 内容 + 诊断 -->
        <div v-else class="code-body">
          <div class="code-scroll" ref="codeScrollEl">
            <div
              v-for="(line, index) in highlightedLines"
              :key="index"
              class="code-line"
              :class="{ 'has-error': line.hasError }"
              :data-line="index + 1"
            >
              <span class="code-ln">{{ index + 1 }}</span>
              <span class="code-error-mark" v-if="line.hasError" title="syntax error"></span>
              <code class="code-text" v-html="line.html"></code>
            </div>
          </div>

          <!-- 诊断面板 -->
          <div v-if="codeViewStore.issues.length > 0" class="code-diagnostics">
            <div class="code-diagnostics-header">
              <span class="codicon codicon-warning"></span>
              <span>
                {{ t('components.codeView.issuesFound', { count: codeViewStore.issues.length }) }}
              </span>
            </div>
            <div class="code-diagnostics-list">
              <button
                v-for="(issue, index) in codeViewStore.issues"
                :key="index"
                class="code-diagnostic-item"
                type="button"
                @click="jumpToLine(issue.line)"
              >
                <span class="code-diag-line">L{{ issue.line }}:{{ issue.column }}</span>
                <span class="code-diag-msg">{{ issue.message }}</span>
              </button>
            </div>
          </div>

          <!-- 语法正常提示 -->
          <div v-else-if="codeViewStore.content && !codeViewStore.loading" class="code-ok">
            <span class="codicon codicon-check"></span>
            <span>{{ t('components.codeView.noIssues', { lines: totalLines }) }}</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 代码查看面板：内嵌抽屉（与变更面板同布局，覆盖在主聊天区域右侧） */
.code-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 130;
  display: flex;
  flex-direction: column;
  width: 720px;
  max-width: 92%;
  min-width: 440px;
  min-height: 0;
  background: var(--vscode-editor-background, #1e1e1e);
  border-left: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  box-shadow: -6px 0 18px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}

.code-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
  border-bottom: 1px solid var(--vscode-widget-border, #454545);
}

.code-header-icon {
  color: var(--vscode-textLink-foreground, #3794ff);
}

.code-title {
  font-weight: 600;
  font-size: 13px;
  flex: none;
}

.code-source-badge {
  flex: none;
  padding: 1px 8px;
  font-size: 10px;
  border-radius: 8px;
  color: var(--vscode-badge-foreground, #fff);
  background: var(--vscode-charts-purple, #b180d7);
}

.code-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}

.code-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.code-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--vscode-button-border, rgba(255, 255, 255, 0.07));
  background: var(--vscode-button-secondaryBackground, #3a3d41);
  color: var(--vscode-button-secondaryForeground, #ffffff);
  border-radius: 3px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  line-height: 1.4;
}

.code-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, #45494e);
}

.code-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.code-btn.primary {
  background: var(--vscode-button-background, #0e639c);
}

.code-btn.primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground, #1177bb);
}

.code-btn.active {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #ffffff);
}

.code-close-btn {
  padding: 4px 8px;
}

.code-main {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* ============ 工作区文件树 ============ */
.code-tree {
  flex: none;
  width: 240px;
  min-width: 180px;
  max-width: 38%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--vscode-widget-border, #454545);
  background: var(--vscode-sideBar-background, #252526);
}

.code-tree-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-widget-border, #454545);
}

.code-tree-root-icon {
  color: var(--vscode-textLink-foreground, #3794ff);
}

.code-tree-root-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-foreground, #cccccc);
}

.code-tree-refresh {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  cursor: pointer;
  border-radius: 3px;
}

.code-tree-refresh:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.15));
  color: var(--vscode-foreground, #cccccc);
}

.code-tree-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}

.code-tree-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 0;
}

.code-tree-item {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 3px 8px;
  border: none;
  background: transparent;
  color: var(--vscode-foreground, #cccccc);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.code-tree-item:hover {
  background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.15));
}

.code-tree-item.open {
  background: var(--vscode-list-activeSelectionBackground, #094771);
  color: var(--vscode-list-activeSelectionForeground, #ffffff);
}

.code-tree-chevron {
  flex: none;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  transition: transform 0.12s ease;
}

.code-tree-chevron.rotated {
  transform: rotate(90deg);
}

.code-tree-spacer {
  flex: none;
  width: 11px;
}

.code-tree-icon {
  flex: none;
  font-size: 14px;
}

.code-tree-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-tree-loading {
  flex: none;
  font-size: 11px;
}

.code-tree-hint,
.code-tree-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}

.code-tree-hint-icon {
  font-size: 16px;
  opacity: 0.6;
}

.code-tree-error {
  color: var(--vscode-errorForeground, #f48771);
  word-break: break-word;
}

/* ============ 代码内容区 ============ */
.code-content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.code-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--vscode-widget-border, #454545);
}

.code-path-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  color: var(--vscode-input-foreground, #cccccc);
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-input-border, rgba(127, 127, 127, 0.3));
  border-radius: 3px;
  outline: none;
}

.code-path-input:focus {
  border-color: var(--vscode-focusBorder, #007fd4);
}

.code-jump-input {
  width: 74px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--vscode-input-foreground, #cccccc);
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-input-border, rgba(127, 127, 127, 0.3));
  border-radius: 3px;
  outline: none;
}

.code-recent-select {
  max-width: 180px;
  padding: 4px 6px;
  font-size: 12px;
  color: var(--vscode-input-foreground, #cccccc);
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-input-border, rgba(127, 127, 127, 0.3));
  border-radius: 3px;
  outline: none;
}

.code-path-error {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--vscode-inputValidation-errorForeground, #f48771);
  background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.15));
}

.code-empty,
.code-loading,
.code-load-error {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  font-size: 13px;
  padding: 24px;
}

.code-empty-icon {
  font-size: 20px;
  opacity: 0.6;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.code-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.code-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0;
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  font-size: 12px;
  line-height: 1.5;
}

.code-line {
  display: flex;
  align-items: stretch;
  min-height: 18px;
  white-space: pre;
}

.code-line.has-error {
  background: color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 12%, transparent);
}

.code-ln {
  flex: none;
  width: 44px;
  text-align: right;
  padding-right: 8px;
  color: var(--vscode-editorLineNumber-foreground, #858585);
  user-select: none;
  font-size: 11px;
  line-height: 18px;
}

.code-error-mark {
  flex: none;
  width: 8px;
  margin-right: 4px;
  border-radius: 2px;
  background: var(--vscode-editorError-foreground, #f14c4c);
}

.code-text {
  flex: 1;
  padding: 0 8px;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}

.code-diagnostics {
  flex: none;
  max-height: 40%;
  display: flex;
  flex-direction: column;
  border-top: 1px solid color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 40%, transparent);
}

.code-diagnostics-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-editorError-foreground, #f14c4c);
  background: color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 8%, transparent);
}

.code-diagnostics-list {
  overflow-y: auto;
  min-height: 0;
}

.code-diagnostic-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 3px 12px;
  border: none;
  background: transparent;
  color: var(--vscode-foreground, #cccccc);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.code-diagnostic-item:hover {
  background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.15));
}

.code-diag-line {
  flex: none;
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  font-size: 11px;
  color: var(--vscode-editorError-foreground, #f14c4c);
}

.code-diag-msg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-ok {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0);
  border-top: 1px solid var(--vscode-widget-border, #454545);
}
</style>
