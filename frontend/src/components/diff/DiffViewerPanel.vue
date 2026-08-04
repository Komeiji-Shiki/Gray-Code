<script setup lang="ts">
/**
 * 变更查看面板（内嵌 GitHub 风格，非独立窗口）
 *
 * 由 host.openDiffPreview 命令驱动打开，布局与子代理 Monitor 内嵌面板一致：
 * 左侧文件列表（状态 + 增删统计），右侧统一 diff（hunk 头 + 行号 + 增删着色）。
 * accept/reject 走与 VS Code 版一致的 diff.accept / diff.reject 协议。
 */
import { computed } from 'vue'
import { useI18n } from '@/i18n'
import { useDiffStore, type DiffViewerEntry } from '@/stores/diffStore'
import { useCodeViewStore } from '@/stores/codeViewStore'
import { buildHunks, computeDiffLines, diffStats } from '@/utils/diffLines'
import { checkSyntax, supportsSyntaxCheck, type SyntaxIssue } from '@/utils/syntaxCheck'
import { languageFromPath } from '@/utils/languageFromPath'

const props = withDefaults(defineProps<{ visible?: boolean }>(), { visible: true })

const emit = defineEmits<{ close: [] }>()

const diffStore = useDiffStore()
const codeViewStore = useCodeViewStore()
const { t } = useI18n()

