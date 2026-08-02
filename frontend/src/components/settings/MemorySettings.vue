<script setup lang="ts">
/**
 * MemorySettings - 永久记忆系统配置组件
 *
 * 包含两部分：
 * 1. 提示词 & 运行时参数配置
 * 2. 原始记忆条目管理（查看 / 编辑 / 删除）
 */
import { ref, onMounted } from 'vue'
import { CustomCheckbox } from '../common'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'

const { t } = useI18n()

// 内置默认提示词（与 PromptManager.generateMemorySection 保持一致）
const DEFAULT_SYSTEM_PROMPT = [
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
].join('\n')

const isLoading = ref(true)
const isSaving = ref(false)
const statusMessage = ref('')
const enabled = ref(true)

// 记忆提示词（systemPrompt）— 初始化为默认值，方便用户直接编辑
const systemPrompt = ref(DEFAULT_SYSTEM_PROMPT)

// 运行时参数
const wakeLines = ref(96)
const entryChars = ref(280)
const partChars = ref(20000)
const partLines = ref(500)

// ─── 记忆条目管理 ───
interface LogEntry {
  id: number
  date: string
  text: string
}
const entries = ref<LogEntry[]>([])
const entriesLoading = ref(false)
const entriesTotal = ref(0)
const editingId = ref<number | null>(null)
const editingText = ref('')
const editSaving = ref(false)

// 加载配置
async function loadConfig() {
  isLoading.value = true
  statusMessage.value = ''
  try {
    const config = await sendToExtension<any>('getMemoryConfig', {})
    if (config) {
      if (typeof config.enabled === 'boolean') enabled.value = config.enabled
      if (typeof config.systemPrompt === 'string' && config.systemPrompt.trim()) {
        systemPrompt.value = config.systemPrompt
      }
      if (typeof config.wakeLines === 'number') wakeLines.value = config.wakeLines
      if (typeof config.entryChars === 'number') entryChars.value = config.entryChars
      if (typeof config.partChars === 'number') partChars.value = config.partChars
      if (typeof config.partLines === 'number') partLines.value = config.partLines
    }
  } catch (e: any) {
    statusMessage.value = e?.message || 'Failed to load config'
  } finally {
    isLoading.value = false
  }
}

// 加载记忆条目
async function loadEntries() {
  entriesLoading.value = true
  try {
    const result = await sendToExtension<any>('getMemoryEntries', {})
    if (result?.entries) {
      entries.value = result.entries
      entriesTotal.value = result.total ?? result.entries.length
    } else {
      entries.value = []
      entriesTotal.value = 0
    }
  } catch {
    entries.value = []
  } finally {
    entriesLoading.value = false
  }
}

// 开始编辑
function startEdit(entry: LogEntry) {
  editingId.value = entry.id
  editingText.value = entry.text
}

// 取消编辑
function cancelEdit() {
  editingId.value = null
  editingText.value = ''
}

// 保存编辑
async function saveEdit() {
  if (editingId.value === null) return
  editSaving.value = true
  try {
    await sendToExtension('updateMemoryEntry', {
      id: editingId.value,
      text: editingText.value,
    })
    // 更新本地缓存
    const idx = entries.value.findIndex(e => e.id === editingId.value)
    if (idx !== -1) {
      entries.value[idx] = { ...entries.value[idx], text: editingText.value.trim() }
    }
    cancelEdit()
  } catch (e: any) {
    statusMessage.value = e?.message || 'Failed to update entry'
  } finally {
    editSaving.value = false
  }
}

// 保存配置
async function saveConfig() {
  isSaving.value = true
  statusMessage.value = ''
  try {
    const promptToSave = systemPrompt.value === DEFAULT_SYSTEM_PROMPT ? '' : systemPrompt.value
    await sendToExtension('updateMemoryConfig', {
      config: {
        enabled: enabled.value,
        systemPrompt: promptToSave,
        wakeLines: wakeLines.value,
        entryChars: entryChars.value,
        partChars: partChars.value,
        partLines: partLines.value,
      },
    })
    statusMessage.value = t('components.settings.settingsPanel.memory.saved')
    setTimeout(() => { statusMessage.value = '' }, 3000)
  } catch (e: any) {
    statusMessage.value = e?.message || 'Failed to save config'
  } finally {
    isSaving.value = false
  }
}

// 重置为默认
function resetToDefault() {
  enabled.value = true
  systemPrompt.value = DEFAULT_SYSTEM_PROMPT
  wakeLines.value = 96
  entryChars.value = 280
  partChars.value = 20000
  partLines.value = 500
}

