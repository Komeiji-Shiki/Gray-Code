<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import { useSettingsStore } from '@/stores'
import { InputDialog, ConfirmDialog, type SelectOption } from '../common'
import { copyToClipboard } from '@/utils/format'
import { MESSAGE_NAMES } from '@shared/protocol'
import PromptEntriesEditor from './PromptEntriesEditor.vue'
import ModeSelectorBar from './prompt/ModeSelectorBar.vue'
import AssemblyModeSelector from './prompt/AssemblyModeSelector.vue'
import DynamicStrategyBlock from './prompt/DynamicStrategyBlock.vue'
import StaticTemplateSection from './prompt/StaticTemplateSection.vue'
import DynamicTemplateSection from './prompt/DynamicTemplateSection.vue'
import ModulesReference from './prompt/ModulesReference.vue'
import ToolPolicySection from './prompt/ToolPolicySection.vue'
import TokenCountSection from './prompt/TokenCountSection.vue'
import ImportModesDialog from './prompt/ImportModesDialog.vue'
import type {
  DynamicContextStrategy,
  PromptAssemblyMode,
  PromptEntry,
  ToolInfo,
  ToolPolicyMode
} from './prompt/types'
import { groupToolsByCategory, getCategoryName } from '@/utils/toolCategory'
import { usePromptModeDefaults } from '@/composables/usePromptModeDefaults'
import { usePromptTokenCount } from '@/composables/usePromptTokenCount'
import { useOneShotTimer } from '@/composables/useOneShotTimer'

const { t } = useI18n()
const settingsStore = useSettingsStore()

// 提示词模式
interface PromptMode {
  id: string
  name: string
  icon?: string
  template: string
  promptAssemblyMode?: PromptAssemblyMode
  dynamicTemplateEnabled: boolean
  dynamicTemplate: string
  dynamicContextStrategy?: DynamicContextStrategy
  promptEntries?: PromptEntry[]
  toolPolicy?: string[]
}

// 系统提示词配置（支持多模式）
interface SystemPromptConfig {
  currentModeId: string
  modes: Record<string, PromptMode>
  template: string
  dynamicTemplateEnabled: boolean
  dynamicTemplate: string
  dynamicContextStrategy: DynamicContextStrategy
  customPrefix: string
  customSuffix: string
}

// ========== 默认模板/模块目录（下放至 composable） ==========
const {
  STATIC_PROMPT_MODULES,
  DYNAMIC_CONTEXT_MODULES,
  staticModuleIds,
  dynamicModuleIds,
  CODE_MODE_TEMPLATE,
  DESIGN_MODE_TEMPLATE,
  PLAN_MODE_TEMPLATE,
  ASK_MODE_TEMPLATE,
  DEFAULT_TEMPLATE,
  DEFAULT_DYNAMIC_TEMPLATE,
  DEFAULT_MODE_ID,
  CHAT_HISTORY_PROMPT_ENTRY_ID,
  DEFAULT_PROMPT_ASSEMBLY_MODE,
  cleanupEmptyLines
} = usePromptModeDefaults()

// 模式列表
const modes = ref<PromptMode[]>([])
const currentModeId = ref(DEFAULT_MODE_ID)
const selectedModeId = ref(DEFAULT_MODE_ID)  // 当前编辑的模式

// 对话框状态
const showAddModeDialog = ref(false)
const showDuplicateModeDialog = ref(false)
const showImportModeDialog = ref(false)
const showRenameModeDialog = ref(false)
const showDeleteConfirm = ref(false)
const showUnsavedConfirm = ref(false)
const showResetStaticConfirm = ref(false)
const showResetDynamicConfirm = ref(false)
const pendingModeId = ref('')
const duplicatingModeId = ref('')
const duplicatingModeName = ref('')
const renamingModeId = ref('')
const renamingModeName = ref('')
const importPayloadText = ref('')
const importErrorMessage = ref('')

// 模式选项（用于模式下拉选择）
const modeOptions = computed<SelectOption[]>(() => {
  return modes.value.map(m => ({
    value: m.id,
    label: m.name
  }))
})

// 配置状态（当前编辑中的模式配置）
const config = reactive<{
  template: string
  dynamicTemplateEnabled: boolean
  dynamicTemplate: string
  dynamicContextStrategy: DynamicContextStrategy
}>({
  template: DEFAULT_TEMPLATE,
  dynamicTemplateEnabled: true,
  dynamicTemplate: DEFAULT_DYNAMIC_TEMPLATE,
  dynamicContextStrategy: 'single'
})

// 原始配置（用于检测变化）
const originalConfig = ref<typeof config | null>(null)

// Token 计数（下放至 composable；模板文本经 getter 读取当前编辑中的 config.template）
const {
  staticTokenCount,
  dynamicTokenCount,
  isCountingTokens,
  tokenCountError,
  selectedChannel,
  channelOptions,
  countTokens,
  formatTokenCount
} = usePromptTokenCount(() => config.template)

// ========== 模式工具策略 ==========

const availableTools = ref<ToolInfo[]>([])
const isLoadingTools = ref(false)
const toolSearchQuery = ref('')

const toolPolicyMode = ref<ToolPolicyMode>('inherit')
const toolPolicy = ref<string[]>([])
const originalToolPolicyMode = ref<ToolPolicyMode>('inherit')
const originalToolPolicy = ref<string[]>([])
const promptEntries = ref<PromptEntry[]>([])
const originalPromptEntries = ref<PromptEntry[]>([])
const promptAssemblyMode = ref<PromptAssemblyMode>(DEFAULT_PROMPT_ASSEMBLY_MODE)
const originalPromptAssemblyMode = ref<PromptAssemblyMode>(DEFAULT_PROMPT_ASSEMBLY_MODE)

