<script setup lang="ts">
import { MESSAGE_NAMES, PUSH_MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { ConfirmDialog, type SelectOption } from '../common'
import { sendToExtension, onExtensionCommand } from '@/utils/vscode'
import { preloadChannelConfigs, getChannelConfigsCache, setChannelConfigsCache } from '@/services/channelConfigCache'
import { useChatStore } from '@/stores'
import { useDeferredNumberInput } from '@/composables/useDeferredNumberInput'
import { useDeferredSave } from '@/composables/useDeferredSave'
import { t } from '@/i18n'
import type { ChannelConfig, CustomHeader, CustomBodyConfig, ToolOptions, ChannelType } from '@/types'
import ChannelConfigSelector from './channelSettings/ChannelConfigSelector.vue'
import ChannelCreateDialog from './channelSettings/ChannelCreateDialog.vue'
import ChannelBasicSettings from './channelSettings/ChannelBasicSettings.vue'
import ChannelContextManagement from './channelSettings/ChannelContextManagement.vue'
import ChannelToolOptions from './channelSettings/ChannelToolOptions.vue'
import ChannelTokenCountMethod from './channelSettings/ChannelTokenCountMethod.vue'
import ChannelProviderOptions from './channelSettings/ChannelProviderOptions.vue'
import ChannelCustomBody from './channelSettings/ChannelCustomBody.vue'
import ChannelCustomHeaders from './channelSettings/ChannelCustomHeaders.vue'
import ChannelOpenCodeSession from './channelSettings/ChannelOpenCodeSession.vue'
import ChannelAutoRetry from './channelSettings/ChannelAutoRetry.vue'

// Chat Store - 用于同步配置状态
const chatStore = useChatStore()

// 配置列表
const configs = ref<ChannelConfig[]>([])
const currentConfigId = ref<string>('')
const isLoading = ref(false)

// 编辑模式
const isEditing = ref(false)
const editingName = ref('')
// 渠道选择器子组件的暴露接口（聚焦/全选重命名输入框）
interface ChannelConfigSelectorExpose {
  focusEdit: () => void
}
const selectorRef = ref<ChannelConfigSelectorExpose | null>(null)

// 新建配置对话框
const showNewDialog = ref(false)
const newConfigName = ref('')
const newConfigType = ref<ChannelType>('gemini')
const newConfigNameError = ref(false)

// API Key 显示
const showApiKey = ref(false)

// 高级选项展开状态
const showAdvancedOptions = ref(false)

// 自定义标头展开状态
const showCustomHeaders = ref(false)

// 自定义 body 展开状态
const showCustomBody = ref(false)

// 自动重试展开状态
const showRetryOptions = ref(false)

// 上下文阈值展开状态
const showContextThreshold = ref(false)

// 工具配置展开状态
const showToolOptions = ref(false)

// Token 计数方式展开状态
const showTokenCountMethod = ref(false)

// 确认对话框
const showConfirmDialog = ref(false)
const confirmDialogTitle = ref('')
const confirmDialogMessage = ref('')
const confirmDialogAction = ref<() => void>(() => {})

// 获取类型显示名称
function getTypeName(type: string): string {
  const key = `components.settings.channelSettings.form.channelType.${type}` as const
  return t(key)
}

// 更新options字段
async function updateOption(optionKey: string, value: any) {
  if (!currentConfig.value) return

  const currentOptions = currentConfig.value.options || {}
  const updatedOptions = {
    ...currentOptions,
    [optionKey]: value
  }

  await updateConfigField('options', updatedOptions)
}

// 更新配置项启用状态（可选同时更新 option 值，避免竞态条件）
async function updateOptionEnabled(optionKey: string, enabled: boolean, optionValue?: any) {
  if (!currentConfig.value) return

  const currentOptionsEnabled = currentConfig.value.optionsEnabled || {}
  const updatedOptionsEnabled = {
    ...currentOptionsEnabled,
    [optionKey]: enabled
  }

  if (optionValue !== undefined) {
    // 同时更新 optionsEnabled 和 options，避免竞态条件
    const currentOptions = currentConfig.value.options || {}
    const updatedOptions = {
      ...currentOptions,
      [optionKey]: optionValue
    }

    // 合并为单个更新，避免两个请求相互覆盖
    await updateConfigFields({
      optionsEnabled: updatedOptionsEnabled,
      options: updatedOptions
    })
  } else {
    await updateConfigField('optionsEnabled', updatedOptionsEnabled)
  }
}

// 当前配置
const currentConfig = computed(() =>
  configs.value.find(c => c.id === currentConfigId.value)
)

// 配置选项
const configOptions = computed<SelectOption[]>(() =>
  configs.value.map(config => ({
    value: config.id,
    label: config.name,
    description: config.type
  }))
)

// 类型选项
const typeOptions = computed<SelectOption[]>(() => [
  { value: 'gemini', label: t('components.settings.channelSettings.form.channelType.gemini'), description: 'Google Gemini' },
  { value: 'gemini-interactions', label: t('components.settings.channelSettings.form.channelType.gemini-interactions'), description: 'Google Gemini Interactions API' },
  { value: 'openai', label: t('components.settings.channelSettings.form.channelType.openai'), description: 'OpenAI Compatible' },
  { value: 'openai-responses', label: t('components.settings.channelSettings.form.channelType.openai-responses'), description: 'OpenAI Responses API' },
  { value: 'anthropic', label: t('components.settings.channelSettings.form.channelType.anthropic'), description: 'Anthropic Claude' }
])

// 工具调用格式选项
const toolModeOptions = computed<SelectOption[]>(() => [
  {
    value: 'function_call',
    label: t('components.settings.channelSettings.form.toolMode.functionCall.label'),
    description: t('components.settings.channelSettings.form.toolMode.functionCall.description')
  },
  {
    value: 'xml',
    label: t('components.settings.channelSettings.form.toolMode.xml.label'),
    description: t('components.settings.channelSettings.form.toolMode.xml.description')
  },
  {
    value: 'json',
    label: t('components.settings.channelSettings.form.toolMode.json.label'),
    description: t('components.settings.channelSettings.form.toolMode.json.description')
  }
])

// 获取当前自定义标头
const customHeaders = computed<CustomHeader[]>(() => {
  return currentConfig.value?.customHeaders || []
})

// 自定义标头功能是否启用
const customHeadersEnabled = computed(() => {
  return currentConfig.value?.customHeadersEnabled ?? false
})

// 更新自定义标头启用状态
async function updateCustomHeadersEnabled(enabled: boolean) {
  await updateConfigField('customHeadersEnabled', enabled)
}

// 更新自定义标头列表
async function updateCustomHeaders(headers: CustomHeader[]) {
  await updateConfigField('customHeaders', headers)
}

// ==================== 自定义 Body ====================

// 获取当前自定义 body 配置
const customBody = computed<CustomBodyConfig>(() => {
  return currentConfig.value?.customBody || { mode: 'simple', items: [], json: '' }
})

// 自定义 body 功能是否启用
const customBodyEnabled = computed(() => {
  return currentConfig.value?.customBodyEnabled ?? false
})

// 更新自定义 body 启用状态
async function updateCustomBodyEnabled(enabled: boolean) {
  await updateConfigField('customBodyEnabled', enabled)
}

// 更新自定义 body 配置
async function updateCustomBodyConfig(config: CustomBodyConfig) {
  await updateConfigField('customBody', config)
}

// ==================== 自动重试 ====================

// 重试功能是否启用（默认启用）
const retryEnabled = computed(() => {
  return currentConfig.value?.retryEnabled ?? true
})

// 更新重试启用状态
async function updateRetryEnabled(enabled: boolean) {
  await updateConfigField('retryEnabled', enabled)
}

// 更新重试次数
async function updateRetryCount(count: number) {
  await updateConfigField('retryCount', count)
}

// 更新重试间隔
async function updateRetryInterval(interval: number) {
  await updateConfigField('retryInterval', interval)
}

// ==================== 草稿模式数字输入 ====================
// 清空后不立即回退旧值（编辑期间保持为空）；离开设置页时自动回填已保存值。

const {
  draft: timeoutDraft,
  handleInput: handleTimeoutInput,
  syncFromStored: syncTimeoutFromStored
} = useDeferredNumberInput(() => currentConfig.value?.timeout)
const {
  draft: maxContextTokensDraft,
  handleInput: handleMaxContextTokensInput,
  syncFromStored: syncMaxContextTokensFromStored
} = useDeferredNumberInput(() => currentConfig.value?.maxContextTokens ?? 256000)
const {
  draft: retryCountDraft,
  handleInput: handleRetryCountInput,
  syncFromStored: syncRetryCountFromStored
} = useDeferredNumberInput(() => currentConfig.value?.retryCount ?? 3)
const {
  draft: retryIntervalDraft,
  handleInput: handleRetryIntervalInput,
  syncFromStored: syncRetryIntervalFromStored
} = useDeferredNumberInput(() => currentConfig.value?.retryInterval ?? 3000)

function syncChannelNumericDrafts() {
  syncTimeoutFromStored()
  syncMaxContextTokensFromStored()
  syncRetryCountFromStored()
  syncRetryIntervalFromStored()
}

// 切换渠道配置时，草稿跟随新配置重置；同时清除上一渠道遗留的阈值输入错误状态（避免新渠道合法值被误标红）
watch(currentConfigId, () => {
  syncChannelNumericDrafts()
  contextThresholdError.value = false
})

// ==================== 工具配置 ====================

// 获取当前工具配置
const toolOptions = computed<ToolOptions>(() => {
  return currentConfig.value?.toolOptions || {}
})

// 更新工具配置
async function updateToolOptions(config: ToolOptions) {
  await updateConfigField('toolOptions', config)
}

// ==================== 上下文阈值 ====================

// 上下文管理总开关。新配置优先使用显式字段，旧配置继续由两个旧布尔字段推导。
const contextManagementEnabled = computed(() => {
  if (typeof currentConfig.value?.contextManagementEnabled === 'boolean') {
    return currentConfig.value.contextManagementEnabled
  }

  return (currentConfig.value?.contextThresholdEnabled ?? false) || (currentConfig.value?.autoSummarizeEnabled ?? false)
})

// 上下文阈值值
const contextThreshold = computed(() => {
  return currentConfig.value?.contextThreshold ?? '80%'
})

const summaryKeepRecentTokensHint = ref<string | number>('50%')
const summaryKeepRecentRoundsHint = ref(2)

interface ContextBudgetHint {
  declaredContextTokens: number
  effectiveInputTokens: number
  maxOutputTokens?: number
  contextWindowIncludesOutput: boolean
  source: 'channel' | 'model' | 'default'
}

function positiveTokenValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

const contextBudgetHint = computed<ContextBudgetHint>(() => {
  const config = currentConfig.value
  const selectedModel = config?.models?.find(model => model.id === config.model)
  const configuredContext = config?.maxContextTokens !== undefined
    ? (positiveTokenValue(maxContextTokensDraft.value) ?? positiveTokenValue(config.maxContextTokens))
    : undefined
  const modelContext = positiveTokenValue(selectedModel?.contextWindow)
  const declaredContextTokens = configuredContext ?? modelContext ?? 256000
  const source: ContextBudgetHint['source'] = configuredContext !== undefined
    ? 'channel'
    : (modelContext !== undefined ? 'model' : 'default')

  let outputKey: 'maxOutputTokens' | 'max_tokens' | 'max_output_tokens' | undefined
  if (config?.type === 'gemini' || config?.type === 'gemini-interactions') outputKey = 'maxOutputTokens'
  if (config?.type === 'openai' || config?.type === 'anthropic') outputKey = 'max_tokens'
  if (config?.type === 'openai-responses') outputKey = 'max_output_tokens'
  const configuredOutput = outputKey
    && config?.optionsEnabled?.[outputKey] === true
    ? positiveTokenValue(config.options?.[outputKey])
    : undefined
  const maxOutputTokens = configuredOutput ?? positiveTokenValue(selectedModel?.maxOutputTokens)
  const contextWindowIncludesOutput = selectedModel?.contextWindowIncludesOutput
    ?? (config?.type === 'openai' || config?.type === 'openai-responses' || config?.type === 'anthropic')
  const effectiveInputTokens = contextWindowIncludesOutput
    ? Math.max(1, declaredContextTokens - (maxOutputTokens ?? 0))
    : declaredContextTokens

  return {
    declaredContextTokens,
    effectiveInputTokens,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    contextWindowIncludesOutput,
    source
  }
})

async function loadSummaryHintConfig() {
  try {
    const response = await sendToExtension<any>(MESSAGE_NAMES.getSummarizeConfig, {})
    if (!response) return
    if (typeof response.keepRecentTokens === 'string' || typeof response.keepRecentTokens === 'number') {
      summaryKeepRecentTokensHint.value = response.keepRecentTokens
    }
    if (typeof response.keepRecentRounds === 'number' && Number.isFinite(response.keepRecentRounds)) {
      summaryKeepRecentRoundsHint.value = Math.max(1, Math.floor(response.keepRecentRounds))
    }
  } catch (error) {
    console.warn('Failed to load summary settings for context threshold help:', error)
  }
}

// 上下文管理统一为“模型总结优先 + 失败时细粒度临时裁剪”。旧 trim 值只作为后端迁移输入。
const contextManagementMode = computed(() => 'summarize')

const contextManagementModeOptions = computed<SelectOption[]>(() => [
  { value: 'summarize', label: t('components.settings.channelSettings.form.contextManagement.mode.summarize') }
])

// 更新上下文管理总开关
async function updateContextManagementEnabled(enabled: boolean) {
  if (enabled) {
    await updateConfigFields({
      contextManagementEnabled: true,
      contextManagementMode: 'summarize',
      contextThresholdEnabled: false,
      autoSummarizeEnabled: true
    })
  } else {
    await updateConfigFields({
      contextManagementEnabled: false,
      contextThresholdEnabled: false,
      autoSummarizeEnabled: false
    })
  }
}

// 上下文阈值输入错误状态（非法输入时标红；:value 绑定已保存值，重渲染时自动回填）
const contextThresholdError = ref(false)

// 更新上下文阈值
async function updateContextThreshold(value: string) {
  // 验证格式：数值 或 百分比
  const numValue = parseFloat(value)
  if (value.endsWith('%')) {
    const percent = parseFloat(value.replace('%', ''))
    if (!isNaN(percent) && percent > 0 && percent <= 100) {
      contextThresholdError.value = false
      await updateConfigField('contextThreshold', value)
      return
    }
  } else if (!isNaN(numValue) && numValue > 0) {
    contextThresholdError.value = false
    await updateConfigField('contextThreshold', numValue)
    return
  }
  // 非法输入：标红提示，输入框回填为已保存值
  contextThresholdError.value = true
}

// 更新上下文管理模式
async function updateContextManagementMode(_mode: string) {
  await updateConfigFields({
    contextManagementEnabled: true,
    contextManagementMode: 'summarize',
    contextThresholdEnabled: false,
    autoSummarizeEnabled: true
  })
}

// 加载配置列表
async function loadConfigs() {
  isLoading.value = true
  try {
    // 重新加载期间使预加载缓存失效：失败时不残留旧缓存（下次进入渠道页会重新加载）。
    // 置于 await listConfigs 之前：避免等待期间（陈旧缓存窗口）预加载缓存仍返回旧列表
    setChannelConfigsCache(null)
    const ids = await sendToExtension<string[]>(MESSAGE_NAMES['config.listConfigs'], {})
    configs.value = []
    // 非数组响应按失败处理（TypeError 进 catch，整批失败语义）：与预加载失败语义对齐，
    // 避免把非法响应当空列表展示
    if (!Array.isArray(ids)) {
      throw new TypeError('config.listConfigs returned non-array response')
    }

    for (const id of ids) {
      const config = await sendToExtension(MESSAGE_NAMES['config.getConfig'], { configId: id })
      if (config) {
        configs.value.push(config)
      }
    }

    // 成功后同步预加载缓存：切回渠道 tab / 再次打开设置页直接复用，不再重复请求
    setChannelConfigsCache(configs.value)

    // 不在这里自动选择配置，让 onMounted 统一处理
  } catch (error) {
    console.error('Failed to load configs:', error)
  } finally {
    isLoading.value = false
  }
}

// 创建新配置
async function createConfig() {
  if (!newConfigName.value.trim()) {
    newConfigNameError.value = true
    return
  }

  try {
    // 只传递必要参数，其他由后端提供默认值
    const configId = await sendToExtension<string>(MESSAGE_NAMES['config.createConfig'], {
      type: newConfigType.value,
      name: newConfigName.value.trim()
    })

    await loadConfigs()
    currentConfigId.value = configId
    showNewDialog.value = false
    newConfigName.value = ''
    newConfigNameError.value = false
  } catch (error) {
    console.error('Failed to create config:', error)
  }
}

// 显示确认对话框
function showConfirm(title: string, message: string, action: () => void) {
  confirmDialogTitle.value = title
  confirmDialogMessage.value = message
  confirmDialogAction.value = action
  showConfirmDialog.value = true
}

// 格式化确认消息（支持变量替换）
function formatMessage(message: string, name: string): string {
  return message.replace('{name}', name)
}

// 确认对话框确认回调
function onConfirmDialogConfirm() {
  confirmDialogAction.value()
}

// 删除当前配置
async function deleteCurrentConfig() {
  if (!currentConfig.value) return

  showConfirm(
    t('components.settings.channelSettings.dialog.delete.title'),
    formatMessage(t('components.settings.channelSettings.dialog.delete.message'), currentConfig.value.name),
    async () => {
      try {
        await sendToExtension(MESSAGE_NAMES['config.deleteConfig'], {
          configId: currentConfig.value!.id
        })
        await loadConfigs()
        // 删光渠道：清空选择并同步 chatStore（无渠道状态）
        if (configs.value.length === 0) {
          currentConfigId.value = ''
          if (chatStore.configId) {
            await chatStore.setConfigId('')
          }
        } else if (!configs.value.some(c => c.id === currentConfigId.value)) {
          // 优先保留聊天仍在用的渠道，其次选中剩余第一个，避免误切当前会话渠道
          currentConfigId.value = configs.value.some(c => c.id === chatStore.configId)
            ? chatStore.configId
            : configs.value[0].id
        }
      } catch (error) {
        console.error('Failed to delete config:', error)
      }
    }
  )
}

// 开始编辑
async function startEditing() {
  if (!currentConfig.value) return
  editingName.value = currentConfig.value.name
  isEditing.value = true
  await nextTick()
  selectorRef.value?.focusEdit()
}

// 保存编辑
async function saveEditing() {
  if (!editingName.value.trim() || !currentConfig.value) {
    isEditing.value = false
    return
  }

  try {
    await sendToExtension(MESSAGE_NAMES['config.updateConfig'], {
      configId: currentConfig.value.id,
      updates: { name: editingName.value.trim() }
    })
    await loadConfigs()
  } catch (error) {
    console.error('Failed to update config:', error)
  }

  isEditing.value = false
}

// 取消编辑
function cancelEditing() {
  isEditing.value = false
  editingName.value = ''
}

// 取消新建
function cancelNew() {
  showNewDialog.value = false
  newConfigName.value = ''
  newConfigNameError.value = false
}

// 新建渠道名称输入：同步名称并清除必填错误
function onNewConfigName(value: string) {
  newConfigName.value = value
  newConfigNameError.value = false
}

// 更改渠道类型（切换后类型特有参数会重置为新类型默认值，需整体重载配置）
function onChangeType(newType: string) {
  if (!currentConfig.value || newType === currentConfig.value.type) return
  // 快照 configId：确认回调异步执行期间用户可能切换/删除配置
  const configId = currentConfig.value.id

  showConfirm(
    t('components.settings.channelSettings.dialog.changeType.title'),
    formatMessage(t('components.settings.channelSettings.dialog.changeType.message'), getTypeName(newType)),
    async () => {
      try {
        // 先完成旧类型界面中尚未落盘的 URL/Key 保存，再切换类型；保证写入顺序，
        // 避免延迟回调在类型重置完成后又把旧值覆盖回来。
        await prepareModelFetch()
        await sendToExtension(MESSAGE_NAMES['config.updateConfig'], {
          configId,
          updates: { type: newType }
        })
        await loadConfigs()
        if (configId === chatStore.configId) {
          await chatStore.loadCurrentConfig()
          // 类型变更后后端已重置模型列表/当前模型：清掉会话级模型覆盖，
          // 避免残留旧类型模型 ID 被当作显式模型发送（报 404/参数错误）
          await chatStore.setSelectedModelId(chatStore.currentConfig?.model || '')
        }
      } catch (error) {
        console.error('Failed to update channel type:', error)
      }
    }
  )
}

// apiKey / url 输入防抖：@input 每按键全量写配置，300ms 防抖减少扩展往返。
// 复用共享 useDeferredSave：每次 schedule 只保留最新一次提交，卸载时自动 flush（避免最后一次编辑丢失）。
// 输入按字段累积为「聚合 pending patch」：同一防抖窗口内先输入的字段不会被后输入的字段覆盖，
// 触发时用一次 updateConfigFields 合并提交（避免两个字段各自提交互相覆盖）。
const { schedule: scheduleApiKeyUrlSave, flush: flushApiKeyUrlSave } = useDeferredSave({ delay: 300, flushOnUnmount: true })

// 尚未提交的 url/apiKey 编辑补丁（按字段聚合；提交或渠道切换时清空）
let pendingUrlApiKeyPatch: Partial<Pick<ChannelConfig, 'url' | 'apiKey'>> | null = null
// 补丁所属渠道 ID：渠道切换后旧渠道残留补丁作废，避免跨渠道合并
let pendingUrlApiKeyConfigId = ''

async function commitPendingApiKeyUrlPatch(configId: string): Promise<void> {
  // 旧渠道已有提交仍在队列中时，新渠道可能已产生自己的补丁；旧回调不得读取或清空它。
  if (pendingUrlApiKeyConfigId !== configId) return
  const patch = pendingUrlApiKeyPatch
  pendingUrlApiKeyPatch = null
  if (configId !== currentConfigId.value || !patch) return

  const saved = await updateConfigFields(patch)
  if (saved) return

  // 保存失败时把补丁放回其原渠道的待提交区；期间若同渠道又有输入，新值覆盖旧值。
  // 即使用户已经切走，切回该渠道后仍可重试，而不会被 rejected latestRun 永久阻塞。
  if (pendingUrlApiKeyConfigId === configId) {
    pendingUrlApiKeyPatch = { ...patch, ...(pendingUrlApiKeyPatch || {}) }
  }
  throw new Error('Failed to persist channel URL/API key')
}

function handleApiKeyUrlInput(field: 'url' | 'apiKey', value: string) {
  // 输入时快照渠道 ID：防抖窗口内用户可能切换渠道；回调触发时若渠道已切换则丢弃本次输入
  const configId = currentConfigId.value
  // 渠道切换后重置补丁：新渠道的输入不应与旧渠道残留补丁合并
  if (pendingUrlApiKeyConfigId !== configId) {
    pendingUrlApiKeyPatch = null
    pendingUrlApiKeyConfigId = configId
  }
  // 聚合：同一防抖窗口内 url / apiKey 各自累积，后输入字段不覆盖先输入字段
  pendingUrlApiKeyPatch = { ...pendingUrlApiKeyPatch, [field]: value }
  scheduleApiKeyUrlSave(() => commitPendingApiKeyUrlPatch(configId))
}

// 打开模型选择对话框前先落盘未保存的 url/apiKey 编辑。
// 若保存途中又有输入，循环再提交一次，确保 models.getModels 读取的是最后一次界面值。
async function prepareModelFetch() {
  const configId = currentConfigId.value
  // 保存器由设置页复用；另一渠道最近一次保存的结果不应阻塞当前渠道获取模型。
  if (pendingUrlApiKeyConfigId && pendingUrlApiKeyConfigId !== configId) return
  do {
    if (pendingUrlApiKeyConfigId === configId && pendingUrlApiKeyPatch) {
      scheduleApiKeyUrlSave(() => commitPendingApiKeyUrlPatch(configId))
    }
    await flushApiKeyUrlSave()
  } while (
    currentConfigId.value === configId
    && pendingUrlApiKeyConfigId === configId
    && pendingUrlApiKeyPatch
  )
}

// 更新多个配置字段（单个请求，避免竞态条件）
async function updateConfigFields(updates: Partial<ChannelConfig>): Promise<boolean> {
  if (!currentConfig.value) return false
  // await 前捕获目标配置 id：请求往返期间用户可能已切换渠道，
  // 若 await 后重新读 currentConfig.value.id 会命中新渠道，把旧渠道的 updates 合并进新渠道本地配置（跨渠道污染）
  const configId = currentConfig.value.id

  try {
    // 确保数据可序列化（structuredClone 一次性深拷贝移除响应式代理，
    // 替代循环内逐字段 JSON.parse(JSON.stringify) 往返）。
    // 深度响应式 ref 的 Proxy 无法 structuredClone（抛 DataCloneError），失败时回退 JSON
    // 往返（与 utils/tools/diffPreviewAction.deepCloneForPreview 同款），避免保存静默失败。
    let serializableUpdates: Partial<ChannelConfig>
    try {
      serializableUpdates = structuredClone(updates)
    } catch {
      serializableUpdates = JSON.parse(JSON.stringify(updates))
    }

    await sendToExtension(MESSAGE_NAMES['config.updateConfig'], {
      configId,
      updates: serializableUpdates
    })

    // 渠道已切换：跳过本地合并（后端已写入旧渠道，其数据在下次 loadConfigs 时正确；
    // 避免旧渠道的 updates 污染新渠道的本地显示）
    if (currentConfig.value?.id !== configId) {
      // 后端已写入旧渠道但本地合并被跳过：共享缓存仍保留编辑前值，失效缓存避免下次挂载读到陈旧数据
      setChannelConfigsCache(null)
      return true
    }

    // 直接在本地更新配置值
    const configIndex = configs.value.findIndex(c => c.id === configId)
    if (configIndex !== -1) {
      configs.value[configIndex] = {
        ...configs.value[configIndex],
        ...serializableUpdates
      } as ChannelConfig
    }

    // 如果修改的是当前使用的配置，同步到 chatStore
    if (configId === chatStore.configId) {
      await chatStore.loadCurrentConfig()
    }
    return true
  } catch (error) {
    console.error('Failed to update config fields:', error)
    return false
  }
}

// 更新配置字段
async function updateConfigField(field: string, value: any) {
  if (!currentConfig.value) return
  // await 前捕获目标配置 id（防止往返期间切渠道后，本地更新污染新渠道）
  const configId = currentConfig.value.id

  try {
    // 确保数据可序列化（深拷贝移除响应式代理）
    let serializableValue = JSON.parse(JSON.stringify(value))

    // 特殊处理 models 字段
    if (field === 'models' && Array.isArray(serializableValue)) {
      serializableValue = serializableValue.map((m: any) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        contextWindowIncludesOutput: m.contextWindowIncludesOutput
      }))
    }

    await sendToExtension(MESSAGE_NAMES['config.updateConfig'], {
      configId,
      updates: { [field]: serializableValue }
    })

    // 渠道已切换：跳过本地合并
    if (currentConfig.value?.id !== configId) {
      // 同上：失效共享缓存，避免下次挂载读到旧渠道编辑前的陈旧值
      setChannelConfigsCache(null)
      return
    }

    // 直接在本地更新配置值，避免重新加载导致滚动位置丢失
    const configIndex = configs.value.findIndex(c => c.id === configId)
    if (configIndex !== -1) {
      configs.value[configIndex] = {
        ...configs.value[configIndex],
        [field]: serializableValue
      } as ChannelConfig
    }

    // 如果修改的是当前使用的配置，同步到 chatStore
    if (configId === chatStore.configId) {
      await chatStore.loadCurrentConfig()
    }
  } catch (error) {
    console.error('Failed to update config:', error)
  }
}

