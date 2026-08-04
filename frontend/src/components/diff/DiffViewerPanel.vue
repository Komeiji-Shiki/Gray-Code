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
import { buildHunks, computeDiffLines, diffStats } from '@/utils/diffLines'

const props = withDefaults(defineProps<{ visible?: boolean }>(), { visible: true })

const emit = defineEmits<{ close: [] }>()

const diffStore = useDiffStore()
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

const selectedHunks = computed(() => {
  const entry = diffStore.selectedEntry
  if (!entry) return []
  return buildHunks(computeDiffLines(entry.originalContent, entry.newContent))
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

function onClose() {
  emit('close')
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
        <button
          v-for="(entry, index) in diffStore.entries"
          :key="entry.previewId + entry.sessionId"
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
      </nav>

      <!-- 右侧：统一 diff 详情 -->
      <main class="diff-detail">
        <div v-if="diffStore.selectedEntry" class="diff-detail-header">
          <span class="diff-file-path" :title="diffStore.selectedEntry.filePath">
            {{ diffStore.selectedEntry.filePath }}
          </span>
          <div class="diff-detail-actions">
            <span v-if="diffStore.selectedEntry.error" class="diff-error" :title="diffStore.selectedEntry.error">
              {{ t('components.diff.actionFailed') }}
            </span>
            <span
              v-if="diffStore.selectedEntry.status !== 'pending'"
              class="diff-done-tag"
              :class="'tag-' + diffStore.selectedEntry.status"
            >
              {{ statusLabel(diffStore.selectedEntry.status) }}
            </span>
            <button
              class="diff-btn danger"
              type="button"
              :disabled="diffStore.selectedEntry.status !== 'pending' || diffStore.selectedEntry.busy || !diffStore.selectedEntry.sessionId"
              @click="onAction(diffStore.selectedEntry, false)"
            >{{ t('components.diff.reject') }}
            </button>
            <button
              class="diff-btn primary"
              type="button"
              :disabled="diffStore.selectedEntry.status !== 'pending' || diffStore.selectedEntry.busy || !diffStore.selectedEntry.sessionId"
              @click="onAction(diffStore.selectedEntry, true)"
            >{{ t('components.diff.accept') }}
            </button>
          </div>
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
  background: #be1100;
}

.diff-btn.danger:hover:not(:disabled) {
  background: #d11b08;
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
  color: #f14c4c;
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
  color: #f14c4c;
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
  color: #4ec9b0;
  border-color: rgba(78, 201, 176, 0.4);
}

.diff-done-tag.tag-rejected {
  color: #f14c4c;
  border-color: rgba(241, 76, 76, 0.4);
}

.diff-guard-warning {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  color: #d18616;
  background: rgba(209, 134, 22, 0.12);
  border-bottom: 1px solid rgba(209, 134, 22, 0.3);
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
  background: rgba(55, 148, 255, 0.16);
  border-top: 1px solid rgba(55, 148, 255, 0.25);
  border-bottom: 1px solid rgba(55, 148, 255, 0.25);
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
  background: rgba(248, 81, 73, 0.22);
}

.diff-row.deleted .diff-ln-old {
  background: rgba(248, 81, 73, 0.3);
}

.diff-row.added {
  background: rgba(46, 160, 67, 0.22);
}

.diff-row.added .diff-ln-new {
  background: rgba(46, 160, 67, 0.3);
}
</style>
