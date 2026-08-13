<script setup lang="ts">
/**
 * MemoryEntriesSection - 原始记忆条目管理区块（作用域切换 / 手动新增 / 批量删除 / 列表编辑）
 *
 * 从 MemorySettings.vue 模板拆分（纯结构性拆分，行为零变化）：
 * - 纯展示组件：条目 / 选中 / 编辑 / 删除状态由父组件注入，自身不持有业务状态；
 * - 所有动作（新增 / 删除 / 编辑 / 选择）通过 emits 回传父组件。
 */
import { ConfirmDialog } from '../../common'
import { useI18n } from '@/i18n'

const { t } = useI18n()

interface LogEntry {
  id: number
  date: string
  text: string
}

interface WorkspaceMemoryScope {
  uri: string
  name: string
  fsPath: string
  hasData: boolean
}

defineProps<{
  memoryScope: 'global' | 'workspace'
  workspaceScopes: WorkspaceMemoryScope[]
  scopesLoading: boolean
  selectedWorkspaceUri: string
  newEntryText: string
  addingEntry: boolean
  newEntryBytes: number
  entriesTruncated: boolean
  entries: LogEntry[]
  entriesLoading: boolean
  entriesTotal: number
  entryChars: number
  selectedIds: Set<number>
  batchDeleteCount: number
  isAllSelected: boolean
  batchDeleteSaving: boolean
  editingId: number | null
  editingText: string
  editingBytes: number
  editSaving: boolean
  deleteSaving: boolean
  showDeleteConfirm: boolean
  deleteCandidate: LogEntry | null
  showBatchDeleteConfirm: boolean
}>()

const emit = defineEmits<{
  (e: 'update:memoryScope', value: 'global' | 'workspace'): void
  (e: 'update:selectedWorkspaceUri', value: string): void
  (e: 'update:newEntryText', value: string): void
  (e: 'update:editingText', value: string): void
  (e: 'update:showDeleteConfirm', value: boolean): void
  (e: 'update:showBatchDeleteConfirm', value: boolean): void
  (e: 'add-entry'): void
  (e: 'toggle-select-entry', id: number): void
  (e: 'toggle-select-all'): void
  (e: 'request-delete-selected'): void
  (e: 'start-edit', entry: LogEntry): void
  (e: 'cancel-edit'): void
  (e: 'save-edit'): void
  (e: 'request-delete-entry', entry: LogEntry): void
  (e: 'confirm-delete-entry'): void
  (e: 'cancel-delete-entry'): void
  (e: 'confirm-delete-selected'): void
  (e: 'cancel-delete-selected'): void
}>()
</script>