function normalizePromptAssemblyMode(value: unknown): PromptAssemblyMode {
  return value === 'entries' ? 'entries' : 'legacy'
}

function createChatHistoryPromptEntry(order = 1000): PromptEntry {
  return {
    id: CHAT_HISTORY_PROMPT_ENTRY_ID,
    name: 'Chat History',
    type: 'chat_history',
    enabled: true,
    role: 'user',
    content: '',
    order
  }
}

function normalizePromptEntries(entries: PromptEntry[] | undefined, assemblyMode: PromptAssemblyMode = promptAssemblyMode.value): PromptEntry[] {
  const rawEntries = Array.isArray(entries) ? entries : []
  const normalized = rawEntries
    .filter(entry => entry && typeof entry === 'object')
    .map((entry, index) => ({
      id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `entry_${index}`,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `Prompt ${index + 1}`,
      type: entry.type === 'chat_history' || entry.id === CHAT_HISTORY_PROMPT_ENTRY_ID ? 'chat_history' as const : 'prompt' as const,
      enabled: entry.enabled !== false,
      role: entry.role === 'user' || entry.role === 'assistant' || entry.role === 'system' ? entry.role : 'system',
      content: typeof entry.content === 'string' ? entry.content : '',
      fakeThought: typeof entry.fakeThought === 'string' ? entry.fakeThought : '',
      order: typeof entry.order === 'number' && Number.isFinite(entry.order) ? entry.order : index
    }))

  if (assemblyMode === 'entries') {
    const result: PromptEntry[] = []
    let hasChatHistory = false
    for (const entry of normalized) {
      if (entry.type !== 'chat_history') {
        result.push(entry)
        continue
      }
      if (hasChatHistory) continue
      hasChatHistory = true
      result.push({
        ...createChatHistoryPromptEntry(entry.order),
        name: entry.name.trim() || 'Chat History'
      })
    }
    if (!hasChatHistory) {
      result.push(createChatHistoryPromptEntry(result.length))
    }
    return result
      .sort((a, b) => a.order - b.order)
      .map((entry, index) => ({ ...entry, order: index }))
  }

  return normalized
    .filter(entry => entry.type !== 'chat_history')
    .sort((a, b) => a.order - b.order)
    .map((entry, index) => ({ ...entry, order: index }))
}

function clonePromptEntries(entries: PromptEntry[]): PromptEntry[] {
  return entries.map(entry => ({ ...entry }))
}

function clonePromptMode(mode: PromptMode): PromptMode {
  const cloned: PromptMode = {
    ...mode,
    promptAssemblyMode: normalizePromptAssemblyMode(mode.promptAssemblyMode),
    toolPolicy: Array.isArray(mode.toolPolicy) ? [...mode.toolPolicy] : undefined,
    promptEntries: Array.isArray(mode.promptEntries)
      ? clonePromptEntries(mode.promptEntries)
      : undefined
  }
  if (!Array.isArray(mode.toolPolicy)) {
    delete (cloned as any).toolPolicy
  }
  if (!Array.isArray(mode.promptEntries)) {
    delete (cloned as any).promptEntries
  }
  return cloned
}

function createModeId(prefix = 'mode'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function getUniqueModeName(baseName: string): string {
  const trimmed = baseName.trim() || t('components.settings.promptSettings.modes.newModeDefault')
  const used = new Set(modes.value.map(mode => mode.name.trim()))
  if (!used.has(trimmed)) return trimmed

  let index = 2
  let candidate = `${trimmed} ${index}`
  while (used.has(candidate)) {
    index += 1
    candidate = `${trimmed} ${index}`
  }
  return candidate
}

function getDuplicateModeName(mode: PromptMode): string {
  return getUniqueModeName(`${mode.name} ${t('components.settings.promptSettings.modes.copySuffix')}`)
}

function buildEditedModeSnapshot(sourceMode?: PromptMode): PromptMode {
  const fallbackMode: PromptMode = sourceMode || {
    id: selectedModeId.value,
    name: t('components.settings.promptSettings.modes.newModeDefault'),
    icon: 'symbol-method',
    template: DEFAULT_TEMPLATE,
    promptAssemblyMode: DEFAULT_PROMPT_ASSEMBLY_MODE,
    dynamicTemplateEnabled: true,
    dynamicTemplate: DEFAULT_DYNAMIC_TEMPLATE,
    dynamicContextStrategy: 'single'
  }

  const snapshot: PromptMode = {
    ...clonePromptMode(fallbackMode),
    template: cleanupEmptyLines(config.template || ''),
    promptAssemblyMode: promptAssemblyMode.value,
    dynamicTemplateEnabled: config.dynamicTemplateEnabled,
    dynamicTemplate: cleanupEmptyLines(config.dynamicTemplate || ''),
    dynamicContextStrategy: config.dynamicContextStrategy,
    promptEntries: normalizePromptEntries(promptEntries.value, promptAssemblyMode.value)
  }

  if (toolPolicyMode.value === 'custom') {
    snapshot.toolPolicy = Array.from(new Set(toolPolicy.value))
  } else {
    delete (snapshot as any).toolPolicy
  }

  if (!snapshot.promptEntries || snapshot.promptEntries.length === 0) {
    delete (snapshot as any).promptEntries
  }

  return snapshot
}

function getModeSnapshotForExport(mode: PromptMode): PromptMode {
  return mode.id === selectedModeId.value
    ? buildEditedModeSnapshot(mode)
    : clonePromptMode(mode)
}

function sanitizeImportedMode(raw: unknown, fallbackName: string): PromptMode {
  if (!raw || typeof raw !== 'object') {
    throw new Error(t('components.settings.promptSettings.modes.importInvalid'))
  }

  const item = raw as Partial<PromptMode> & Record<string, unknown>
  const assemblyMode = normalizePromptAssemblyMode(item.promptAssemblyMode)
  const name = typeof item.name === 'string' && item.name.trim()
    ? item.name.trim()
    : fallbackName

  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : createModeId('imported_mode'),
    name,
    icon: typeof item.icon === 'string' && item.icon.trim() ? item.icon.trim() : 'symbol-method',
    template: typeof item.template === 'string' ? item.template : DEFAULT_TEMPLATE,
    promptAssemblyMode: assemblyMode,
    dynamicTemplateEnabled: item.dynamicTemplateEnabled !== false,
    dynamicTemplate: typeof item.dynamicTemplate === 'string' ? item.dynamicTemplate : DEFAULT_DYNAMIC_TEMPLATE,
    dynamicContextStrategy: item.dynamicContextStrategy === 'preserve' ? 'preserve' : 'single',
    promptEntries: normalizePromptEntries(item.promptEntries as PromptEntry[] | undefined, assemblyMode),
    toolPolicy: Array.isArray(item.toolPolicy)
      ? Array.from(new Set(item.toolPolicy.filter((tool): tool is string => typeof tool === 'string' && tool.trim().length > 0).map(tool => tool.trim())))
      : undefined
  }
}

