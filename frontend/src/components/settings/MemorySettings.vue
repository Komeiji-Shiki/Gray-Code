<script setup lang="ts">
/**
 * MemorySettings - 永久记忆系统配置组件
 *
 * 编排层：持有配置/条目/作用域/选中/编辑等全部状态与动作。
 * 配置区块与原始记忆条目管理已拆分到 memorySettings/ 子组件（纯展示 + props/emits）。
 */
import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import MemoryConfigSection from './memorySettings/MemoryConfigSection.vue'
import MemoryEntriesSection from './memorySettings/MemoryEntriesSection.vue'

const { t } = useI18n()

/** 条目列表展示上限（与后端 getMemoryEntries 默认 limit 一致） */
const ENTRIES_LIMIT = 5000

// 内置默认提示词（与 PromptManager.generateMemorySection 保持一致）。
// 内容来自语言包（components.settings.memory.defaultPrompt），随界面语言切换；
// 用户保存后 systemPrompt 持有其编辑值，不再随语言变化（与旧行为一致：默认值仅作初始/恢复基准）。
const DEFAULT_SYSTEM_PROMPT = computed(() => t('components.settings.memory.defaultPrompt'))

const isLoading = ref(true)
const isSaving = ref(false)
const statusMessage = ref('')
const statusError = ref(false)
// 状态消息自动消失定时器（组件卸载时统一清理）
let statusMessageTimer: ReturnType<typeof setTimeout> | null = null
const enabled = ref(true)
// 配置是否已成功加载过至少一次（静默刷新失败时据此决定是否保留现有表单值）
const configLoadedOnce = ref(false)
// 配置/条目请求序号：快速切换作用域时丢弃过期响应，防止旧数据覆盖新数据造成内容闪烁/错乱
let configLoadSeq = 0
let entryLoadSeq = 0

// 记忆提示词（systemPrompt）— 初始化为默认值，方便用户直接编辑
const systemPrompt = ref(DEFAULT_SYSTEM_PROMPT.value)

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
const entriesTruncated = ref(false)
const editingId = ref<number | null>(null)
const editingText = ref('')
const editSaving = ref(false)
// 待删除的条目（确认框展示；确认后调用 deleteMemoryEntry）
const deleteCandidate = ref<LogEntry | null>(null)
const showDeleteConfirm = ref(false)
const deleteSaving = ref(false)

// ─── 记忆作用域（全局 / 工作区） ───
interface WorkspaceMemoryScope {
  uri: string
  name: string
  fsPath: string
  hasData: boolean
}
const memoryScope = ref<'global' | 'workspace'>('global')
const workspaceScopes = ref<WorkspaceMemoryScope[]>([])
const selectedWorkspaceUri = ref('')
const scopesLoading = ref(false)

// ─── 作用域数据缓存 ───
// 每个作用域最近一次成功加载的数据。切换作用域时立即渲染目标作用域的缓存
// （无中间空态/加载占位帧），随后后台静默刷新——消除列表高度塌陷造成的一帧
// 空白闪烁（工作区→全局切换时工作区列表很高、全局实例已预热响应很快，
// 旧实现中间态只持续 1-2 帧，肉眼可见闪烁而低帧率录屏捕捉不到）。
interface ScopeCache {
  entries: LogEntry[]
  total: number
  truncated: boolean
  config?: {
    enabled: boolean
    systemPrompt: string
    wakeLines: number
    entryChars: number
    partChars: number
    partLines: number
  }
  entriesLoaded: boolean
  configLoaded: boolean
}
const scopeCache = new Map<string, ScopeCache>()

/** 当前作用域的缓存键：全局为 'global'；工作区为 'ws:<uri>'；未选工作区返回 null */
function scopeKey(): string | null {
  if (memoryScope.value === 'global') return 'global'
  return selectedWorkspaceUri.value ? `ws:${selectedWorkspaceUri.value}` : null
}