<template>
  <!-- ─── 记忆条目管理 ─── -->
  <div class="section" data-search-anchor="memory-raw-entries">
    <h5 class="section-title">
      <i class="codicon codicon-list-flat"></i>
      {{ t('components.settings.settingsPanel.memory.rawEntries.title') }}
      <span v-if="entriesTotal > 0" class="badge">{{ entriesTotal }}</span>
    </h5>
    <p class="field-description" style="margin-bottom: 12px;">
      {{ t('components.settings.settingsPanel.memory.rawEntries.description') }}
    </p>

    <!-- 记忆作用域切换（全局 / 工作区） -->
    <div class="scope-switcher">
      <button
        class="scope-tab"
        :class="{ active: memoryScope === 'global' }"
        :title="t('components.settings.settingsPanel.memory.rawEntries.scopeGlobalHint')"
        @click="emit('update:memoryScope', 'global')"
      >
        <i class="codicon codicon-globe"></i>
        {{ t('components.settings.settingsPanel.memory.rawEntries.scopeGlobal') }}
      </button>
      <button
        class="scope-tab"
        :class="{ active: memoryScope === 'workspace' }"
        :title="t('components.settings.settingsPanel.memory.rawEntries.scopeWorkspaceHint')"
        @click="emit('update:memoryScope', 'workspace')"
      >
        <i class="codicon codicon-folder"></i>
        {{ t('components.settings.settingsPanel.memory.rawEntries.scopeWorkspace') }}
      </button>
    </div>

    <!-- 工作区记忆分区：选择工作区（当前打开的 + 已有记忆数据的） -->
    <div v-if="memoryScope === 'workspace'" class="scope-workspace-picker">
      <label class="param-label">
        {{ t('components.settings.settingsPanel.memory.rawEntries.selectScopeWorkspace') }}
      </label>
      <select
        :value="selectedWorkspaceUri"
        class="scope-workspace-select"
        :disabled="scopesLoading || workspaceScopes.length === 0"
        @change="emit('update:selectedWorkspaceUri', ($event.target as HTMLSelectElement).value)"
      >
        <option v-if="scopesLoading" value="" disabled>
          {{ t('common.loading') }}
        </option>
        <option v-for="ws in workspaceScopes" :key="ws.uri" :value="ws.uri">{{ ws.name }}</option>
      </select>
      <p v-if="!scopesLoading && workspaceScopes.length === 0" class="field-description">
        {{ t('components.settings.settingsPanel.memory.rawEntries.workspaceNone') }}
      </p>
    </div>

    <!-- 手动新增记忆 -->
    <div class="add-entry-box">
      <textarea
        :value="newEntryText"
        class="form-textarea add-entry-textarea"
        rows="3"
        :placeholder="t('components.settings.settingsPanel.memory.rawEntries.addPlaceholder')"
        :disabled="addingEntry || (memoryScope === 'workspace' && !selectedWorkspaceUri)"
        @input="emit('update:newEntryText', ($event.target as HTMLTextAreaElement).value)"
        @keydown.ctrl.enter.prevent="emit('add-entry')"
        @keydown.meta.enter.prevent="emit('add-entry')"
      ></textarea>
      <div class="add-entry-actions">
        <span class="char-count" :class="{ 'char-overflow': newEntryBytes > entryChars }">
          {{ newEntryBytes }}/{{ entryChars }} {{ t('components.settings.settingsPanel.memory.runtime.entryChars.unit') }}
        </span>
        <button class="btn btn-sm btn-primary" @click="emit('add-entry')" :disabled="addingEntry || (memoryScope === 'workspace' && !selectedWorkspaceUri)">
          <i v-if="addingEntry" class="codicon codicon-loading codicon-modifier-spin"></i>
          <i v-else class="codicon codicon-add"></i>
          {{ t('components.settings.settingsPanel.memory.rawEntries.add') }}
        </button>
      </div>
    </div>

    <!-- 截断提示：条目超过展示上限时提示，避免误以为数据丢失 -->
    <div v-if="entriesTruncated" class="truncated-notice">
      <i class="codicon codicon-info"></i>
      {{ t('components.settings.settingsPanel.memory.rawEntries.truncatedNotice', { limit: 5000 }) }}
    </div>

    <!-- 条目工具栏：全选 + 批量删除 -->
    <div v-if="entries.length > 0" class="entries-toolbar">
      <label class="select-all-label">
        <input
          type="checkbox"
          class="entry-checkbox"
          :checked="isAllSelected"
          :disabled="entriesLoading"
          @change="emit('toggle-select-all')"
        />
        {{ t('components.settings.settingsPanel.memory.rawEntries.selectAll') }}
      </label>
      <button
        class="btn btn-sm btn-danger"
        :disabled="batchDeleteCount === 0 || entriesLoading || batchDeleteSaving"
        @click="emit('request-delete-selected')"
      >
        <i v-if="batchDeleteSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
        <i v-else class="codicon codicon-trash"></i>
        {{ t('components.settings.settingsPanel.memory.rawEntries.deleteSelected', { count: batchDeleteCount }) }}
      </button>
    </div>

    <!-- 空状态 / 加载占位 / 条目列表（三分支互斥：加载中显示占位，避免闪白与回顶） -->
    <div v-if="entriesLoading" class="entries-loading">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      {{ t('components.settings.settingsPanel.memory.loading') }}
    </div>
    <div v-else-if="entries.length === 0" class="empty-entries">
      <i class="codicon codicon-info"></i>
      {{ t('components.settings.settingsPanel.memory.rawEntries.empty') }}
    </div>

    <!-- 条目列表 -->
    <div v-else class="entries-list">
      <div v-for="entry in entries" :key="entry.id" class="entry-row">
        <input
          v-if="editingId !== entry.id"
          type="checkbox"
          class="entry-checkbox"
          :checked="selectedIds.has(entry.id)"
          :disabled="entriesLoading || batchDeleteSaving"
          @change="emit('toggle-select-entry', entry.id)"
        />
        <span class="entry-id">#{{ entry.id }}</span>
        <span class="entry-date">{{ entry.date }}</span>
        <div class="entry-text-wrap">
          <pre v-if="editingId !== entry.id" class="entry-text">{{ entry.text }}</pre>
          <div v-else class="entry-edit-row">
            <!-- 不设 maxlength：后端按 trim 后 UTF-8 字节数校验（entryChars），
                 maxlength 按 UTF-16 码元计数会与字节校验不一致；保存时仍做字节拦截 -->
            <textarea
              :value="editingText"
              class="entry-textarea"
              rows="3"
              @input="emit('update:editingText', ($event.target as HTMLTextAreaElement).value)"
            ></textarea>
            <div class="entry-edit-actions">
              <button class="btn btn-sm btn-primary" @click="emit('save-edit')" :disabled="editSaving">
                <i v-if="editSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
                <i v-else class="codicon codicon-check"></i>
                {{ t('common.save') }}
              </button>
              <button class="btn btn-sm btn-secondary" @click="emit('cancel-edit')" :disabled="editSaving">{{ t('common.cancel') }}</button>
              <span class="char-count" :class="{ 'char-overflow': editingBytes > entryChars }">{{ editingBytes }}/{{ entryChars }}</span>
            </div>
          </div>
        </div>
        <div class="entry-actions" v-if="editingId !== entry.id">
          <button class="btn-icon" :title="t('common.edit')" @click="emit('start-edit', entry)">
            <i class="codicon codicon-edit"></i>
          </button>
          <button class="btn-icon danger" :title="t('common.delete')" :disabled="deleteSaving || entriesLoading" @click="emit('request-delete-entry', entry)">
            <i class="codicon codicon-trash"></i>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- 删除单条记忆确认 -->
  <ConfirmDialog
    :model-value="showDeleteConfirm"
    :title="t('components.settings.settingsPanel.memory.rawEntries.deleteConfirmTitle')"
    :message="t('components.settings.settingsPanel.memory.rawEntries.deleteConfirmMessage', { id: deleteCandidate?.id ?? '' })"
    :confirm-text="t('common.delete')"
    is-danger
    @update:model-value="emit('update:showDeleteConfirm', $event)"
    @confirm="emit('confirm-delete-entry')"
    @cancel="emit('cancel-delete-entry')"
  />

  <!-- 批量删除记忆确认 -->
  <ConfirmDialog
    :model-value="showBatchDeleteConfirm"
    :title="t('components.settings.settingsPanel.memory.rawEntries.batchDeleteConfirmTitle')"
    :message="t('components.settings.settingsPanel.memory.rawEntries.batchDeleteConfirmMessage', { count: batchDeleteCount })"
    :confirm-text="t('common.delete')"
    is-danger
    @update:model-value="emit('update:showBatchDeleteConfirm', $event)"
    @confirm="emit('confirm-delete-selected')"
    @cancel="emit('cancel-delete-selected')"
  />