// 草稿数字输入 → 配置字段提交的薄封装
function onTimeoutInput(value: string) {
  handleTimeoutInput(value, v => updateConfigField('timeout', v))
}
function onMaxContextTokensInput(value: string) {
  handleMaxContextTokensInput(value, v => updateConfigField('maxContextTokens', v))
}
function onRetryCountInput(value: string) {
  handleRetryCountInput(value, v => updateRetryCount(v))
}
function onRetryIntervalInput(value: string) {
  handleRetryIntervalInput(value, v => updateRetryInterval(v))
}

// 渠道选中态同步：优先沿用聊天当前使用的渠道，其次保持已选渠道，最后回退第一个。
// 抽成函数供 onMounted 与外部变更重拉后复用（两处逻辑必须一致，否则导入后会停在空选中态）。
function syncSelectedConfigId(): void {
  if (chatStore.configId && configs.value.some(c => c.id === chatStore.configId)) {
    currentConfigId.value = chatStore.configId
  } else if (configs.value.length > 0 && !currentConfigId.value) {
    // 如果 chatStore 没有配置或配置不存在，才选择第一个
    currentConfigId.value = configs.value[0].id
  }
}

// 外部批量变更（设置导入等）后重拉：本组件自身的单次编辑已就地刷新，不能重复跑全量请求，
// 因此只处理不带 configId 的推送（约定见 webview/utils/configChangeNotifier）。
async function reloadFromExternalChange(): Promise<void> {
  await loadConfigs()
  syncSelectedConfigId()
  // 覆盖导入会改变当前使用渠道的内容（url / 模型 / 选项等），chatStore 的渠道快照需一并刷新
  if (chatStore.configId) {
    await chatStore.loadCurrentConfig()
  }
}