function parsePromptModeImportPayload(rawText: string): PromptMode[] {
  const trimmed = rawText.trim()
  if (!trimmed) {
    throw new Error(t('components.settings.promptSettings.modes.importEmpty'))
  }

  const parsed = JSON.parse(trimmed)
  const source = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.modes)
      ? parsed.modes
      : parsed?.mode
        ? [parsed.mode]
        : [parsed]

  const imported = source.map((item: unknown, index: number) =>
    sanitizeImportedMode(item, `${t('components.settings.promptSettings.modes.importedModeDefault')} ${index + 1}`)
  )

  if (imported.length === 0) {
    throw new Error(t('components.settings.promptSettings.modes.importEmpty'))
  }

  return imported
}

function buildPromptModeExportPayload(target: 'current' | 'all'): string {
  const exportedModes = target === 'current'
    ? modes.value
        .filter(mode => mode.id === selectedModeId.value)
        .map(mode => getModeSnapshotForExport(mode))
    : modes.value.map(mode => getModeSnapshotForExport(mode))

  const payload = {
    schema: 'graycode.promptModes.v1',
    exportedAt: new Date().toISOString(),
    modes: exportedModes
  }

  return JSON.stringify(payload, null, 2)
}

async function exportPromptModes(target: 'current' | 'all') {
  const payload = buildPromptModeExportPayload(target)
  const filename = target === 'current'
    ? `graycode-prompt-mode-${selectedModeId.value || 'current'}.json`
    : 'graycode-prompt-modes.json'

  try {
    const result = await sendToExtension<{ success: boolean; cancelled?: boolean }>(MESSAGE_NAMES.exportPromptModes, {
      filename,
      content: payload
    })
    if (!result?.success) return

    const copied = await copyToClipboard(payload)
    showToast(
      copied
        ? t('components.settings.promptSettings.modes.exportSuccess')
        : t('components.settings.promptSettings.modes.exportDownloadOnly'),
      true
    )
  } catch (error) {
    console.error('Failed to export prompt modes:', error)
    showToast(t('components.settings.promptSettings.modes.exportFailed'), false)
  }
}

async function persistImportedModes(importedModes: PromptMode[]) {
  const savedModes: PromptMode[] = []

  for (const importedMode of importedModes) {
    const mode: PromptMode = {
      ...importedMode,
      id: createModeId('imported_mode'),
      name: getUniqueModeName(importedMode.name)
    }
    if (!mode.toolPolicy || mode.toolPolicy.length === 0) {
      delete (mode as any).toolPolicy
    }
    if (!mode.promptEntries || mode.promptEntries.length === 0) {
      delete (mode as any).promptEntries
    }

    await sendToExtension(MESSAGE_NAMES.savePromptMode, { mode })
    savedModes.push(mode)
  }

  modes.value = [...modes.value, ...savedModes]
  const lastMode = savedModes[savedModes.length - 1]
  if (lastMode) {
    selectedModeId.value = lastMode.id
    loadModeConfig(lastMode.id)
  }
  settingsStore.refreshPromptModes()
  showToast(t('components.settings.promptSettings.modes.importSuccess', { count: savedModes.length }), true)
}

function isSamePromptEntries(a: PromptEntry[], b: PromptEntry[]): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, index) => {
    const other = b[index]
    return !!other &&
      entry.id === other.id &&
      entry.name === other.name &&
      (entry.type || 'prompt') === (other.type || 'prompt') &&
      entry.enabled === other.enabled &&
      entry.role === other.role &&
      entry.content === other.content &&
      (entry.fakeThought ?? '') === (other.fakeThought ?? '') &&
      entry.order === other.order
  })
}

function normalizeToolList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  return Array.from(new Set(list)).sort()
}