function basename(path: string): string {
  if (!path) return ''
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

const statsByIndex = computed(() => {
  const map: Record<number, { added: number; deleted: number }> = {}
  diffStore.entries.forEach((entry, index) => {
    map[index] = diffStats(computeDiffLines(entry.originalContent, entry.newContent))
  })
  return map
})

/** 每个条目的新内容基础语法检查结果（仅对代码类文件生效） */
const issuesByIndex = computed(() => {
  const map: Record<number, SyntaxIssue[]> = {}
  diffStore.entries.forEach((entry, index) => {
    const lang = languageFromPath(entry.filePath)
    map[index] = checkSyntax(entry.newContent, lang)
  })
  return map
})

const selectedHunks = computed(() => {
  const entry = diffStore.selectedEntry
  if (!entry) return []
  return buildHunks(computeDiffLines(entry.originalContent, entry.newContent))
})

const selectedIssues = computed(() => {
  const entry = diffStore.selectedEntry
  if (!entry) return []
  return issuesByIndex.value[diffStore.selectedIndex] || []
})

/** 仅当语言支持检查且通过时展示“无语法问题”（避免误导非代码文件） */
const selectedCheckedClean = computed(() => {
  const entry = diffStore.selectedEntry
  if (!entry) return false
  if (!supportsSyntaxCheck(languageFromPath(entry.filePath))) return false
  const issues = issuesByIndex.value[diffStore.selectedIndex]
  return !!issues && issues.length === 0
})

function statusLabel(status: string): string {
  const key = `components.diff.status.${status}`
  const label = t(key)
  return label && !label.startsWith('components.diff.status') ? label : status
}

function onAction(entry: DiffViewerEntry, accept: boolean) {
  const index = diffStore.entries.indexOf(entry)
  if (index < 0) return
  void (accept ? diffStore.accept(index) : diffStore.reject(index))
}

/** 在代码查看面板中查看新内容（语法检查复用同一引擎） */
function onViewNewContent(entry: DiffViewerEntry) {
  codeViewStore.openContent(entry.filePath, entry.newContent)
}

function onClose() {
  emit('close')
}

function onClearHistory() {
  diffStore.clearHistory()
}
</script>

<template>
  <section v-show="props.visible" class="diff-panel">
    <!-- 面板头部：标题 + 批量操作 + 关闭 -->
    <header class="diff-header">
      <span class="codicon codicon-diff-added diff-header-icon"></span>
      <span class="diff-title">{{ t('components.diff.title') }}</span>
      <span v-if="diffStore.entries.length > 0" class="diff-count">
        {{ t('components.diff.fileCount', { count: diffStore.entries.length }) }}
      </span>
      <div class="diff-header-actions">
        <button
          v-if="diffStore.pendingCount > 0"
          class="diff-btn danger"
          type="button"
          :disabled="diffStore.pendingCount === 0"
          @click="diffStore.rejectAll()"
        >{{ t('components.diff.rejectAll') }}
        </button>
        <button
          v-if="diffStore.pendingCount > 0"
          class="diff-btn primary"
          type="button"
          :disabled="diffStore.pendingCount === 0"
          @click="diffStore.acceptAll()"
        >{{ t('components.diff.acceptAll') }}
        </button>
        <button
          v-if="diffStore.entries.length > 0"
          class="diff-btn"
          type="button"
          :title="t('components.diff.clearHistory')"
          @click="onClearHistory"
        >{{ t('components.diff.clearHistory') }}
        </button>
        <button class="diff-btn diff-close-btn" type="button" :title="t('components.diff.close')" @click="onClose">
          <span class="codicon codicon-close"></span>
        </button>
      </div>
    </header>

    <div v-if="diffStore.entries.length === 0" class="diff-empty">
      {{ t('components.diff.empty') }}
    </div>

    <div v-else class="diff-body">
      <!-- 左侧：文件列表（GitHub 变更视图的 file list） -->
      <nav class="diff-file-list">
        <template
          v-for="(entry, index) in diffStore.entries"
          :key="entry.previewId + entry.sessionId"
        >
          <div
            v-if="index === 0 || entry.round !== diffStore.entries[index - 1].round"
            class="diff-round-separator"
          >
            {{ t('components.diff.roundLabel', { round: entry.round }) }}
          </div>
          <button
            class="diff-file-item"
            :class="{
              selected: index === diffStore.selectedIndex,
              done: entry.status !== 'pending'
            }"
            type="button"
            @click="diffStore.select(index)"
          >
            <span class="diff-file-status" :class="'status-' + entry.status">
              <span
                v-if="entry.status === 'accepted'"
                class="codicon codicon-check"
              ></span>
              <span v-else-if="entry.status === 'rejected'" class="codicon codicon-close"></span>
              <span v-else class="codicon codicon-diff"></span>
            </span>
            <span class="diff-file-name">{{ basename(entry.filePath) }}</span>
            <span
              v-if="issuesByIndex[index] && issuesByIndex[index].length > 0"
              class="diff-file-issues"
              :title="t('components.diff.syntaxIssues', { count: issuesByIndex[index].length })"
            >{{ issuesByIndex[index].length }}</span>
            <span
              class="diff-file-stats"
              :class="{ changed: statsByIndex[index]?.added + statsByIndex[index]?.deleted > 0 }"
            >
              <template v-if="statsByIndex[index]">
                <span class="add">+{{ statsByIndex[index].added }}</span>
                <span class="del">-{{ statsByIndex[index].deleted }}</span>
              </template>
            </span>
            <span v-if="entry.busy" class="codicon codicon-loading spin"></span>
          </button>
        </template>
      </nav>

      <!-- 右侧：统一 diff 详情 -->
      <main class="diff-detail">
        <!-- 全部处理完毕提示条（历史条目仍可查看与比对） -->
        <div v-if="diffStore.pendingCount === 0" class="diff-all-done">
          <span class="codicon codicon-check-all"></span>
          <span>{{ t('components.diff.allProcessed') }}</span>
        </div>
        <div v-if="diffStore.selectedEntry" class="diff-detail-header">
          <span class="diff-file-path" :title="diffStore.selectedEntry.filePath">
            {{ diffStore.selectedEntry.filePath }}
          </span>
          <div class="diff-detail-actions">
            <span v-if="diffStore.selectedEntry.error" class="diff-error" :title="diffStore.selectedEntry.error">
              {{ t('components.diff.actionFailed') }}
            </span>
            <button
              class="diff-btn"
              type="button"
              :title="t('components.diff.viewNewContent')"
              @click="onViewNewContent(diffStore.selectedEntry)"
            >{{ t('components.diff.viewNewContent') }}
            </button>
            <span
              v-if="diffStore.selectedEntry.status !== 'pending'"
              class="diff-done-tag"
              :class="'tag-' + diffStore.selectedEntry.status"
            >
              {{ statusLabel(diffStore.selectedEntry.status) }}
            </span>
            <!-- 已处理的变更（已接受/已拒绝）只读查看与比对，不再展示接受/拒绝按钮 -->
            <button
              v-if="diffStore.selectedEntry.status === 'pending'"
              class="diff-btn danger"
              type="button"
              :disabled="diffStore.selectedEntry.busy || !diffStore.selectedEntry.sessionId"
              @click="onAction(diffStore.selectedEntry, false)"
            >{{ t('components.diff.reject') }}
            </button>
            <button
              v-if="diffStore.selectedEntry.status === 'pending'"
              class="diff-btn primary"
              type="button"
              :disabled="diffStore.selectedEntry.busy || !diffStore.selectedEntry.sessionId"
              @click="onAction(diffStore.selectedEntry, true)"
            >{{ t('components.diff.accept') }}
            </button>
          </div>
        </div>

        <!-- 新内容基础语法检查结果 -->
        <div v-if="selectedIssues.length > 0" class="diff-syntax-issues">
          <div class="diff-syntax-header">
            <span class="codicon codicon-warning"></span>
            <span>{{ t('components.diff.syntaxIssues', { count: selectedIssues.length }) }}</span>
          </div>
          <div class="diff-syntax-list">
            <span
              v-for="(issue, issueIndex) in selectedIssues"
              :key="issueIndex"
              class="diff-syntax-item"
            >L{{ issue.line }}:{{ issue.column }} {{ issue.message }}
            </span>
          </div>
        </div>
        <div
          v-else-if="selectedCheckedClean"
          class="diff-syntax-ok"
        >
          <span class="codicon codicon-check"></span>
          <span>{{ t('components.diff.noSyntaxIssues') }}</span>
        </div>

        <div
          v-if="diffStore.selectedEntry?.diffGuardWarning"
          class="diff-guard-warning"
        >
          <span class="codicon codicon-warning"></span>
          <span>{{ diffStore.selectedEntry.diffGuardWarning }}</span>
        </div>

        <div v-if="selectedHunks.length === 0" class="diff-empty">
          {{ t('components.diff.noChange') }}
        </div>

        <div v-else class="diff-scroll">
          <section
            v-for="(hunk, hunkIndex) in selectedHunks"
            :key="hunkIndex"
            class="diff-hunk"
          >
            <div class="diff-hunk-header">@@ -{{ hunk.oldStart }},{{ hunk.oldCount }} +{{ hunk.newStart }},{{ hunk.newCount }} @@</div>
            <div
              v-for="(line, lineIndex) in hunk.lines"
              :key="hunkIndex + '-' + lineIndex"
              class="diff-row"
              :class="line.type"
            >
              <span class="diff-ln diff-ln-old">{{ line.oldLineNum ?? '' }}</span>
              <span class="diff-ln diff-ln-new">{{ line.newLineNum ?? '' }}</span>
              <span class="diff-code">{{ line.content }}</span>
            </div>
          </section>
        </div>
      </main>
    </div>
  </section>