let unsubscribeConfigChanged: (() => void) | null = null

// 是否已完成初始化（防止初始化时的 watch 触发同步）
const isInitialized = ref(false)

// 监听 currentConfigId 变化，同步到 chatStore（仅在初始化完成后）
watch(currentConfigId, (newId) => {
  if (isInitialized.value && newId && newId !== chatStore.configId) {
    chatStore.setConfigId(newId)
  }
})

// 监听 chatStore.configId 变化，同步到本地
watch(() => chatStore.configId, (newId) => {
  if (newId && newId !== currentConfigId.value && configs.value.some(c => c.id === newId)) {
    currentConfigId.value = newId
  }
})

// 初始化
onMounted(async () => {
  // 复用启动时预加载的渠道配置缓存（幂等，加载中则复用同一请求）；
  // 预加载失败/超时/未触发时（缓存保持 null）同一挂载内调用 loadConfigs() 兜底重试一次，
  // 避免预加载失败直接显示误导性空态
  // await 期间用 isLoading 抑制空态渲染，避免加载中误显示「无渠道」引导
  isLoading.value = true
  try {
    await Promise.all([
      preloadChannelConfigs(),
      loadSummaryHintConfig()
    ])
    const cachedConfigs = getChannelConfigsCache()
    if (cachedConfigs === null) {
      await loadConfigs()
    } else {
      configs.value = cachedConfigs
    }
  } finally {
    isLoading.value = false
  }

  // 优先使用 chatStore 的配置 ID
  syncSelectedConfigId()

  // 设置导入等外部批量变更渠道后重拉列表（不监听则需重启插件才能看到新导入的渠道）
  unsubscribeConfigChanged = onExtensionCommand(
    PUSH_MESSAGE_NAMES['channels.configChanged'],
    (data?: { configId?: string }) => {
      if (data?.configId) return
      void reloadFromExternalChange()
    }
  )

  // 标记初始化完成
  isInitialized.value = true
})