function isSameToolList(a: string[], b: string[]): boolean {
  const na = normalizeToolList(a)
  const nb = normalizeToolList(b)
  if (na.length !== nb.length) return false
  return na.every((v, i) => v === nb[i])
}

const filteredTools = computed(() => {
  const q = toolSearchQuery.value.trim().toLowerCase()
  if (!q) return availableTools.value
  return availableTools.value.filter(t => {
    const name = (t.name || '').toLowerCase()
    const desc = (t.description || '').toLowerCase()
    return name.includes(q) || desc.includes(q)
  })
})

const groupedTools = computed<Record<string, ToolInfo[]>>(() => {
  // 复用 utils/toolCategory 的归一化分组：未知/缺省分类归入 other，避免中文分组键拼出不存在键
  const grouped = groupToolsByCategory(filteredTools.value)
  for (const category of Object.keys(grouped)) {
    grouped[category].sort((a, b) => a.name.localeCompare(b.name))
  }
  return grouped
})

function isToolSelected(name: string): boolean {
  return toolPolicy.value.includes(name)
}

function toggleTool(name: string, enabled: boolean) {
  if (enabled) {
    if (!toolPolicy.value.includes(name)) {
      toolPolicy.value.push(name)
    }
    return
  }
  toolPolicy.value = toolPolicy.value.filter(t => t !== name)
}

function selectAllTools() {
  toolPolicy.value = availableTools.value.map(t => t.name)
}

function clearAllTools() {
  toolPolicy.value = []
}

async function loadAvailableTools() {
  isLoadingTools.value = true
  try {
    const [builtin, mcp] = await Promise.all([
      sendToExtension<{ tools: ToolInfo[] }>(MESSAGE_NAMES['tools.getTools'], {}),
      sendToExtension<{ tools: ToolInfo[] }>(MESSAGE_NAMES['tools.getMcpTools'], {})
    ])

    const merged: ToolInfo[] = [
      ...(builtin?.tools || []),
      ...(mcp?.tools || [])
    ]

    const byName = new Map<string, ToolInfo>()
    for (const tool of merged) {
      if (!tool?.name) continue
      if (!byName.has(tool.name)) {
        byName.set(tool.name, tool)
      }
    }

    availableTools.value = Array.from(byName.values()).sort((a, b) => {
      const ca = (a.category || '').localeCompare(b.category || '')
      if (ca !== 0) return ca
      return a.name.localeCompare(b.name)
    })
  } catch (error) {
    console.error('Failed to load tools list for tool policy:', error)
    availableTools.value = []
  } finally {
    isLoadingTools.value = false
  }
}

// 是否有未保存的变化
const hasChanges = computed(() => {
  if (!originalConfig.value) return false
  const basicChanged = config.template !== originalConfig.value.template ||
    config.dynamicTemplateEnabled !== originalConfig.value.dynamicTemplateEnabled ||
    config.dynamicTemplate !== originalConfig.value.dynamicTemplate ||
    config.dynamicContextStrategy !== originalConfig.value.dynamicContextStrategy

  const assemblyChanged = promptAssemblyMode.value !== originalPromptAssemblyMode.value

  const policyChanged =
    toolPolicyMode.value !== originalToolPolicyMode.value ||
    !isSameToolList(toolPolicy.value, originalToolPolicy.value)

  const entriesChanged = !isSamePromptEntries(promptEntries.value, originalPromptEntries.value)

  return basicChanged || assemblyChanged || policyChanged || entriesChanged
})

// 加载状态
const isLoading = ref(true)
const isSaving = ref(false)
const toastVisible = ref(false)
const toastMessage = ref('')
const toastSuccess = ref(true)
const toastTimer = useOneShotTimer()
function showToast(message: string, success: boolean) {
  toastMessage.value = message
  toastSuccess.value = success
  toastVisible.value = true
  toastTimer.schedule(2500, () => { toastVisible.value = false })
}
const isFirstLoad = ref(true)  // 标记是否首次加载


// 展开的模块
const collapsedReference = ref(true)
const expandedModule = ref<string | null>(null)

// 加载配置
async function loadConfig() {
  isLoading.value = true
  try {
    const result = await sendToExtension<SystemPromptConfig>(MESSAGE_NAMES.getSystemPromptConfig, {})
    if (result) {
      // 加载模式列表
      modes.value = Object.values(result.modes || {})
      currentModeId.value = result.currentModeId || 'default'

      // 只在首次加载时设置 selectedModeId 为当前使用的模式
      // 切换页签时保持上次编辑的模式
      if (isFirstLoad.value) {
        selectedModeId.value = currentModeId.value
        isFirstLoad.value = false
      }

      // 加载当前编辑模式的配置
      loadModeConfig(selectedModeId.value)
    }
  } catch (error) {
    console.error('Failed to load system prompt config:', error)
  } finally {
    isLoading.value = false
  }
}

// 加载指定模式的配置
function loadModeConfig(modeId: string) {
  const mode = modes.value.find(m => m.id === modeId)
  if (mode) {
    config.template = typeof mode.template === 'string' ? mode.template : DEFAULT_TEMPLATE
    config.dynamicTemplateEnabled = mode.dynamicTemplateEnabled ?? true
    config.dynamicTemplate = typeof mode.dynamicTemplate === 'string' ? mode.dynamicTemplate : DEFAULT_DYNAMIC_TEMPLATE
    config.dynamicContextStrategy = mode.dynamicContextStrategy || 'single'
    originalConfig.value = { ...config }
    promptAssemblyMode.value = normalizePromptAssemblyMode(mode.promptAssemblyMode)
    originalPromptAssemblyMode.value = promptAssemblyMode.value
    promptEntries.value = normalizePromptEntries(mode.promptEntries, promptAssemblyMode.value)
    originalPromptEntries.value = clonePromptEntries(promptEntries.value)

    // 加载模式工具策略
    const policy = mode.toolPolicy
    if (Array.isArray(policy) && policy.length > 0) {
      toolPolicyMode.value = 'custom'
      toolPolicy.value = [...policy]
    } else {
      toolPolicyMode.value = 'inherit'
      toolPolicy.value = []
    }
    toolSearchQuery.value = ''
    originalToolPolicyMode.value = toolPolicyMode.value
    originalToolPolicy.value = [...toolPolicy.value]
  }
}

