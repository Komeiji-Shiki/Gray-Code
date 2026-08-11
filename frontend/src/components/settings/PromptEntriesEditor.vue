<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { getSettingsView } from '@/composables/useDeferredNumberInput'
import type { PromptModule, PromptEntryRole, PromptEntry } from './prompt/types'

const CHAT_HISTORY_PROMPT_ENTRY_ID = 'chat-history'

const props = defineProps<{
  modelValue: PromptEntry[]
  staticModules: PromptModule[]
  dynamicModules: PromptModule[]
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: PromptEntry[]): void
  (event: 'convert-legacy'): void
}>()

const roleOptions: Array<{ value: PromptEntryRole; label: string; description: string }> = [
  { value: 'system', label: 'system', description: '合并进系统提示词' },
  { value: 'user', label: 'user', description: '作为临时用户上下文插入' },
  { value: 'assistant', label: 'assistant', description: '作为临时助手消息插入' }
]

type DropPosition = 'before' | 'after'

const dragSourceId = ref<string | null>(null)
const dropIndicator = ref<{ id: string; position: DropPosition } | null>(null)

// 条目名称草稿：清空后不立即回填「Prompt N」（编辑期间保持为空），
// 离开设置页时仍为空的名称自动回填最后一次提交的名称。
const nameDrafts = reactive<Record<string, string>>({})

function handleNameInput(entry: PromptEntry, event: Event) {
  if (isChatHistoryEntry(entry)) return
  const raw = readInputValue(event)
  nameDrafts[entry.id] = raw
  // IME 合成期间不提交（中文输入过程的中间拼音/单字不被提交为条目名称）；
  // 草稿仍跟随输入，compositionend 后会再次触发 input 完成最终提交。
  if ((event as InputEvent).isComposing) return
  const trimmed = raw.trim()
  if (trimmed && trimmed !== entry.name) {
    updateEntry(entry.id, { name: trimmed })
  }
}

// 离开设置页：空名称自动回填（新条目回填「Prompt N」，被清空的回填上次提交的名称）
watch(
  getSettingsView,
  (view) => {
    if (view !== 'settings') {
      let changed = false
      const next = entries.value.map((entry, index) => {
        if (isChatHistoryEntry(entry)) return entry
        const current = nameDrafts[entry.id] ?? entry.name
        if (!current.trim()) {
          // 回填「最后一次提交的名称」：entry.name 始终为已提交的非空名称
          // （用户输入时 handleNameInput 已同步提交；新建条目 createEntry 默认 Prompt N），
          // 不会覆盖用户之前提交的自定义名称（如清空「我的工具」应回填「我的工具」而非「Prompt N」）。
          const fallback = entry.name.trim() || `Prompt ${index + 1}`
          nameDrafts[entry.id] = fallback
          if (entry.name !== fallback) {
            changed = true
            return { ...entry, name: fallback }
          }
        }
        return entry
      })
      if (changed) emitNormalized(next)
    }
  }
)

const entries = computed(() => normalizeEntries(props.modelValue))

function isChatHistoryEntry(entry: PromptEntry): boolean {
  return entry.type === 'chat_history' || entry.id === CHAT_HISTORY_PROMPT_ENTRY_ID
}

function createChatHistoryEntry(order = 1000): PromptEntry {
  return {
    id: CHAT_HISTORY_PROMPT_ENTRY_ID,
    name: 'Chat History',
    type: 'chat_history',
    enabled: true,
    role: 'user',
    content: '',
    fakeThought: '',
    order
  }
}