onUnmounted(() => {
  if (unsubscribeConfigChanged) {
    unsubscribeConfigChanged()
    unsubscribeConfigChanged = null
  }
})
</script>

<template>
  <div class="channel-settings">
    <!-- 确认对话框 -->
    <ConfirmDialog
      v-model="showConfirmDialog"
      :title="confirmDialogTitle"
      :message="confirmDialogMessage"
      :is-danger="confirmDialogTitle === t('components.settings.channelSettings.dialog.delete.title')"
      :confirm-text="t('components.settings.channelSettings.dialog.delete.confirm')"
      :cancel-text="t('components.settings.channelSettings.dialog.delete.cancel')"
      @confirm="onConfirmDialogConfirm"
    />

    <!-- 配置选择器 -->
    <ChannelConfigSelector
      ref="selectorRef"
      :is-editing="isEditing"
      :editing-name="editingName"
      :current-config-id="currentConfigId"
      :config-options="configOptions"
      @update:editing-name="editingName = $event"
      @update:current-config-id="currentConfigId = $event"
      @rename="startEditing"
      @save="saveEditing"
      @cancel="cancelEditing"
      @add="showNewDialog = true"
      @delete="deleteCurrentConfig"
    />

    <!-- 新建对话框 -->
    <ChannelCreateDialog
      :show="showNewDialog"
      :name="newConfigName"
      :type="newConfigType"
      :name-error="newConfigNameError"
      :type-options="typeOptions"
      @update:name="onNewConfigName"
      @update:type="newConfigType = $event"
      @create="createConfig"
      @cancel="cancelNew"
    />

    <!-- 配置表单 -->
    <div v-if="currentConfig" class="config-form">
      <ChannelBasicSettings
        :config="currentConfig"
        :show-api-key="showApiKey"
        :type-options="typeOptions"
        :tool-mode-options="toolModeOptions"
        :timeout-draft="timeoutDraft"
        :max-context-tokens-draft="maxContextTokensDraft"
        :prepare-model-fetch="prepareModelFetch"
        @update:field="updateConfigField"
        @update:option="updateOption"
        @api-key-url-input="handleApiKeyUrlInput"
        @timeout-input="onTimeoutInput"
        @max-context-tokens-input="onMaxContextTokensInput"
        @toggle-show-api-key="showApiKey = !showApiKey"
        @change-type="onChangeType"
      />

      <ChannelContextManagement
        :show="showContextThreshold"
        :context-management-enabled="contextManagementEnabled"
        :context-threshold="contextThreshold"
        :context-management-mode="contextManagementMode"
        :context-management-mode-options="contextManagementModeOptions"
        :context-threshold-error="contextThresholdError"
        :context-budget="contextBudgetHint"
        :summary-keep-recent-tokens="summaryKeepRecentTokensHint"
        :summary-keep-recent-rounds="summaryKeepRecentRoundsHint"
        @update:show="showContextThreshold = $event"
        @update:enabled="updateContextManagementEnabled"
        @update:threshold="updateContextThreshold"
        @update:mode="updateContextManagementMode"
      />

      <ChannelToolOptions
        :show="showToolOptions"
        :tool-options="toolOptions"
        @update:show="showToolOptions = $event"
        @update:config="updateToolOptions"
      />

      <ChannelTokenCountMethod
        :show="showTokenCountMethod"
        :token-count-method="currentConfig.tokenCountMethod || 'channel_default'"
        :token-count-api-config="currentConfig.tokenCountApiConfig || {}"
        :channel-type="currentConfig.type"
        @update:show="showTokenCountMethod = $event"
        @update:token-count-method="(v: any) => updateConfigField('tokenCountMethod', v)"
        @update:token-count-api-config="(v: any) => updateConfigField('tokenCountApiConfig', v)"
      />

      <ChannelProviderOptions
        :show="showAdvancedOptions"
        :config="currentConfig"
        @update:show="showAdvancedOptions = $event"
        @update:option="updateOption"
        @update:option-enabled="updateOptionEnabled"
        @update:field="updateConfigField"
      />

      <ChannelCustomBody
        :show="showCustomBody"
        :custom-body="customBody"
        :enabled="customBodyEnabled"
        @update:show="showCustomBody = $event"
        @update:enabled="updateCustomBodyEnabled"
        @update:config="updateCustomBodyConfig"
      />

      <ChannelCustomHeaders
        :show="showCustomHeaders"
        :headers="customHeaders"
        :enabled="customHeadersEnabled"
        @update:show="showCustomHeaders = $event"
        @update:enabled="updateCustomHeadersEnabled"
        @update:headers="updateCustomHeaders"
      />

      <ChannelOpenCodeSession
        :enabled="currentConfig.openCodeSessionEnabled ?? false"
        @update:enabled="(v: boolean) => updateConfigField('openCodeSessionEnabled', v)"
      />

      <ChannelAutoRetry
        :show="showRetryOptions"
        :retry-enabled="retryEnabled"
        :retry-count-draft="retryCountDraft"
        :retry-interval-draft="retryIntervalDraft"
        @update:show="showRetryOptions = $event"
        @update:enabled="updateRetryEnabled"
        @retry-count-input="onRetryCountInput"
        @retry-interval-input="onRetryIntervalInput"
      />
    </div>

    <!-- 无渠道空态：首次打开无默认渠道，引导用户新建（加载中不渲染，避免误引导） -->
    <div v-else-if="!isLoading" class="config-empty">
      <i class="codicon codicon-plug channel-empty-icon"></i>
      <p class="config-empty-text">{{ t('components.settings.channelSettings.empty.title') }}</p>
      <p class="config-empty-hint">{{ t('components.settings.channelSettings.empty.hint') }}</p>
      <button class="btn primary" @click="showNewDialog = true">
        <i class="codicon codicon-add"></i>
        {{ t('components.settings.channelSettings.empty.create') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.channel-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 无渠道空态 */
.config-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 24px;
  text-align: center;
  border: 1px dashed var(--vscode-panel-border);
  border-radius: 4px;
}

.channel-empty-icon {
  font-size: 32px;
  color: var(--vscode-descriptionForeground);
}

.config-empty-text {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.config-empty-hint {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

/* 表单 */
.config-form {
  padding-top: 8px;
  border-top: 1px solid var(--vscode-panel-border);
}

.btn {
  padding: 6px 12px;
  border: none;
  border-radius: 2px;
  font-size: 12px;
  cursor: pointer;
}

.btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.btn.primary:hover {
  background: var(--vscode-button-hoverBackground);
}
</style>