// 切换编辑的模式
async function handleModeChange(modeId: string) {
  // 如果有未保存的更改，提示用户
  if (hasChanges.value) {
    pendingModeId.value = modeId
    showUnsavedConfirm.value = true
    return
  }
  selectedModeId.value = modeId
  loadModeConfig(modeId)
}

// 确认放弃更改并切换模式
function confirmSwitchMode() {
  selectedModeId.value = pendingModeId.value
  loadModeConfig(pendingModeId.value)
  showUnsavedConfirm.value = false
}

// 保存配置
async function saveConfig() {
  isSaving.value = true
  try {
    // 工具策略校验：custom 模式必须至少选择一个工具
    if (toolPolicyMode.value === 'custom' && toolPolicy.value.length === 0) {
      showToast(t('components.settings.promptSettings.toolPolicy.emptyCannotSave'), false)
      return
    }

    // 保存前清理多余空行
    const cleanedTemplate = cleanupEmptyLines(config.template)
    const cleanedDynamicTemplate = cleanupEmptyLines(config.dynamicTemplate)

    // 更新当前模式的配置
    const currentMode = modes.value.find(m => m.id === selectedModeId.value)
    const baseMode: PromptMode = currentMode || {
      id: selectedModeId.value,
      name: '默认模式',
      icon: 'symbol-method',
      template: DEFAULT_TEMPLATE,
      promptAssemblyMode: DEFAULT_PROMPT_ASSEMBLY_MODE,
      dynamicTemplateEnabled: true,
      dynamicTemplate: DEFAULT_DYNAMIC_TEMPLATE,
      dynamicContextStrategy: 'single'
    }

    const nextToolPolicy = toolPolicyMode.value === 'custom'
      ? Array.from(new Set(toolPolicy.value))
      : undefined

    const nextPromptEntries = normalizePromptEntries(promptEntries.value, promptAssemblyMode.value)

    const updatedMode: PromptMode = {
      ...baseMode,
      template: cleanedTemplate,
      promptAssemblyMode: promptAssemblyMode.value,
      dynamicTemplateEnabled: config.dynamicTemplateEnabled,
      dynamicTemplate: cleanedDynamicTemplate,
      dynamicContextStrategy: config.dynamicContextStrategy,
      toolPolicy: nextToolPolicy,
      promptEntries: nextPromptEntries.length > 0 ? nextPromptEntries : undefined
    }
    if (toolPolicyMode.value !== 'custom') {
      delete (updatedMode as any).toolPolicy
    }

    await sendToExtension(MESSAGE_NAMES.savePromptMode, { mode: updatedMode })

    // 更新本地配置为清理后的版本
    config.template = cleanedTemplate
    config.dynamicTemplate = cleanedDynamicTemplate
    config.dynamicContextStrategy = updatedMode.dynamicContextStrategy || 'single'
    originalConfig.value = { ...config }
    originalPromptAssemblyMode.value = promptAssemblyMode.value
    originalToolPolicyMode.value = toolPolicyMode.value
    originalToolPolicy.value = [...toolPolicy.value]
    promptEntries.value = clonePromptEntries(nextPromptEntries)
    originalPromptEntries.value = clonePromptEntries(nextPromptEntries)

    // 更新模式列表中的配置
    const modeIndex = modes.value.findIndex(m => m.id === selectedModeId.value)
    if (modeIndex >= 0) {
      modes.value[modeIndex] = updatedMode
    }

    // 通知 InputArea 刷新模式列表，避免保存动态上下文策略后输入区仍显示旧模式数据
    settingsStore.refreshPromptModes()

    showToast(t('components.settings.promptSettings.saveSuccess'), true)

    // 保存成功后自动更新 token 计数（辅助操作：不阻塞保存成功反馈，
    // token 计数走渠道 API 可能较慢，等待它会让保存响应延迟）
    void countTokens()
  } catch (error) {
    console.error('Failed to save system prompt config:', error)
    showToast(t('components.settings.promptSettings.saveFailed'), false)
  } finally {
    isSaving.value = false
  }
}



function handlePromptAssemblyModeChange(mode: PromptAssemblyMode) {
  promptAssemblyMode.value = mode
  if (mode === 'entries') {
    promptEntries.value = normalizePromptEntries(promptEntries.value, 'entries')
  }
}

// 重置静态模板为默认
function resetStaticToDefault() {
  const modeDefaults: Record<string, string> = {
    code: CODE_MODE_TEMPLATE,
    design: DESIGN_MODE_TEMPLATE,
    plan: PLAN_MODE_TEMPLATE,
    ask: ASK_MODE_TEMPLATE
  }

  config.template = modeDefaults[selectedModeId.value] || DEFAULT_TEMPLATE
  showResetStaticConfirm.value = false
}