onMounted(() => {
  loadConfig()
  loadEntries()
})
</script>

<template>
  <div class="memory-settings">
    <div v-if="isLoading" class="loading-state">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      {{ t('components.settings.settingsPanel.memory.loading') }}
    </div>

    <div v-else class="settings-form">
      <!-- 长期记忆总开关 -->
      <div class="section memory-toggle-section">
        <CustomCheckbox
          v-model="enabled"
          :label="t('components.settings.settingsPanel.memory.enabled.label')"
          :hint="t('components.settings.settingsPanel.memory.enabled.description')"
        />
        <p v-if="!enabled" class="disabled-notice">
          <i class="codicon codicon-info"></i>
          {{ t('components.settings.settingsPanel.memory.enabled.disabledNotice') }}
        </p>
      </div>

      <!-- 自定义提示词 -->
      <div class="form-group">
        <label class="group-label">
          <i class="codicon codicon-note"></i>
          {{ t('components.settings.settingsPanel.memory.systemPrompt.title') }}
        </label>
        <p class="field-description">
          {{ t('components.settings.settingsPanel.memory.systemPrompt.description') }}
        </p>
        <textarea
          v-model="systemPrompt"
          class="form-textarea"
          rows="16"
          :disabled="!enabled"
        ></textarea>
      </div>

      <!-- 运行时参数 -->
      <div class="section">
        <h5 class="section-title">
          <i class="codicon codicon-settings-gear"></i>
          {{ t('components.settings.settingsPanel.memory.runtime.title') }}
        </h5>
        <p class="field-description" style="margin-bottom: 12px;">
          {{ t('components.settings.settingsPanel.memory.runtime.description') }}
        </p>

        <div class="params-grid">
          <div class="form-group">
            <label class="param-label">
              {{ t('components.settings.settingsPanel.memory.runtime.wakeLines.label') }}
            </label>
            <p class="field-description">
              {{ t('components.settings.settingsPanel.memory.runtime.wakeLines.description') }}
            </p>
            <div class="number-input-row">
              <input type="number" v-model.number="wakeLines" min="1" max="500" class="form-input-number" :disabled="!enabled" />
              <span class="unit">{{ t('components.settings.settingsPanel.memory.runtime.wakeLines.unit') }}</span>
            </div>
          </div>
          <div class="form-group">
            <label class="param-label">
              {{ t('components.settings.settingsPanel.memory.runtime.entryChars.label') }}
            </label>
            <p class="field-description">
              {{ t('components.settings.settingsPanel.memory.runtime.entryChars.description') }}
            </p>
            <div class="number-input-row">
              <input type="number" v-model.number="entryChars" min="1" max="280" class="form-input-number" :disabled="!enabled" />
              <span class="unit">{{ t('components.settings.settingsPanel.memory.runtime.entryChars.unit') }}</span>
            </div>
          </div>
          <div class="form-group">
            <label class="param-label">
              {{ t('components.settings.settingsPanel.memory.runtime.partChars.label') }}
            </label>
            <p class="field-description">
              {{ t('components.settings.settingsPanel.memory.runtime.partChars.description') }}
            </p>
            <div class="number-input-row">
              <input type="number" v-model.number="partChars" min="100" max="100000" step="100" class="form-input-number" :disabled="!enabled" />
              <span class="unit">{{ t('components.settings.settingsPanel.memory.runtime.partChars.unit') }}</span>
            </div>
          </div>
          <div class="form-group">
            <label class="param-label">
              {{ t('components.settings.settingsPanel.memory.runtime.partLines.label') }}
            </label>
            <p class="field-description">
              {{ t('components.settings.settingsPanel.memory.runtime.partLines.description') }}
            </p>
            <div class="number-input-row">
              <input type="number" v-model.number="partLines" min="10" max="2000" step="10" class="form-input-number" :disabled="!enabled" />
              <span class="unit">{{ t('components.settings.settingsPanel.memory.runtime.partLines.unit') }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="form-actions">
        <button class="btn btn-primary" @click="saveConfig" :disabled="isSaving">
          <i v-if="isSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
          <i v-else class="codicon codicon-save"></i>
          {{ isSaving ? t('components.settings.settingsPanel.memory.saving') : t('components.settings.settingsPanel.memory.save') }}
        </button>
        <button class="btn btn-secondary" @click="resetToDefault">
          <i class="codicon codicon-discard"></i>
          {{ t('components.settings.settingsPanel.memory.reset') }}
        </button>
        <button class="btn btn-secondary" @click="loadEntries" :disabled="entriesLoading">
          <i :class="entriesLoading ? 'codicon codicon-loading codicon-modifier-spin' : 'codicon codicon-refresh'"></i>
          {{ t('common.refresh') }}
        </button>
      </div>

      <!-- 状态消息 -->
      <div v-if="statusMessage" class="status-message" :class="{ 'status-error': statusMessage.includes('Failed') || statusMessage.includes('失败') }">
        {{ statusMessage }}
      </div>

      <!-- ─── 记忆条目管理 ─── -->
      <div class="section">
        <h5 class="section-title">
          <i class="codicon codicon-list-flat"></i>
          {{ t('components.settings.settingsPanel.memory.rawEntries.title') }}
          <span v-if="entriesTotal > 0" class="badge">{{ entriesTotal }}</span>
        </h5>
        <p class="field-description" style="margin-bottom: 12px;">
          {{ t('components.settings.settingsPanel.memory.rawEntries.description') }}
        </p>

        <!-- 空状态 -->
        <div v-if="!entriesLoading && entries.length === 0" class="empty-entries">
          <i class="codicon codicon-info"></i>
          {{ t('components.settings.settingsPanel.memory.rawEntries.empty') }}
        </div>

        <!-- 条目列表 -->
        <div v-else class="entries-list">
          <div v-for="entry in entries" :key="entry.id" class="entry-row">
            <span class="entry-id">#{{ entry.id }}</span>
            <span class="entry-date">{{ entry.date }}</span>
            <div class="entry-text-wrap">
              <pre v-if="editingId !== entry.id" class="entry-text">{{ entry.text }}</pre>
              <div v-else class="entry-edit-row">
                <textarea
                  v-model="editingText"
                  class="entry-textarea"
                  rows="3"
                  :maxlength="entryChars"
                ></textarea>
                <div class="entry-edit-actions">
                  <button class="btn btn-sm btn-primary" @click="saveEdit" :disabled="editSaving">
                    <i v-if="editSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
                    <i v-else class="codicon codicon-check"></i>
                    {{ t('common.save') }}
                  </button>
                  <button class="btn btn-sm btn-secondary" @click="cancelEdit" :disabled="editSaving">{{ t('common.cancel') }}</button>
                  <span class="char-count">{{ editingText.length }}/{{ entryChars }}</span>
                </div>
              </div>
            </div>
            <div class="entry-actions" v-if="editingId !== entry.id">
              <button class="btn-icon" :title="t('common.edit')" @click="startEdit(entry)">
                <i class="codicon codicon-edit"></i>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 提示 -->
      <div class="info-box">
        <i class="codicon codicon-info"></i>
        <div>
          <strong>{{ t('components.settings.settingsPanel.memory.info.title') }}</strong>
          <p>{{ t('components.settings.settingsPanel.memory.info.text') }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memory-settings {
  width: 100%;
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.group-label {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

.group-label i {
  font-size: 14px;
}

.field-description {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  margin: 0;
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

.form-textarea:disabled,
.form-input-number:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.memory-toggle-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.disabled-notice {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--vscode-textBlockQuote-background);
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.5;
}

.disabled-notice i {
  margin-top: 2px;
  flex-shrink: 0;
}

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

/* 参数网格 */
.params-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.param-label {
  font-size: 12px;
  font-weight: 500;
}

.number-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-input-number {
  flex: 1;
  padding: 5px 8px;
  font-size: 13px;
  font-family: var(--vscode-editor-font-family);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  appearance: textfield;
}

.form-input-number::-webkit-outer-spin-button,
.form-input-number::-webkit-inner-spin-button {
  appearance: none;
}

.form-input-number:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
}

.unit {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}

/* 按钮 */
.form-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

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

.status-message {
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--vscode-inputValidation-infoBackground);
  color: var(--vscode-inputValidation-infoForeground);
  border: 1px solid var(--vscode-inputValidation-infoBorder);
}

.status-error {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--vscode-inputValidation-errorForeground);
  border-color: var(--vscode-inputValidation-errorBorder);
}

.info-box {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  background: var(--vscode-textBlockQuote-background);
  border-left: 3px solid var(--vscode-textBlockQuote-border);
  border-radius: 4px;
  font-size: 12px;
}

.info-box i {
  font-size: 14px;
  margin-top: 1px;
  flex-shrink: 0;
}

.info-box strong {
  display: block;
  margin-bottom: 4px;
}

.info-box p {
  margin: 0;
  color: var(--vscode-descriptionForeground);
}

.loading-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 40px 0;
  font-size: 13px;
  color: var(--vscode-descriptionForeground);
  justify-content: center;
}

/* ─── 条目列表 ─── */
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

.entry-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  align-self: center;
}
</style>