function getOrCreateScopeCache(key: string): ScopeCache {
  let cached = scopeCache.get(key)
  if (!cached) {
    cached = { entries: [], total: 0, truncated: false, entriesLoaded: false, configLoaded: false }
    scopeCache.set(key, cached)
  }
  return cached
}

/** 当前作用域的 workspaceUri 参数（全局为空对象，工作区带上 uri） */
function scopeParams(): { workspaceUri?: string } {
  return memoryScope.value === 'workspace' && selectedWorkspaceUri.value
    ? { workspaceUri: selectedWorkspaceUri.value }
    : {}
}

/**
 * 切换作用域瞬间：立即应用目标作用域的缓存数据（或清空进入加载态），
 * 再配合 loadConfig(true)/loadEntries(false) 后台静默刷新。
 * 未选择工作区（工作区 tab 刚打开、列表未加载完）时不发请求，直接显示空态——
 * 避免 scopeParams 为空时误把全局数据渲染在工作区 tab 下。
 */
function applyCachedScope(): void {
  const key = scopeKey()
  if (!key) {
    entries.value = []
    entriesTotal.value = 0
    entriesTruncated.value = false
    entriesLoading.value = false
    return
  }
  const cached = scopeCache.get(key)
  if (cached?.entriesLoaded) {
    entries.value = cached.entries
    entriesTotal.value = cached.total
    entriesTruncated.value = cached.truncated
    entriesLoading.value = false
  } else {
    entries.value = []
    entriesLoading.value = true
  }
  if (cached?.configLoaded && cached.config) {
    // 立即应用目标作用域的运行时参数，避免表单短暂显示上一作用域的值再跳变
    enabled.value = cached.config.enabled
    systemPrompt.value = cached.config.systemPrompt
    wakeLines.value = cached.config.wakeLines
    entryChars.value = cached.config.entryChars
    partChars.value = cached.config.partChars
    partLines.value = cached.config.partLines
    configLoadedOnce.value = true
  }
}

/** 作用域或工作区切换：静默刷新配置（不触整页 loading，避免回顶）并重新加载条目 */
function refreshCurrentScope(): void {
  statusMessage.value = ''
  statusError.value = false
  // 目标作用域条目的 id 空间独立：清空选中与编辑态，防旧 id 错位静默删错/改错
  selectedIds.value = new Set()
  editingId.value = null
  editingText.value = ''
  applyCachedScope()
  loadConfig(true)
  loadEntries(false)
}

/** 批量删除选中项（上限与后端 MAX_BATCH_DELETE_IDS 一致） */
const selectedIds = ref<Set<number>>(new Set())
const showBatchDeleteConfirm = ref(false)
const batchDeleteSaving = ref(false)
const batchDeleteCount = computed(() => selectedIds.value.size)
const isAllSelected = computed(() => entries.value.length > 0 && selectedIds.value.size === entries.value.length)

// ─── 手动新增记忆 ───
const newEntryText = ref('')
const addingEntry = ref(false)

// UTF-8 字节数（后端按 trim 后的字节校验 entryChars；String.length 计的是 UTF-16 码元，
// 中文等字符会低估，导致前端放行、后端报 Too long）
const utf8Bytes = (s: string) => new TextEncoder().encode(s.trim()).length
const newEntryBytes = computed(() => utf8Bytes(newEntryText.value))
const editingBytes = computed(() => utf8Bytes(editingText.value))

// 是否含换行符（后端 note/updateEntry 对多行文本直接报错，前端提前拦截并提示）
const hasNewline = (s: string) => /\r|\n/.test(s.trim())