// 重置动态模板为默认
function resetDynamicToDefault() {
  config.dynamicTemplate = DEFAULT_DYNAMIC_TEMPLATE
  showResetDynamicConfirm.value = false
}

// 插入变量到静态模板
function insertStaticModule(moduleId: string) {
  if (!staticModuleIds.has(moduleId)) {
    console.warn(`Invalid static module ID: ${moduleId}`)
    return
  }
  const placeholder = `{{$${moduleId}}}`
  config.template += placeholder
}

// 插入变量到动态模板
function insertDynamicModule(moduleId: string) {
  if (!dynamicModuleIds.has(moduleId)) {
    console.warn(`Invalid dynamic module ID: ${moduleId}`)
    return
  }
  const placeholder = `{{$${moduleId}}}`
  config.dynamicTemplate += placeholder
}

function convertLegacyTemplatesToEntries() {
  const entries: PromptEntry[] = []
  const cleanedTemplate = cleanupEmptyLines(config.template)
  const cleanedDynamicTemplate = cleanupEmptyLines(config.dynamicTemplate)

  if (cleanedTemplate) {
    entries.push({
      id: 'legacy-system-template',
      name: '系统提示词',
      enabled: true,
      role: 'system',
      content: cleanedTemplate,
      order: 0
    })
  }

  if (cleanedDynamicTemplate) {
    entries.push({
      id: 'legacy-dynamic-context',
      name: '动态上下文',
      enabled: config.dynamicTemplateEnabled,
      role: 'user',
      content: cleanedDynamicTemplate,
      order: 100
    })
  }

  entries.push({
    ...createChatHistoryPromptEntry(50),
    name: 'Chat History'
  })

  promptAssemblyMode.value = 'entries'
  promptEntries.value = normalizePromptEntries(entries, 'entries')
}

// 切换模块展开
function toggleModule(moduleId: string) {
  expandedModule.value = expandedModule.value === moduleId ? null : moduleId
}

// 生成变量ID显示字符串（使用 {{$xxx}} 格式）
function formatModuleId(id: string): string {
  return `\{\{$${id}\}\}`
}

// 打开添加模式对话框
function openAddModeDialog() {
  showAddModeDialog.value = true
}

// 确认添加新模式
async function confirmAddMode(name: string) {
  const id = createModeId()
  const newMode: PromptMode = {
    id,
    name: getUniqueModeName(name),
    icon: 'symbol-method',
    template: DEFAULT_TEMPLATE,
    promptAssemblyMode: DEFAULT_PROMPT_ASSEMBLY_MODE,
    dynamicTemplateEnabled: true,
    dynamicTemplate: DEFAULT_DYNAMIC_TEMPLATE,
    dynamicContextStrategy: 'single'
  }

  try {
    await sendToExtension(MESSAGE_NAMES.savePromptMode, { mode: newMode })
    modes.value.push(newMode)
    selectedModeId.value = id
    loadModeConfig(id)
    // 通知 InputArea 刷新模式列表
    settingsStore.refreshPromptModes()
  } catch (error) {
    console.error('Failed to add mode:', error)
  }
}

function openDuplicateModeDialog() {
  const source = modes.value.find(m => m.id === selectedModeId.value)
  if (!source) return
  duplicatingModeId.value = source.id
  duplicatingModeName.value = getDuplicateModeName(source)
  showDuplicateModeDialog.value = true
}

async function confirmDuplicateMode(name: string) {
  const source = modes.value.find(m => m.id === duplicatingModeId.value)
  const normalizedName = name.trim()
  if (!source || !normalizedName) return

  const baseSnapshot = source.id === selectedModeId.value
    ? buildEditedModeSnapshot(source)
    : clonePromptMode(source)

  const duplicatedMode: PromptMode = {
    ...baseSnapshot,
    id: createModeId('mode_copy'),
    name: getUniqueModeName(normalizedName),
    promptEntries: Array.isArray(baseSnapshot.promptEntries)
      ? clonePromptEntries(baseSnapshot.promptEntries).map(entry => ({ ...entry }))
      : undefined,
    toolPolicy: Array.isArray(baseSnapshot.toolPolicy) ? [...baseSnapshot.toolPolicy] : undefined
  }
  if (!duplicatedMode.toolPolicy || duplicatedMode.toolPolicy.length === 0) {
    delete (duplicatedMode as any).toolPolicy
  }
  if (!duplicatedMode.promptEntries || duplicatedMode.promptEntries.length === 0) {
    delete (duplicatedMode as any).promptEntries
  }

  try {
    await sendToExtension(MESSAGE_NAMES.savePromptMode, { mode: duplicatedMode })
    modes.value.push(duplicatedMode)
    selectedModeId.value = duplicatedMode.id
    loadModeConfig(duplicatedMode.id)
    settingsStore.refreshPromptModes()
    showToast(t('components.settings.promptSettings.modes.duplicateSuccess'), true)
  } catch (error) {
    console.error('Failed to duplicate mode:', error)
    showToast(t('components.settings.promptSettings.modes.duplicateFailed'), false)
  }
}

function openImportModeDialog() {
  importPayloadText.value = ''
  importErrorMessage.value = ''
  showImportModeDialog.value = true
}

async function confirmImportModes() {
  importErrorMessage.value = ''
  try {
    const importedModes = parsePromptModeImportPayload(importPayloadText.value)
    await persistImportedModes(importedModes)
    showImportModeDialog.value = false
  } catch (error: any) {
    console.error('Failed to import prompt modes:', error)
    importErrorMessage.value = error?.message || t('components.settings.promptSettings.modes.importFailed')
  }
}