function normalizePromptEntry(raw: PromptEntry, index: number, usedIds: Set<string>): PromptEntry {
  const rawType = raw.type === 'chat_history' || raw.id === CHAT_HISTORY_PROMPT_ENTRY_ID ? 'chat_history' : 'prompt'

  if (rawType === 'chat_history') {
    return {
      ...createChatHistoryEntry(index),
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Chat History',
      order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : index
    }
  }

  const fallbackId = `entry_${index}`
  let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : fallbackId
  if (id === CHAT_HISTORY_PROMPT_ENTRY_ID) {
    id = `${id}_${index}`
  }
  if (usedIds.has(id)) {
    id = `${id}_${index}`
  }
  usedIds.add(id)

  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Prompt ${index + 1}`,
    type: 'prompt',
    enabled: raw.enabled !== false,
    role: raw.role === 'user' || raw.role === 'assistant' || raw.role === 'system' ? raw.role : 'system',
    content: typeof raw.content === 'string' ? raw.content : '',
    fakeThought: typeof raw.fakeThought === 'string' ? raw.fakeThought : '',
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : index
  }
}

function normalizeEntries(value: PromptEntry[] | undefined): PromptEntry[] {
  if (!Array.isArray(value)) {
    return [createChatHistoryEntry(0)]
  }

  const usedIds = new Set<string>()
  const normalized: PromptEntry[] = []
  let hasChatHistory = false

  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return
    const normalizedEntry = normalizePromptEntry(entry, index, usedIds)
    if (isChatHistoryEntry(normalizedEntry)) {
      if (hasChatHistory) return
      hasChatHistory = true
    }
    normalized.push(normalizedEntry)
  })

  if (!hasChatHistory) {
    normalized.push(createChatHistoryEntry(normalized.length))
  }

  return normalized
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((entry, index) => ({ ...entry, order: index }))
}

function emitNormalized(nextEntries: PromptEntry[]) {
  const entriesWithCurrentOrder = nextEntries.map((entry, index) => ({
    ...entry,
    order: index
  }))

  emit('update:modelValue', normalizeEntries(entriesWithCurrentOrder))
}

function createEntry(role: PromptEntryRole = 'system'): PromptEntry {
  const nextOrder = entries.value.length
  const timestamp = Date.now()
  return {
    id: `entry_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
    name: `Prompt ${nextOrder + 1}`,
    type: 'prompt',
    enabled: true,
    role,
    content: '',
    fakeThought: '',
    order: nextOrder
  }
}

function addEntry(role: PromptEntryRole = 'system') {
  const entry = createEntry(role)
  // 新建条目名称不自动补全（输入框保持为空）；离开设置页时回填「Prompt N」
  nameDrafts[entry.id] = ''
  emitNormalized([...entries.value, entry])
}

function removeEntry(id: string) {
  const target = entries.value.find(entry => entry.id === id)
  if (!target || isChatHistoryEntry(target)) return
  delete nameDrafts[id]
  emitNormalized(entries.value.filter(entry => entry.id !== id))
}