// 手动新增一条记忆（等价于 AI 的 memory_note）
async function addEntry() {
  const text = newEntryText.value
  if (!text.trim()) {
    statusMessage.value = t('components.settings.settingsPanel.memory.rawEntries.addEmpty')
    statusError.value = true
    return
  }
  if (hasNewline(text)) {
    statusMessage.value = t('components.settings.settingsPanel.memory.rawEntries.newlineNotAllowed')
    statusError.value = true
    return
  }
  if (newEntryBytes.value > entryChars.value) {
    statusMessage.value = t('components.settings.settingsPanel.memory.rawEntries.addTooLong', {
      limit: entryChars.value,
    })
    statusError.value = true
    return
  }
  addingEntry.value = true
  try {
    const result = await sendToExtension<any>(MESSAGE_NAMES.addMemoryEntry, { text, ...scopeParams() })
    newEntryText.value = ''
    statusMessage.value = t('components.settings.settingsPanel.memory.rawEntries.added', {
      id: result?.id ?? '',
    })
    statusError.value = false
    // 与 saveConfig/批量删除路径一致：成功提示 3s 后自动消失
    if (statusMessageTimer) clearTimeout(statusMessageTimer)
    statusMessageTimer = setTimeout(() => { statusMessage.value = '' }, 3000)
    await loadEntries()
  } catch (e: any) {
    statusMessage.value = e?.message || 'Failed to add entry'
    statusError.value = true
  } finally {
    addingEntry.value = false
  }
}

// 请求删除：弹出确认框
function requestDeleteEntry(entry: LogEntry) {
  deleteCandidate.value = entry
  showDeleteConfirm.value = true
}

// 确认删除单条原始记忆
async function confirmDeleteEntry() {
  const entry = deleteCandidate.value
  if (!entry) return
  deleteSaving.value = true
  try {
    await sendToExtension(MESSAGE_NAMES.deleteMemoryEntry, { id: entry.id, ...scopeParams() })
    deleteCandidate.value = null
    showDeleteConfirm.value = false
    // 删除后 id 重编号：整表重载（不能只按 id 过滤本地列表）
    await loadEntries()
  } catch (e: any) {
    statusMessage.value = e?.message || 'Failed to delete entry'
    statusError.value = true
  } finally {
    deleteSaving.value = false
  }
}

// 取消删除
function cancelDeleteEntry() {
  deleteCandidate.value = null
  showDeleteConfirm.value = false
}

// ─── 批量删除 ───
function toggleSelectEntry(id: number) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function toggleSelectAll() {
  if (isAllSelected.value) selectedIds.value = new Set()
  else selectedIds.value = new Set(entries.value.map(e => e.id))
}

function requestDeleteSelected() {
  if (selectedIds.value.size === 0) return
  showBatchDeleteConfirm.value = true
}

async function confirmDeleteSelected() {
  if (selectedIds.value.size === 0) return
  batchDeleteSaving.value = true
  const count = selectedIds.value.size
  try {
    await sendToExtension(MESSAGE_NAMES.deleteMemoryEntries, { ids: [...selectedIds.value], ...scopeParams() })
    statusMessage.value = t('components.settings.settingsPanel.memory.rawEntries.deletedBatch', { count })
    statusError.value = false
    if (statusMessageTimer) clearTimeout(statusMessageTimer)
    statusMessageTimer = setTimeout(() => { statusMessage.value = '' }, 3000)
    selectedIds.value = new Set()
    showBatchDeleteConfirm.value = false
    await loadEntries()
  } catch (e: any) {
    statusMessage.value = e?.message || 'Failed to delete entries'
    statusError.value = true
  } finally {
    batchDeleteSaving.value = false
  }
}

function cancelDeleteSelected() {
  showBatchDeleteConfirm.value = false
}

// 加载工作区记忆 scope 列表
async function loadWorkspaceScopes() {
  scopesLoading.value = true
  try {
    const resp = await sendToExtension<any>(MESSAGE_NAMES.listMemoryScopes, {})
    if (Array.isArray(resp?.scopes)) {
      workspaceScopes.value = resp.scopes
      // 保持已选工作区有效；无效时默认选第一个（若有）
      if (!selectedWorkspaceUri.value || !resp.scopes.some((s: WorkspaceMemoryScope) => s.uri === selectedWorkspaceUri.value)) {
        selectedWorkspaceUri.value = resp.scopes[0]?.uri ?? ''
      }
    }
  } catch {
    workspaceScopes.value = []
  } finally {
    scopesLoading.value = false
  }
}