</template>

<style scoped>
/* 分区 */
.section {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 14px 16px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  margin: 0 0 6px 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--vscode-foreground);
}

.section-title i {
  font-size: 13px;
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  font-size: 10px;
  font-weight: 600;
  border-radius: 9px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  margin-left: 4px;
}

.field-description {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin: 0;
}

.param-label {
  font-size: 12px;
  font-weight: 500;
}

/* ─── 记忆作用域切换 ─── */
.scope-switcher {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
  padding: 3px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.scope-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.scope-tab:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

.scope-tab.active {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.scope-tab i {
  font-size: 13px;
}

.scope-workspace-picker {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.scope-workspace-select {
  flex: 1;
  max-width: 320px;
  padding: 5px 8px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
}

.scope-workspace-select:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

/* ─── 批量删除工具栏 ─── */
.entries-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.select-all-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vscode-foreground);
  cursor: pointer;
  user-select: none;
}

.entry-checkbox {
  accent-color: var(--vscode-focusBorder);
  flex-shrink: 0;
  margin: 2px 0 0 0;
}

/* ─── 条目列表 ─── */
.entries-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 96px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.entries-loading i {
  font-size: 13px;
}

.empty-entries {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px 0;
  font-size: 13px;
  color: var(--vscode-descriptionForeground);
  justify-content: center;
}

.entries-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.entry-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
}