</template>

<style scoped>
/* 变更查看面板：内嵌抽屉（覆盖在主聊天区域右侧，非独立窗口） */
.diff-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 120;
  display: flex;
  flex-direction: column;
  width: 680px;
  max-width: 88%;
  min-width: 420px;
  min-height: 0;
  background: var(--vscode-editor-background, #1e1e1e);
  border-left: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.3));
  box-shadow: -6px 0 18px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.diff-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
  border-bottom: 1px solid var(--vscode-widget-border, #454545);
}

.diff-header-icon {
  color: var(--vscode-textLink-foreground, #3794ff);
}

.diff-title {
  font-weight: 600;
  font-size: 13px;
  flex: none;
}

.diff-count {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}

.diff-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.diff-btn {
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

.diff-btn:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground, #45494e);
}

.diff-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.diff-btn.primary {
  background: var(--vscode-button-background, #0e639c);
}

.diff-btn.primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground, #1177bb);
}

.diff-btn.danger {
  background: var(--vscode-errorForeground);
}

.diff-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--vscode-errorForeground) 80%, black);
}

.diff-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  font-size: 13px;
  padding: 24px;
}

/* 全部变更处理完毕提示条（历史条目仍可查看与比对） */
.diff-all-done {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0);
  background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 30%, transparent);
}