async function handleImportFileChange(event: Event) {
  const input = event.target as HTMLInputElement | null
  const file = input?.files?.[0]
  if (!file) return

  try {
    importPayloadText.value = await file.text()
    importErrorMessage.value = ''
  } catch (error: any) {
    importErrorMessage.value = error?.message || t('components.settings.promptSettings.modes.importFailed')
  } finally {
    if (input) input.value = ''
  }
}

// 打开重命名模式对话框
function openRenameModeDialog(modeId: string) {
  const mode = modes.value.find(m => m.id === modeId)
  if (!mode) return

  renamingModeId.value = modeId
  renamingModeName.value = mode.name
  showRenameModeDialog.value = true
}

// 确认重命名模式
async function confirmRenameMode(newName: string) {
  const mode = modes.value.find(m => m.id === renamingModeId.value)
  const normalizedName = newName.trim()
  if (!mode || !normalizedName || normalizedName === mode.name) return

  try {
    const result = await sendToExtension<{ mode?: PromptMode }>(MESSAGE_NAMES.renamePromptMode, {
      modeId: renamingModeId.value,
      name: normalizedName
    })
    const updatedMode: PromptMode = result?.mode || { ...mode, name: normalizedName }
    const index = modes.value.findIndex(m => m.id === renamingModeId.value)
    if (index >= 0) {
      modes.value[index] = updatedMode
    }
    renamingModeName.value = updatedMode.name
    // 通知 InputArea 刷新模式列表
    settingsStore.refreshPromptModes()
  } catch (error) {
    console.error('Failed to rename mode:', error)
  }
}

// 打开删除确认对话框
function openDeleteConfirm() {
  // 至少保留一个模式
  if (modes.value.length <= 1) return
  showDeleteConfirm.value = true
}

// 确认删除模式
async function confirmDeleteMode() {
  const modeId = selectedModeId.value
  // 至少保留一个模式
  if (modes.value.length <= 1) return

  try {
    await sendToExtension(MESSAGE_NAMES.deletePromptMode, { modeId })
    modes.value = modes.value.filter(m => m.id !== modeId)
    // 切换到第一个可用的模式
    const firstMode = modes.value[0]
    if (firstMode) {
      selectedModeId.value = firstMode.id
      loadModeConfig(firstMode.id)
    }
    // 通知 InputArea 刷新模式列表
    settingsStore.refreshPromptModes()
  } catch (error) {
    console.error('Failed to delete mode:', error)
  }
}

// 初始化
onMounted(async () => {
  await loadConfig()
  await loadAvailableTools()
  // 加载配置后自动计算 token 数量
  await countTokens()
})

</script>