.entry-row:hover {
  border-color: var(--vscode-focusBorder);
}

.entry-id {
  font-size: 11px;
  font-weight: 600;
  font-family: var(--vscode-editor-font-family), monospace;
  color: var(--vscode-charts-blue);
  min-width: 28px;
  flex-shrink: 0;
}

.entry-date {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  min-width: 72px;
  flex-shrink: 0;
  font-family: var(--vscode-editor-font-family), monospace;
}

.entry-text-wrap {
  flex: 1;
  min-width: 0;
}

.entry-text {
  margin: 0;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family), monospace;
  color: var(--vscode-foreground);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.4;
}

.entry-edit-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.entry-textarea {
  width: 100%;
  padding: 6px 8px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family);
  background: var(--vscode-editor-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-focusBorder);
  border-radius: 3px;
  resize: vertical;
  line-height: 1.4;
}

.entry-textarea:focus {
  outline: none;
}

.entry-edit-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.char-count {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  margin-left: auto;
}

.char-overflow {
  color: var(--vscode-errorForeground);
  font-weight: 600;
}

/* ─── 手动新增记忆 ─── */
.add-entry-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}

.add-entry-textarea {
  min-height: 64px;
  resize: vertical;
}

.add-entry-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.add-entry-actions .char-count {
  margin-left: 0;
  margin-right: auto;
}

.form-textarea {
  width: 100%;
  min-height: 200px;
  padding: 8px 10px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  resize: vertical;
  line-height: 1.5;
}

.form-textarea:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.form-textarea:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.truncated-notice {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--vscode-textBlockQuote-background);
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.5;
}

.truncated-notice i {
  margin-top: 2px;
  flex-shrink: 0;
}

.entry-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  align-self: center;
}

/* 按钮 */
.btn {
  padding: 6px 14px;
  font-size: 12px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: opacity 0.15s;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn i {
  font-size: 13px;
}

.btn-primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.btn-primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.btn-secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--vscode-button-secondaryHoverBackground);
}

.btn-sm {
  padding: 3px 10px;
  font-size: 11px;
}

.btn-icon {
  padding: 4px;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
}

.btn-icon:hover {
  background: var(--vscode-toolbar-hoverBackground);
  color: var(--vscode-foreground);
}

.btn-icon i {
  font-size: 14px;
}

.btn-danger {
  background: var(--vscode-errorForeground, #f14c4c);
  color: var(--vscode-button-foreground, #ffffff);
}

.btn-danger:hover:not(:disabled) {
  opacity: 0.85;
}
</style>
