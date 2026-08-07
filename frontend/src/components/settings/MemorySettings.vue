<script setup lang="ts">
/**
 * MemorySettings - 永久记忆系统配置组件
 *
 * 包含两部分：
 * 1. 提示词 & 运行时参数配置
 * 2. 原始记忆条目管理（查看 / 编辑 / 删除，支持全局记忆 / 工作区记忆双作用域）
 */
import { ref, computed, onMounted, watch } from 'vue'
import { CustomCheckbox, ConfirmDialog } from '../common'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'

const { t } = useI18n()

/** 条目列表展示上限（与后端 getMemoryEntries 默认 limit 一致） */
const ENTRIES_LIMIT = 5000

// 内置默认提示词（与 PromptManager.generateMemorySection 保持一致）
const DEFAULT_SYSTEM_PROMPT = [
  '启动时必须主动激活记忆',
  '',
  '在每次会话中，在进行任何其他工具调用之前运行 memory_wake，然后严格按照其提示执行，直到一切结束。',
  '',
  '记忆包含两部分：全局记忆（所有工作区共享）与当前工作区记忆（按工作区隔离），memory_wake 会同时输出两者，注意区分 --- Global memory --- 与 --- Workspace memory --- 标注；记录新记忆时 memory_note 默认写入当前工作区的记忆存储。',
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
const statusError = ref(false)
const enabled = ref(true)
// 配置是否已成功加载过至少一次（静默刷新失败时据此决定是否保留现有表单值）
const configLoadedOnce = ref(false)
// 配置/条目请求序号：快速切换作用域时丢弃过期响应，防止旧数据覆盖新数据造成内容闪烁/错乱
let configLoadSeq = 0
let entryLoadSeq = 0

// 记忆提示词（systemPrompt）— 初始化为默认值，方便用户直接编辑
const systemPrompt = ref(DEFAULT_SYSTEM_PROMPT)

// 运行时参数
const wakeLines = ref(96)
const entryChars = ref(280)

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
    const result = await sendToExtension<any>('addMemoryEntry', { text, ...scopeParams() })
    newEntryText.value = ''
    statusMessage.value = t('components.settings.settingsPanel.memory.rawEntries.added', {
      id: result?.id ?? '',
    })
    statusError.value = false
    // 与 saveConfig/批量删除路径一致：成功提示 3s 后自动消失
    setTimeout(() => { statusMessage.value = '' }, 3000)
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
    await sendToExtension('deleteMemoryEntry', { id: entry.id, ...scopeParams() })
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
    await sendToExtension('deleteMemoryEntries', { ids: [...selectedIds.value], ...scopeParams() })
    statusMessage.value = t('components.settings.settingsPanel.memory.rawEntries.deletedBatch', { count })
    statusError.value = false
    setTimeout(() => { statusMessage.value = '' }, 3000)
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
    const resp = await sendToExtension<any>('listMemoryScopes', {})
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
    const config = await sendToExtension<any>('getMemoryConfig', scopeParams())
    // 过期响应（期间作用域又切换过）直接丢弃，避免旧作用域配置覆盖新作用域
    if (seq !== configLoadSeq) return
    if (config) {
      if (typeof config.enabled === 'boolean') enabled.value = config.enabled
      if (typeof config.systemPrompt === 'string' && config.systemPrompt.trim()) {
        systemPrompt.value = config.systemPrompt
      }
      if (typeof config.wakeLines === 'number') wakeLines.value = config.wakeLines
      if (typeof config.entryChars === 'number') entryChars.value = config.entryChars
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
    const result = await sendToExtension<any>('getMemoryEntries', { limit: ENTRIES_LIMIT, ...scopeParams() })
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
  } catch {
    if (seq !== entryLoadSeq) return
    entries.value = []
    entriesTotal.value = 0
    entriesTruncated.value = false
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
    await sendToExtension('updateMemoryEntry', {
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
    const promptToSave = systemPrompt.value === DEFAULT_SYSTEM_PROMPT ? '' : systemPrompt.value
    await sendToExtension('updateMemoryConfig', {
      config: {
        enabled: enabled.value,
        systemPrompt: promptToSave,
        wakeLines: wakeLines.value,
        entryChars: entryChars.value,
      },
      ...scopeParams(),
    })
    statusMessage.value = t('components.settings.settingsPanel.memory.saved')
    statusError.value = false
    setTimeout(() => { statusMessage.value = '' }, 3000)
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
  systemPrompt.value = DEFAULT_SYSTEM_PROMPT
  wakeLines.value = 96
  entryChars.value = 280
}

onMounted(() => {
  loadConfig()
  loadEntries()
  loadWorkspaceScopes()
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
      <!-- 长期记忆总开关 -->
      <div class="section memory-toggle-section" data-search-anchor="memory-toggle">
        <CustomCheckbox
          v-model="enabled"
          :label="t('components.settings.settingsPanel.memory.enabled.label')"
          :hint="t('components.settings.settingsPanel.memory.enabled.description')"
          :disabled="memoryScope === 'workspace'"
        />
        <p v-if="!enabled" class="disabled-notice">
          <i class="codicon codicon-info"></i>
          {{ t('components.settings.settingsPanel.memory.enabled.disabledNotice') }}
        </p>
        <!-- LOW-9：enabled 是全局配置，工作区 tab 下后端不持久化该字段——
             禁用并说明，避免用户以为改动了实际被静默丢弃 -->
        <p v-if="memoryScope === 'workspace'" class="disabled-notice">
          <i class="codicon codicon-info"></i>
          {{ t('components.settings.settingsPanel.memory.globalOnlyHint') }}
        </p>
      </div>

      <!-- 自定义提示词 -->
      <div class="form-group" data-search-anchor="memory-custom-prompt">
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
          :disabled="!enabled || memoryScope === 'workspace'"
        ></textarea>
        <!-- LOW-9：systemPrompt 是全局配置，工作区 tab 下后端不持久化该字段 -->
        <p v-if="memoryScope === 'workspace'" class="disabled-notice">
          <i class="codicon codicon-info"></i>
          {{ t('components.settings.settingsPanel.memory.globalOnlyHint') }}
        </p>
      </div>

      <!-- 运行时参数 -->
      <div class="section" data-search-anchor="memory-runtime">
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
        <button class="btn btn-secondary" @click="() => loadEntries()" :disabled="entriesLoading">
          <i :class="entriesLoading ? 'codicon codicon-loading codicon-modifier-spin' : 'codicon codicon-refresh'"></i>
          {{ t('common.refresh') }}
        </button>
      </div>

      <!-- 状态消息 -->
      <div v-if="statusMessage" class="status-message" :class="{ 'status-error': statusError }">
        {{ statusMessage }}
      </div>

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
            @click="memoryScope = 'global'"
          >
            <i class="codicon codicon-globe"></i>
            {{ t('components.settings.settingsPanel.memory.rawEntries.scopeGlobal') }}
          </button>
          <button
            class="scope-tab"
            :class="{ active: memoryScope === 'workspace' }"
            :title="t('components.settings.settingsPanel.memory.rawEntries.scopeWorkspaceHint')"
            @click="memoryScope = 'workspace'"
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
            v-model="selectedWorkspaceUri"
            class="scope-workspace-select"
            :disabled="scopesLoading || workspaceScopes.length === 0"
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
            v-model="newEntryText"
            class="form-textarea add-entry-textarea"
            rows="3"
            :placeholder="t('components.settings.settingsPanel.memory.rawEntries.addPlaceholder')"
            :disabled="addingEntry || (memoryScope === 'workspace' && !selectedWorkspaceUri)"
            @keydown.ctrl.enter.prevent="addEntry"
            @keydown.meta.enter.prevent="addEntry"
          ></textarea>
          <div class="add-entry-actions">
            <span class="char-count" :class="{ 'char-overflow': newEntryBytes > entryChars }">
              {{ newEntryBytes }}/{{ entryChars }} {{ t('components.settings.settingsPanel.memory.runtime.entryChars.unit') }}
            </span>
            <button class="btn btn-sm btn-primary" @click="addEntry" :disabled="addingEntry || (memoryScope === 'workspace' && !selectedWorkspaceUri)">
              <i v-if="addingEntry" class="codicon codicon-loading codicon-modifier-spin"></i>
              <i v-else class="codicon codicon-add"></i>
              {{ t('components.settings.settingsPanel.memory.rawEntries.add') }}
            </button>
          </div>
        </div>

        <!-- 截断提示：条目超过展示上限时提示，避免误以为数据丢失 -->
        <div v-if="entriesTruncated" class="truncated-notice">
          <i class="codicon codicon-info"></i>
          {{ t('components.settings.settingsPanel.memory.rawEntries.truncatedNotice', { limit: ENTRIES_LIMIT }) }}
        </div>

        <!-- 条目工具栏：全选 + 批量删除 -->
        <div v-if="entries.length > 0" class="entries-toolbar">
          <label class="select-all-label">
            <input
              type="checkbox"
              class="entry-checkbox"
              :checked="isAllSelected"
              :disabled="entriesLoading"
              @change="toggleSelectAll"
            />
            {{ t('components.settings.settingsPanel.memory.rawEntries.selectAll') }}
          </label>
          <button
            class="btn btn-sm btn-danger"
            :disabled="batchDeleteCount === 0 || entriesLoading || batchDeleteSaving"
            @click="requestDeleteSelected"
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
              @change="toggleSelectEntry(entry.id)"
            />
            <span class="entry-id">#{{ entry.id }}</span>
            <span class="entry-date">{{ entry.date }}</span>
            <div class="entry-text-wrap">
              <pre v-if="editingId !== entry.id" class="entry-text">{{ entry.text }}</pre>
              <div v-else class="entry-edit-row">
                <!-- 不设 maxlength：后端按 trim 后 UTF-8 字节数校验（entryChars），
                     maxlength 按 UTF-16 码元计数会与字节校验不一致；保存时仍做字节拦截 -->
                <textarea
                  v-model="editingText"
                  class="entry-textarea"
                  rows="3"
                ></textarea>
                <div class="entry-edit-actions">
                  <button class="btn btn-sm btn-primary" @click="saveEdit" :disabled="editSaving">
                    <i v-if="editSaving" class="codicon codicon-loading codicon-modifier-spin"></i>
                    <i v-else class="codicon codicon-check"></i>
                    {{ t('common.save') }}
                  </button>
                  <button class="btn btn-sm btn-secondary" @click="cancelEdit" :disabled="editSaving">{{ t('common.cancel') }}</button>
                  <span class="char-count" :class="{ 'char-overflow': editingBytes > entryChars }">{{ editingBytes }}/{{ entryChars }}</span>
                </div>
              </div>
            </div>
            <div class="entry-actions" v-if="editingId !== entry.id">
              <button class="btn-icon" :title="t('common.edit')" @click="startEdit(entry)">
                <i class="codicon codicon-edit"></i>
              </button>
              <button class="btn-icon danger" :title="t('common.delete')" :disabled="deleteSaving || entriesLoading" @click="requestDeleteEntry(entry)">
                <i class="codicon codicon-trash"></i>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 删除单条记忆确认 -->
      <ConfirmDialog
        v-model="showDeleteConfirm"
        :title="t('components.settings.settingsPanel.memory.rawEntries.deleteConfirmTitle')"
        :message="t('components.settings.settingsPanel.memory.rawEntries.deleteConfirmMessage', { id: deleteCandidate?.id ?? '' })"
        :confirm-text="t('common.delete')"
        is-danger
        @confirm="confirmDeleteEntry"
        @cancel="cancelDeleteEntry"
      />

      <!-- 批量删除记忆确认 -->
      <ConfirmDialog
        v-model="showBatchDeleteConfirm"
        :title="t('components.settings.settingsPanel.memory.rawEntries.batchDeleteConfirmTitle')"
        :message="t('components.settings.settingsPanel.memory.rawEntries.batchDeleteConfirmMessage', { count: batchDeleteCount })"
        :confirm-text="t('common.delete')"
        is-danger
        @confirm="confirmDeleteSelected"
        @cancel="cancelDeleteSelected"
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

.btn-danger {
  background: var(--vscode-errorForeground, #f14c4c);
  color: var(--vscode-button-foreground, #ffffff);
}

.btn-danger:hover:not(:disabled) {
  opacity: 0.85;
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
</style>