// 加载配置
// silent=true（作用域/工作区切换）时只刷新配置值：不触整页 loading、不清空/覆盖
// statusMessage；失败时若已有配置则仅 console.warn，保留现有表单值
async function loadConfig(silent = false) {
  // 工作区 tab 未选择工作区：不发请求（scopeParams 为空会误拉全局配置），
  // 同时递增序号使在途的全局配置响应过期，避免旧作用域配置覆盖表单
  if (!scopeKey()) {
    ++configLoadSeq
    // 无条件复位：silent 调用也可能介入在途的非静默加载（其 seq 已过期，
    // 不会再复位 isLoading），否则页面会永久卡在 loading 态
    isLoading.value = false
    return
  }
  const seq = ++configLoadSeq
  if (!silent) {
    isLoading.value = true
    statusMessage.value = ''
  }
  try {
    const config = await sendToExtension<any>(MESSAGE_NAMES.getMemoryConfig, scopeParams())
    // 过期响应（期间作用域又切换过）直接丢弃，避免旧作用域配置覆盖新作用域
    if (seq !== configLoadSeq) return
    if (config) {
      if (typeof config.enabled === 'boolean') enabled.value = config.enabled
      if (typeof config.systemPrompt === 'string' && config.systemPrompt.trim()) {
        systemPrompt.value = config.systemPrompt
      }
      if (typeof config.wakeLines === 'number') wakeLines.value = config.wakeLines
      if (typeof config.entryChars === 'number') entryChars.value = config.entryChars
      if (typeof config.partChars === 'number') partChars.value = config.partChars
      if (typeof config.partLines === 'number') partLines.value = config.partLines
      configLoadedOnce.value = true
      // 写回缓存：切换回来时可立即渲染，无需重新等待
      const key = scopeKey()
      if (key) {
        const cached = getOrCreateScopeCache(key)
        cached.config = {
          enabled: enabled.value,
          systemPrompt: systemPrompt.value,
          wakeLines: wakeLines.value,
          entryChars: entryChars.value,
          partChars: partChars.value,
          partLines: partLines.value,
        }
        cached.configLoaded = true
      }
    }
  } catch (e: any) {
    if (seq !== configLoadSeq) return
    if (silent && configLoadedOnce.value) {
      // 静默刷新失败：不覆盖现有表单值，仅记录
      console.warn('[MemorySettings] silent loadConfig failed:', e?.message)
    } else {
      statusMessage.value = e?.message || 'Failed to load config'
      statusError.value = true
    }
  } finally {
    // seq 匹配时兜底复位（含 silent 路径）：静默加载可能作废了在途的非静默加载，
    // 若只在 !silent 时复位，被作废的加载不会复位 isLoading，页面永久卡 loading
    if (seq === configLoadSeq) isLoading.value = false
  }
}