function duplicateEntry(id: string) {
  const ordered = [...entries.value]
  const index = ordered.findIndex(entry => entry.id === id)
  if (index < 0) return

  const source = ordered[index]
  if (isChatHistoryEntry(source)) return

  const copy: PromptEntry = {
    ...source,
    id: `entry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: `${source.name} Copy`,
    type: 'prompt',
    order: source.order + 0.5
  }
  ordered.splice(index + 1, 0, copy)
  emitNormalized(ordered)
}

function moveEntry(id: string, direction: -1 | 1) {
  const ordered = [...entries.value]
  const index = ordered.findIndex(entry => entry.id === id)
  const nextIndex = index + direction
  if (index < 0 || nextIndex < 0 || nextIndex >= ordered.length) return

  const [entry] = ordered.splice(index, 1)
  ordered.splice(nextIndex, 0, entry)
  emitNormalized(ordered)
}

// 拖拽手柄键盘支持：方向键重排（Home/End 跳转首尾），弥补纯拖拽无键盘可达性
function handleDragHandleKeydown(id: string, event: KeyboardEvent) {
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveEntry(id, -1)
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveEntry(id, 1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    const ordered = [...entries.value]
    const index = ordered.findIndex(entry => entry.id === id)
    if (index <= 0) return
    const [entry] = ordered.splice(index, 1)
    ordered.unshift(entry)
    emitNormalized(ordered)
  } else if (event.key === 'End') {
    event.preventDefault()
    const ordered = [...entries.value]
    const index = ordered.findIndex(entry => entry.id === id)
    if (index < 0 || index === ordered.length - 1) return
    const [entry] = ordered.splice(index, 1)
    ordered.push(entry)
    emitNormalized(ordered)
  }
}

function updateEntry(id: string, patch: Partial<PromptEntry>) {
  emitNormalized(entries.value.map(entry => {
    if (entry.id !== id) return entry

    if (isChatHistoryEntry(entry)) {
      return {
        ...entry,
        name: typeof patch.name === 'string' ? patch.name : entry.name,
        type: 'chat_history',
        enabled: true,
        role: 'user',
        content: '',
        fakeThought: ''
      }
    }

    return { ...entry, ...patch, type: 'prompt' }
  }))
}

function readInputValue(event: Event): string {
  return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ?? ''
}

function readCheckedValue(event: Event): boolean {
  return (event.target as HTMLInputElement | null)?.checked === true
}

function updateRole(id: string, event: Event) {
  const target = entries.value.find(entry => entry.id === id)
  if (!target || isChatHistoryEntry(target)) return

  const value = readInputValue(event)
  if (value === 'system' || value === 'user' || value === 'assistant') {
    updateEntry(id, { role: value })
  }
}

function appendPlaceholder(entry: PromptEntry, moduleId: string) {
  if (isChatHistoryEntry(entry)) return

  const placeholder = `{{$${moduleId}}}`
  const separator = entry.content && !entry.content.endsWith('\n') ? '\n\n' : ''
  updateEntry(entry.id, { content: `${entry.content}${separator}${placeholder}` })
}

function formatPlaceholder(moduleId: string): string {
  return `{{$${moduleId}}}`
}

function handleDragStart(id: string, event: DragEvent) {
  dragSourceId.value = id
  event.dataTransfer?.setData('text/plain', id)

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'

    const card = (event.currentTarget as HTMLElement | null)?.closest('.entry-card') as HTMLElement | null
    if (card) {
      event.dataTransfer.setDragImage(card, 20, 20)
    }
  }
}

function getDropPosition(event: DragEvent): DropPosition {
  const target = event.currentTarget as HTMLElement | null
  if (!target) return 'before'

  const rect = target.getBoundingClientRect()
  const pointerOffset = event.clientY - rect.top
  return pointerOffset < rect.height / 2 ? 'before' : 'after'
}

function updateDropIndicator(id: string, event: DragEvent) {
  if (!dragSourceId.value || dragSourceId.value === id) {
    dropIndicator.value = null
    return
  }

  dropIndicator.value = {
    id,
    position: getDropPosition(event)
  }
}

function handleDragOver(id: string, event: DragEvent) {
  event.preventDefault()
  updateDropIndicator(id, event)

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
}

function handleDragLeave(id: string, event: DragEvent) {
  const currentTarget = event.currentTarget as HTMLElement | null
  const nextTarget = event.relatedTarget as Node | null
  if (currentTarget && nextTarget && currentTarget.contains(nextTarget)) return

  if (dropIndicator.value?.id === id) {
    dropIndicator.value = null
  }
}

function isDropIndicator(id: string, position: DropPosition): boolean {
  return dropIndicator.value?.id === id && dropIndicator.value.position === position
}

function reorderEntries(sourceId: string, targetId: string, position: DropPosition) {
  if (sourceId === targetId) return

  const ordered = [...entries.value]
  const sourceIndex = ordered.findIndex(entry => entry.id === sourceId)
  const targetIndex = ordered.findIndex(entry => entry.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0) return

  const [source] = ordered.splice(sourceIndex, 1)
  const targetIndexAfterRemoval = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex
  const insertIndex = position === 'after' ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval
  const clampedInsertIndex = Math.max(0, Math.min(insertIndex, ordered.length))

  ordered.splice(clampedInsertIndex, 0, source)
  emitNormalized(ordered)
}

function handleDrop(targetId: string, event: DragEvent) {
  event.preventDefault()
  const sourceId = dragSourceId.value || event.dataTransfer?.getData('text/plain')
  const position = dropIndicator.value?.id === targetId ? dropIndicator.value.position : getDropPosition(event)

  dragSourceId.value = null
  dropIndicator.value = null
  if (!sourceId) return

  reorderEntries(sourceId, targetId, position)
}

function handleDragEnd() {
  dragSourceId.value = null
  dropIndicator.value = null
}
</script>

<template>
  <div class="prompt-entries-editor">
    <div class="entries-toolbar">
      <div class="entries-summary">
        <span class="entries-count">{{ entries.length }} 个条目</span>
        <span class="entries-hint">
          预设模式会按这里的顺序组装。Chat History 表示真实聊天历史插入点，可拖动调整位置。
        </span>
      </div>
      <div class="entries-actions">
        <button class="small-btn" type="button" @click="emit('convert-legacy')">
          <i class="codicon codicon-git-compare"></i>
          从传统模板转换
        </button>
        <button class="small-btn primary" type="button" @click="addEntry('system')">
          <i class="codicon codicon-add"></i>
          新增条目
        </button>
      </div>
    </div>

    <div class="entries-list">
      <article
        v-for="(entry, index) in entries"
        :key="entry.id"
        class="entry-card"
        :class="{
          disabled: !entry.enabled,
          'chat-history-card': isChatHistoryEntry(entry),
          'drop-before': isDropIndicator(entry.id, 'before'),
          'drop-after': isDropIndicator(entry.id, 'after'),
          dragging: dragSourceId === entry.id
        }"
        @dragover="handleDragOver(entry.id, $event)"
        @dragleave="handleDragLeave(entry.id, $event)"
        @drop="handleDrop(entry.id, $event)"
        @dragend="handleDragEnd"
      >
        <header class="entry-header">
          <span
            class="drag-handle"
            role="button"
            tabindex="0"
            draggable="true"
            title="拖动排序"
            aria-label="拖动排序"
            @dragstart="handleDragStart(entry.id, $event)"
            @dragend="handleDragEnd"
            @keydown="handleDragHandleKeydown(entry.id, $event)"
          >
            <i class="codicon codicon-gripper"></i>
          </span>

          <label
            v-if="!isChatHistoryEntry(entry)"
            class="entry-enabled"
            :title="entry.enabled ? '已启用' : '已禁用'"
          >
            <input
              type="checkbox"
              :checked="entry.enabled"
              @change="updateEntry(entry.id, { enabled: readCheckedValue($event) })"
            />
            <span>{{ entry.enabled ? '启用' : '禁用' }}</span>
          </label>
          <span v-else class="entry-enabled locked" title="Chat History 始终启用，避免真实历史丢失">
            <i class="codicon codicon-lock"></i>
            必启用
          </span>

          <input
            class="entry-name-input"
            :value="nameDrafts[entry.id] ?? entry.name"
            placeholder="条目名称"
            @input="handleNameInput(entry, $event)"
          />

          <select
            v-if="!isChatHistoryEntry(entry)"
            class="entry-role-select"
            :value="entry.role"
            @change="updateRole(entry.id, $event)"
          >
            <option v-for="option in roleOptions" :key="option.value" :value="option.value">
              {{ option.label }} - {{ option.description }}
            </option>
          </select>
          <div v-else class="entry-role-pill">
            <i class="codicon codicon-history"></i>
            chat-history
          </div>

          <div class="entry-buttons">
            <button class="icon-btn" type="button" :disabled="index === 0" title="上移" @click="moveEntry(entry.id, -1)">
              <i class="codicon codicon-arrow-up"></i>
            </button>
            <button class="icon-btn" type="button" :disabled="index === entries.length - 1" title="下移" @click="moveEntry(entry.id, 1)">
              <i class="codicon codicon-arrow-down"></i>
            </button>
            <button class="icon-btn" type="button" :disabled="isChatHistoryEntry(entry)" title="复制" @click="duplicateEntry(entry.id)">
              <i class="codicon codicon-copy"></i>
            </button>
            <button class="icon-btn danger" type="button" :disabled="isChatHistoryEntry(entry)" title="删除" @click="removeEntry(entry.id)">
              <i class="codicon codicon-trash"></i>
            </button>
          </div>
        </header>

        <div v-if="isChatHistoryEntry(entry)" class="chat-history-note">
          <i class="codicon codicon-info"></i>
          <div>
            <strong>真实对话历史会插入在这里</strong>
            <p>该条目不会作为普通消息发送，不可删除、不可复制、不可禁用，但可以拖动或上下移动来控制历史在预设骨架中的位置。</p>
          </div>
        </div>

        <template v-else>
          <textarea
            class="entry-content-textarea"
            :value="entry.content"
            placeholder="输入提示词内容，可使用 {{$ENVIRONMENT}}、{{$TODO_LIST}} 等变量"
            rows="8"
            @input="updateEntry(entry.id, { content: readInputValue($event) })"
          ></textarea>

          <div v-if="entry.role === 'assistant'" class="entry-fake-thought">
            <label class="fake-thought-label" title="仅 assistant（临时助手消息）可伪造思考过程">
              伪造思考过程
              <span class="fake-thought-hint">可选，随该条 assistant 消息以思考内容回传；渠道关闭「发送历史思考内容」时不发送</span>
            </label>
            <textarea
              class="fake-thought-textarea"
              :value="entry.fakeThought ?? ''"
              placeholder="输入伪造的 AI 思考过程，留空则不伪造"
              rows="3"
              @input="updateEntry(entry.id, { fakeThought: readInputValue($event) })"
            ></textarea>
          </div>

          <details class="entry-modules">
            <summary>插入变量</summary>
            <div class="module-chip-group">
              <span class="chip-group-label">静态</span>
              <button
                v-for="module in staticModules"
                :key="module.id"
                class="module-chip"
                type="button"
                :title="module.description"
                @click="appendPlaceholder(entry, module.id)"
              >
                {{ formatPlaceholder(module.id) }}
              </button>
            </div>
            <div class="module-chip-group">
              <span class="chip-group-label">动态</span>
              <button
                v-for="module in dynamicModules"
                :key="module.id"
                class="module-chip dynamic"
                type="button"
                :title="module.description"
                @click="appendPlaceholder(entry, module.id)"
              >
                {{ formatPlaceholder(module.id) }}
              </button>
            </div>
          </details>
        </template>
      </article>
    </div>
  </div>
</template>

<style scoped>
.prompt-entries-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.entries-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.entries-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 240px;
}

.entries-count {
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.entries-hint {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.45;
}

.entries-actions,
.entry-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.small-btn,
.icon-btn,
.drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 5px;
  background: transparent;
  color: var(--vscode-foreground);
  cursor: pointer;
  transition: background-color 0.15s, border-color 0.15s;
}

.small-btn {
  padding: 5px 10px;
  font-size: 11px;
}

.small-btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}

.icon-btn,
.drag-handle {
  width: 26px;
  height: 26px;
  padding: 0;
}

.drag-handle {
  cursor: grab;
  color: var(--vscode-descriptionForeground);
}

.drag-handle:active {
  cursor: grabbing;
}

.small-btn:hover:not(:disabled),
.icon-btn:hover:not(:disabled),
.drag-handle:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
  border-color: var(--vscode-focusBorder);
}

.small-btn.primary:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}

.icon-btn.danger:hover:not(:disabled) {
  color: var(--vscode-errorForeground);
  border-color: var(--vscode-errorForeground);
}

.small-btn:disabled,
.icon-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.entries-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.entry-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: relative;
  padding: 12px;
  background: var(--vscode-sideBar-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  transition: border-color 0.15s, box-shadow 0.15s, opacity 0.15s;
}

.entry-card.disabled {
  opacity: 0.72;
}

.entry-card::before,
.entry-card::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  height: 2px;
  border-radius: 999px;
  background: var(--vscode-focusBorder);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s;
}

.entry-card::before {
  top: -7px;
}

.entry-card::after {
  bottom: -7px;
}

.entry-card.chat-history-card {
  border-style: dashed;
  border-color: var(--vscode-charts-purple, var(--vscode-focusBorder));
}

.entry-card.drop-before,
.entry-card.drop-after {
  border-color: var(--vscode-focusBorder);
  box-shadow: 0 0 0 1px var(--vscode-focusBorder);
}

.entry-card.drop-before::before,
.entry-card.drop-after::after {
  opacity: 1;
}

.entry-card.dragging {
  opacity: 0.55;
}

.entry-header {
  display: grid;
  position: relative;
  grid-template-columns: auto auto minmax(160px, 1fr) minmax(180px, 240px) auto;
  align-items: center;
  gap: 10px;
}

.entry-enabled {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--vscode-foreground);
  white-space: nowrap;
}

.entry-enabled.locked {
  color: var(--vscode-descriptionForeground);
}

.entry-enabled input {
  margin: 0;
}

.entry-name-input,
.entry-role-select,
.entry-content-textarea {
  width: 100%;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
}

.entry-name-input,
.entry-role-select,
.entry-role-pill {
  height: 28px;
  padding: 4px 8px;
  font-size: 12px;
}

.entry-role-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 4px;
  color: var(--vscode-descriptionForeground);
  background: var(--gc-surface-editor-bg);
}

.entry-content-textarea {
  padding: 8px 10px;
  resize: vertical;
  min-height: 120px;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family), monospace;
  line-height: 1.5;
}

.entry-name-input:focus,
.entry-role-select:focus,
.entry-content-textarea:focus {
  border-color: var(--vscode-focusBorder);
}

.chat-history-note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: var(--vscode-editorWidget-background);
  border: 1px solid var(--vscode-editorWidget-border);
  border-radius: 6px;
  color: var(--vscode-descriptionForeground);
}

.chat-history-note strong {
  display: block;
  margin-bottom: 4px;
  color: var(--vscode-foreground);
  font-size: 12px;
}

.chat-history-note p {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
}

.entry-modules {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.entry-fake-thought {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--vscode-editorWidget-background);
  border: 1px dashed var(--vscode-charts-purple, var(--vscode-panel-border));
  border-radius: 6px;
}

.fake-thought-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

.fake-thought-hint {
  font-weight: 400;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.4;
}

.fake-thought-textarea {
  width: 100%;
  padding: 8px 10px;
  resize: vertical;
  min-height: 56px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  outline: none;
  font-size: 12px;
  font-family: var(--vscode-editor-font-family), monospace;
  line-height: 1.5;
}

.fake-thought-textarea:focus {
  border-color: var(--vscode-focusBorder);
}

.entry-modules summary {
  cursor: pointer;
  user-select: none;
}

.module-chip-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.chip-group-label {
  margin-right: 2px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}

.module-chip {
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--vscode-panel-border);
  background: var(--gc-surface-editor-bg);
  color: var(--vscode-textPreformat-foreground);
  font-size: 11px;
  font-family: var(--vscode-editor-font-family), monospace;
  cursor: pointer;
}

.module-chip.dynamic {
  border-color: var(--vscode-charts-blue);
}

.module-chip:hover {
  background: var(--vscode-list-hoverBackground);
}

@media (max-width: 980px) {
  .entry-header {
    grid-template-columns: auto 1fr;
  }

  .entry-buttons {
    justify-content: flex-start;
  }
}
</style>