<template>
  <div class="prompt-settings">
    <!-- 加载中 -->
    <div v-if="isLoading" class="loading-state">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('components.settings.promptSettings.loading') }}</span>
    </div>

    <template v-else>
      <!-- 模式选择栏 -->
      <ModeSelectorBar
        :selected-mode-id="selectedModeId"
        :mode-options="modeOptions"
        :is-saving="isSaving"
        :can-delete="modes.length > 1"
        @update:model-value="handleModeChange"
        @save="saveConfig"
        @add="openAddModeDialog"
        @duplicate="openDuplicateModeDialog"
        @export-current="exportPromptModes('current')"
        @import="openImportModeDialog"
        @rename="openRenameModeDialog(selectedModeId)"
        @delete="openDeleteConfirm()"
      />

      <!-- 提示词组装方式 -->
      <AssemblyModeSelector
        :model-value="promptAssemblyMode"
        @update:model-value="handlePromptAssemblyModeChange"
      />

      <template v-if="promptAssemblyMode === 'entries'">
        <!-- 预设提示词条目编辑区 -->
        <div class="template-section entries-section" data-search-anchor="prompt-entries">
          <div class="section-header">
            <label class="section-label">
              <i class="codicon codicon-list-tree"></i>
              预设提示词条目
              <span class="section-badge entries-badge">role / drag</span>
            </label>
          </div>
          <p class="section-description">
            按顺序编辑多条提示词。system 条目会合并进系统提示词，user / assistant 条目会作为本次请求的临时上下文插入；Chat History 条目表示真实聊天历史插入点。
          </p>
          <PromptEntriesEditor
            v-model="promptEntries"
            :static-modules="STATIC_PROMPT_MODULES"
            :dynamic-modules="DYNAMIC_CONTEXT_MODULES"
            @convert-legacy="convertLegacyTemplatesToEntries"
          />
        </div>

        <!-- 动态上下文保留策略（预设条目模式） -->
        <div class="template-section dynamic-strategy-section" data-search-anchor="prompt-dynamic-strategy">
          <div class="section-header">
            <label class="section-label">
              <i class="codicon codicon-history"></i>
              {{ t('components.settings.promptSettings.dynamicSection.strategyTitle') }}
            </label>
          </div>

          <DynamicStrategyBlock
            :model-value="config.dynamicContextStrategy"
            :format-module-id="formatModuleId"
            @update:model-value="config.dynamicContextStrategy = $event"
          />
        </div>
      </template>

      <template v-else>
        <!-- 静态系统提示词编辑区 -->
        <StaticTemplateSection v-model="config.template" @reset="showResetStaticConfirm = true" />

        <!-- 动态上下文模板编辑区 -->
        <DynamicTemplateSection
          v-model="config.dynamicTemplate"
          v-model:enabled="config.dynamicTemplateEnabled"
          v-model:strategy="config.dynamicContextStrategy"
          :format-module-id="formatModuleId"
          @reset="showResetDynamicConfirm = true"
        />
      </template>

      <!-- 可用变量参考（可收缩，默认收起） -->
      <ModulesReference
        v-model:collapsed="collapsedReference"
        :expanded-module="expandedModule"
        :static-modules="STATIC_PROMPT_MODULES"
        :dynamic-modules="DYNAMIC_CONTEXT_MODULES"
        :format-module-id="formatModuleId"
        @toggle-module="toggleModule"
        @insert-static="insertStaticModule"
        @insert-dynamic="insertDynamicModule"
      />
      <!-- 模式工具策略 -->
      <ToolPolicySection
        v-model="toolPolicyMode"
        v-model:search-query="toolSearchQuery"
        :is-loading-tools="isLoadingTools"
        :available-tools="availableTools"
        :grouped-tools="groupedTools"
        :get-category-display-name="getCategoryName"
        :is-tool-selected="isToolSelected"
        :tool-policy="toolPolicy"
        @select-all="selectAllTools"
        @clear="clearAllTools"
        @toggle-tool="toggleTool"
      />

      <!-- Token 计数 -->
      <TokenCountSection
        v-model:selected-channel="selectedChannel"
        :is-counting-tokens="isCountingTokens"
        :static-token-count="staticTokenCount"
        :dynamic-token-count="dynamicTokenCount"
        :token-count-error="tokenCountError"
        :channel-options="channelOptions"
        :format-token-count="formatTokenCount"
        @refresh="countTokens"
      />
    </template>

    <!-- 保存浮窗提示 -->
    <Transition name="toast-fade">
      <div
        v-if="toastVisible"
        class="save-toast"
        :class="{ success: toastSuccess }"
        :role="toastSuccess ? 'status' : 'alert'"
        :aria-live="toastSuccess ? 'polite' : 'assertive'"
        aria-atomic="true"
      >
        <i :class="['codicon', toastSuccess ? 'codicon-check' : 'codicon-error']" aria-hidden="true"></i>
        {{ toastMessage }}
      </div>
    </Transition>

    <!-- 添加模式对话框 -->
    <InputDialog
      v-model="showAddModeDialog"
      :title="t('components.settings.promptSettings.modes.add')"
      :placeholder="t('components.settings.promptSettings.modes.newModeDefault')"
      :default-value="t('components.settings.promptSettings.modes.newModeDefault')"
      @confirm="confirmAddMode"
    />

    <!-- 复制模式对话框 -->
    <InputDialog
      v-model="showDuplicateModeDialog"
      :title="t('components.settings.promptSettings.modes.duplicate')"
      :placeholder="duplicatingModeName"
      :default-value="duplicatingModeName"
      @confirm="confirmDuplicateMode"
    />

    <!-- 导入模式对话框 -->
    <ImportModesDialog
      v-if="showImportModeDialog"
      :payload-text="importPayloadText"
      :error-message="importErrorMessage"
      @update:payload-text="importPayloadText = $event"
      @update:error-message="importErrorMessage = $event"
      @close="showImportModeDialog = false"
      @confirm="confirmImportModes"
      @export-all="exportPromptModes('all')"
      @file-change="handleImportFileChange"
    />

    <!-- 重命名模式对话框 -->
    <InputDialog
      v-model="showRenameModeDialog"
      :title="t('components.settings.promptSettings.modes.rename')"
      :placeholder="renamingModeName"
      :default-value="renamingModeName"
      @confirm="confirmRenameMode"
    />

    <!-- 删除确认对话框 -->
    <ConfirmDialog
      v-model="showDeleteConfirm"
      :title="t('components.settings.promptSettings.modes.delete')"
      :message="t('components.settings.promptSettings.modes.confirmDelete')"
      :is-danger="true"
      @confirm="confirmDeleteMode"
    />

    <!-- 未保存更改确认对话框 -->
    <ConfirmDialog
      v-model="showUnsavedConfirm"
      :title="t('components.common.confirmDialog.title')"
      :message="t('components.settings.promptSettings.modes.unsavedChanges')"
      @confirm="confirmSwitchMode"
    />

    <!-- 重置静态模板确认对话框 -->
    <ConfirmDialog
      v-model="showResetStaticConfirm"
      :title="t('components.settings.promptSettings.templateSection.title')"
      :message="t('components.common.confirmDialog.message')"
      @confirm="resetStaticToDefault"
    />

    <!-- 重置动态模板确认对话框 -->
    <ConfirmDialog
      v-model="showResetDynamicConfirm"
      :title="t('components.settings.promptSettings.dynamicSection.title')"
      :message="t('components.common.confirmDialog.message')"
      @confirm="resetDynamicToDefault"
    />
  </div>
</template>

<style scoped>
.prompt-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px;
  color: var(--vscode-descriptionForeground);
}

/* 保存浮窗提示 */
.save-toast {
  position: fixed;
  top: 48px;
  right: 24px;
  z-index: 1100;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  font-size: 12px;
  border-radius: 4px;
  background: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
  color: var(--vscode-notifications-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-notifications-border, var(--vscode-panel-border));
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
}

.save-toast.success .codicon {
  color: var(--vscode-terminal-ansiGreen);
}

.save-toast:not(.success) .codicon {
  color: var(--vscode-errorForeground);
}

.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.template-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
}

.section-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 10px;
  font-weight: 500;
}

.section-badge.entries-badge {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.section-description {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

/* Loading 动画 */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.entries-section {
  border-color: var(--vscode-focusBorder);
}

</style>