// 加载记忆条目
// showLoading=false（作用域切换触发的刷新）且已有缓存时：不置加载占位，
// 直接展示缓存数据、响应到达后原位更新——防止列表高度塌陷造成一帧空白闪烁
async function loadEntries(showLoading = true) {
  const key = scopeKey()
  if (!key) {
    // 工作区 tab 未选择工作区：不发请求（scopeParams 为空会误拉全局数据）
    // 同时递增请求序号，使在途的全局条目请求（如 mount 时发出的）过期——
    // 否则其响应仍会通过 seq 校验，把全局条目渲染到工作区 tab 下（竞态）
    ++entryLoadSeq
    entries.value = []
    entriesTotal.value = 0
    entriesTruncated.value = false
    entriesLoading.value = false
    return
  }
  const seq = ++entryLoadSeq
  const hasCache = scopeCache.get(key)?.entriesLoaded === true
  if (showLoading || !hasCache) entriesLoading.value = true
  try {
    const result = await sendToExtension<any>(MESSAGE_NAMES.getMemoryEntries, { limit: ENTRIES_LIMIT, ...scopeParams() })
    // 过期响应（期间作用域又切换过）直接丢弃，避免旧作用域条目闪现/覆盖
    if (seq !== entryLoadSeq) return
    if (result?.entries) {
      entries.value = result.entries
      entriesTotal.value = result.total ?? result.entries.length
      entriesTruncated.value = !!result.truncated
    } else {
      entries.value = []
      entriesTotal.value = 0
      entriesTruncated.value = false
    }
    // 写回缓存：切换回来时可立即渲染
    const cached = getOrCreateScopeCache(key)
    cached.entries = entries.value
    cached.total = entriesTotal.value
    cached.truncated = entriesTruncated.value
    cached.entriesLoaded = true
    // 作用域/数据变化后清理残留选中与编辑态（防旧 id 错位静默删错）
    selectedIds.value = new Set()
    editingId.value = null
    editingText.value = ''
  } catch (e: any) {
    if (seq !== entryLoadSeq) return
    // 失败时保留旧数据，避免列表被静默清空；显示错误提示
    statusMessage.value = e?.message || 'Failed to load entries'
    statusError.value = true
  } finally {
    if (seq === entryLoadSeq) entriesLoading.value = false
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
  if (!editingText.value.trim()) {
    statusMessage.value = t('components.settings.settingsPanel.memory.rawEntries.addEmpty')
    statusError.value = true
    return
  }
  if (hasNewline(editingText.value)) {
    statusMessage.value = t('components.settings.settingsPanel.memory.rawEntries.newlineNotAllowed')
    statusError.value = true
    return
  }
  if (editingBytes.value > entryChars.value) {
    statusMessage.value = t('components.settings.settingsPanel.memory.rawEntries.addTooLong', {
      limit: entryChars.value,
    })
    statusError.value = true
    return
  }
  editSaving.value = true
  try {
    await sendToExtension(MESSAGE_NAMES.updateMemoryEntry, {
      id: editingId.value,
      text: editingText.value,
      ...scopeParams(),
    })
    // 更新本地缓存
    const idx = entries.value.findIndex(e => e.id === editingId.value)
    if (idx !== -1) {
      entries.value[idx] = { ...entries.value[idx], text: editingText.value.trim() }
    }
    cancelEdit()
  } catch (e: any) {
    statusMessage.value = e?.message || 'Failed to update entry'
    statusError.value = true
  } finally {
    editSaving.value = false
  }
}

// 保存配置
async function saveConfig() {
  isSaving.value = true
  statusMessage.value = ''
  try {
    const promptToSave = systemPrompt.value === DEFAULT_SYSTEM_PROMPT.value ? '' : systemPrompt.value
    await sendToExtension(MESSAGE_NAMES.updateMemoryConfig, {
      config: {
        enabled: enabled.value,
        systemPrompt: promptToSave,
        wakeLines: wakeLines.value,
        entryChars: entryChars.value,
        partChars: partChars.value,
        partLines: partLines.value,
      },
      ...scopeParams(),
    })
    statusMessage.value = t('components.settings.settingsPanel.memory.saved')
    statusError.value = false
    if (statusMessageTimer) clearTimeout(statusMessageTimer)
    statusMessageTimer = setTimeout(() => { statusMessage.value = '' }, 3000)
  } catch (e: any) {
    statusMessage.value = e?.message || 'Failed to save config'
    statusError.value = true
  } finally {
    isSaving.value = false
  }
}

// 重置为默认
function resetToDefault() {
  enabled.value = true
  systemPrompt.value = DEFAULT_SYSTEM_PROMPT.value
  wakeLines.value = 96
  entryChars.value = 280
  partChars.value = 20000
  partLines.value = 500
}

onMounted(() => {
  loadConfig()
  loadEntries()
  loadWorkspaceScopes()
})

onUnmounted(() => {
  // 清理状态消息自动消失定时器，避免卸载后仍修改状态
  if (statusMessageTimer) {
    clearTimeout(statusMessageTimer)
    statusMessageTimer = null
  }
})

// 作用域或工作区切换：静默刷新配置并重新加载条目（含缓存即时渲染，避免闪烁）
watch(memoryScope, () => {
  refreshCurrentScope()
})
watch(selectedWorkspaceUri, (next, prev) => {
  if (next !== prev && memoryScope.value === 'workspace') {
    refreshCurrentScope()
  }
})
</script>

<template>
  <div class="memory-settings">
    <div v-if="isLoading" class="loading-state">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      {{ t('components.settings.settingsPanel.memory.loading') }}
    </div>

    <div v-else class="settings-form">
      <MemoryConfigSection
        :enabled="enabled"
        :system-prompt="systemPrompt"
        :wake-lines="wakeLines"
        :entry-chars="entryChars"
        :part-chars="partChars"
        :part-lines="partLines"
        :is-saving="isSaving"
        :status-message="statusMessage"
        :status-error="statusError"
        :memory-scope="memoryScope"
        :entries-loading="entriesLoading"
        @update:enabled="enabled = $event"
        @update:system-prompt="systemPrompt = $event"
        @update:wake-lines="wakeLines = $event"
        @update:entry-chars="entryChars = $event"
        @update:part-chars="partChars = $event"
        @update:part-lines="partLines = $event"
        @save="saveConfig"
        @reset="resetToDefault"
        @refresh="() => loadEntries()"
      />

      <MemoryEntriesSection
        :memory-scope="memoryScope"
        :workspace-scopes="workspaceScopes"
        :scopes-loading="scopesLoading"
        :selected-workspace-uri="selectedWorkspaceUri"
        :new-entry-text="newEntryText"
        :adding-entry="addingEntry"
        :new-entry-bytes="newEntryBytes"
        :entries-truncated="entriesTruncated"
        :entries="entries"
        :entries-loading="entriesLoading"
        :entries-total="entriesTotal"
        :entry-chars="entryChars"
        :selected-ids="selectedIds"
        :batch-delete-count="batchDeleteCount"
        :is-all-selected="isAllSelected"
        :batch-delete-saving="batchDeleteSaving"
        :editing-id="editingId"
        :editing-text="editingText"
        :editing-bytes="editingBytes"
        :edit-saving="editSaving"
        :delete-saving="deleteSaving"
        :show-delete-confirm="showDeleteConfirm"
        :delete-candidate="deleteCandidate"
        :show-batch-delete-confirm="showBatchDeleteConfirm"
        @update:memory-scope="memoryScope = $event"
        @update:selected-workspace-uri="selectedWorkspaceUri = $event"
        @update:new-entry-text="newEntryText = $event"
        @update:editing-text="editingText = $event"
        @update:show-delete-confirm="showDeleteConfirm = $event"
        @update:show-batch-delete-confirm="showBatchDeleteConfirm = $event"
        @add-entry="addEntry"
        @toggle-select-entry="toggleSelectEntry"
        @toggle-select-all="toggleSelectAll"
        @request-delete-selected="requestDeleteSelected"
        @start-edit="startEdit"
        @cancel-edit="cancelEdit"
        @save-edit="saveEdit"
        @request-delete-entry="requestDeleteEntry"
        @confirm-delete-entry="confirmDeleteEntry"
        @cancel-delete-entry="cancelDeleteEntry"
        @confirm-delete-selected="confirmDeleteSelected"
        @cancel-delete-selected="cancelDeleteSelected"
      />

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

.loading-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 40px 0;
  font-size: 13px;
  color: var(--vscode-descriptionForeground);
  justify-content: center;
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
</style>