/* 文件列表内的轮次分隔 */
.diff-round-separator {
  padding: 6px 10px 2px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
  text-transform: uppercase;
}

.diff-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 左侧文件列表 */
.diff-file-list {
  flex: none;
  width: 230px;
  min-width: 180px;
  max-width: 40%;
  overflow-y: auto;
  border-right: 1px solid var(--vscode-widget-border, #454545);
  background: var(--vscode-sideBar-background, #252526);
  padding: 4px 0;
}

.diff-file-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--vscode-foreground, #cccccc);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.diff-file-item:hover {
  background: var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.15));
}

.diff-file-item.selected {
  background: var(--vscode-list-activeSelectionBackground, #094771);
  color: var(--vscode-list-activeSelectionForeground, #ffffff);
}

.diff-file-item.done:not(.selected) .diff-file-name {
  opacity: 0.65;
}

.diff-file-status {
  flex: none;
  display: inline-flex;
  font-size: 13px;
}

.diff-file-status.status-pending {
  color: var(--vscode-textLink-foreground, #3794ff);
}

.diff-file-status.status-accepted {
  color: var(--vscode-testing-iconPassed, #4ec9b0);
}

.diff-file-status.status-rejected {
  color: var(--vscode-errorForeground);
}

.diff-file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-file-stats {
  flex: none;
  font-size: 11px;
}

.diff-file-stats .add {
  color: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0);
}

.diff-file-stats .del {
  color: var(--vscode-gitDecoration-deletedResourceForeground, #f48771);
}

/* 文件列表中的语法错误数量徽标 */
.diff-file-issues {
  flex: none;
  min-width: 16px;
  padding: 0 5px;
  font-size: 10px;
  font-weight: 700;
  text-align: center;
  border-radius: 8px;
  color: #fff;
  background: var(--vscode-errorForeground, #f14c4c);
}

/* 新内容语法检查结果 */
.diff-syntax-issues {
  flex: none;
  max-height: 30%;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 40%, transparent);
}

.diff-syntax-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-editorError-foreground, #f14c4c);
  background: color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 8%, transparent);
}

.diff-syntax-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 0;
}

.diff-syntax-item {
  display: block;
  padding: 2px 12px;
  font-size: 12px;
  color: var(--vscode-foreground, #cccccc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.diff-syntax-ok {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0);
}

/* 右侧 diff 详情 */
.diff-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.diff-detail-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--vscode-widget-border, #454545);
}

.diff-file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--vscode-descriptionForeground, #9d9d9d);
}

.diff-detail-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.diff-error {
  font-size: 11px;
  color: var(--vscode-errorForeground);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-done-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid transparent;
}

.diff-done-tag.tag-accepted {
  color: var(--vscode-gitDecoration-addedResourceForeground);
  border-color: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 40%, transparent);
}

.diff-done-tag.tag-rejected {
  color: var(--vscode-errorForeground);
  border-color: color-mix(in srgb, var(--vscode-errorForeground) 40%, transparent);
}

.diff-guard-warning {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--vscode-editorWarning-foreground);
  background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 12%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground) 30%, transparent);
}

.diff-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 0;
}

.diff-hunk-header {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 3px 12px;
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  font-size: 12px;
  color: var(--vscode-textLink-foreground, #3794ff);
  background: color-mix(in srgb, var(--vscode-textLink-foreground) 16%, transparent);
  border-top: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 25%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 25%, transparent);
}

.diff-row {
  display: flex;
  font-family: var(--vscode-editor-font-family, Consolas, monospace);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
  min-height: 18px;
}

.diff-ln {
  flex: none;
  width: 44px;
  text-align: right;
  padding-right: 8px;
  color: var(--vscode-editorLineNumber-foreground, #858585);
  user-select: none;
  font-size: 11px;
  line-height: 18px;
}

.diff-code {
  flex: 1;
  padding: 0 8px;
  white-space: pre-wrap;
  word-break: break-word;
}

.diff-row.deleted {
  background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground) 22%, transparent);
}

.diff-row.deleted .diff-ln-old {
  background: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground) 30%, transparent);
}

.diff-row.added {
  background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 22%, transparent);
}

.diff-row.added .diff-ln-new {
  background: color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground) 30%, transparent);
}
</style>
