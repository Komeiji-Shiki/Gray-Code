<script setup lang="ts">
/**
 * SubAgentsSettings - 子代理设置面板
 *
 * 功能：
 * 1. 管理子代理配置（新建、编辑、删除）
 * 2. 配置子代理的系统提示词
 * 3. 选择子代理使用的渠道和模型
 * 4. 配置子代理可用的工具列表
 *
 * S7 批次拆分（纯结构性拆分，行为零变化）：
 * - 全局配置 / 基本信息 / 渠道模型 / 工具配置 / 新建对话框 / 重命名对话框拆至 subAgentsSettings/ 子组件；
 * - 本组件只保留状态、动作与编排，子组件仅通过 props 通信。
 */

import { MESSAGE_NAMES } from '@shared/protocol'
import { ref, computed, onMounted } from 'vue'
import { CustomSelect, ConfirmDialog, type SelectOption } from '../common'
import { sendToExtension } from '@/utils/vscode'
import { useI18n } from '@/i18n'
import type { SubAgentConfig, SubAgentToolsConfig } from '@/types'
import { groupToolsByCategory } from '@/utils/toolCategory'
import SubAgentGlobalConfigSection from './subAgentsSettings/SubAgentGlobalConfigSection.vue'
import SubAgentBasicInfoSection from './subAgentsSettings/SubAgentBasicInfoSection.vue'
import SubAgentChannelModelSection from './subAgentsSettings/SubAgentChannelModelSection.vue'
import SubAgentToolsSection from './subAgentsSettings/SubAgentToolsSection.vue'
import CreateSubAgentDialog from './subAgentsSettings/CreateSubAgentDialog.vue'
import RenameSubAgentDialog from './subAgentsSettings/RenameSubAgentDialog.vue'
import type { ChannelConfig, ToolInfo, SubAgentPreset } from './subAgentsSettings/types'

const { t } = useI18n()

// ==================== 状态 ====================

// 全局配置
const maxConcurrentAgents = ref(3)
// 通用 Worker（傻瓜式多 agent 模式）开关，默认开启
const generalWorkerEnabled = ref(true)
// 全局默认迭代次数（未单独配置的 agent 与 General Worker 继承，默认 80）
const defaultMaxIterations = ref(80)
// 排队超时（秒，-1 表示无限制，默认 600）
const queueTimeoutSeconds = ref(600)
// 全局默认运行时间上限（秒，-1 表示无限制，默认 1800 = 30 分钟；未单独配置 maxRuntime 的 agent 继承）
const defaultMaxRuntimeSeconds = ref(1800)

// 子代理列表
const subAgents = ref<SubAgentConfig[]>([])
const currentAgentType = ref<string>('')
const isLoading = ref(false)

// 编辑模式
const isEditing = ref(false)
const editingName = ref('')
const renameError = ref('')

// 新建对话框
const showNewDialog = ref(false)
const newAgentName = ref('')
const isCreating = ref(false)
const createError = ref('')

// 预设模板：新建对话框中可选择模板预填全部字段，创建后仍可在现有编辑界面调整
const presets = ref<SubAgentPreset[]>([])
const selectedPresetId = ref('')
const newAgentChannelId = ref('')

// 删除确认
const showDeleteConfirm = ref(false)
const deleteAgentType = ref('')

// 字段保存 / 删除失败的提示（成功保存后自动清空）
const saveError = ref('')

// 渠道列表
const channels = ref<ChannelConfig[]>([])
const isLoadingChannels = ref(false)

// 工具列表
const allTools = ref<ToolInfo[]>([])
const isLoadingTools = ref(false)

// ==================== 计算属性 ====================

// 当前选中的子代理
const currentAgent = computed(() =>
  subAgents.value.find(a => a.type === currentAgentType.value)
)

// 子代理下拉选项
const agentOptions = computed<SelectOption[]>(() =>
  subAgents.value.map(agent => ({
    value: agent.type,
    label: agent.name,
    description: agent.enabled === false ? t('components.settings.subagents.disabled') : ''
  }))
)

// 已启用的渠道选项
const channelOptions = computed<SelectOption[]>(() =>
  channels.value
    .filter(c => c.enabled)
    .map(c => ({
      value: c.id,
      label: c.name,
      description: c.type
    }))
)

// 当前选择的渠道
const selectedChannel = computed(() =>
  channels.value.find(c => c.id === currentAgent.value?.channel.channelId)
)

// 当前渠道的模型选项
const modelOptions = computed<SelectOption[]>(() => {
  if (!selectedChannel.value?.models) return []
  return selectedChannel.value.models.map(m => ({
    value: m.id,
    label: m.name || m.id,
    description: m.description
  }))
})

// 当前代理是否勾选「与当前模型同步」：勾选后忽略自身固定渠道/模型，运行时使用当前会话渠道与模型
const currentAgentSyncsWithCurrent = computed(() =>
  currentAgent.value?.channel.syncWithCurrentModel === true
)

// 工具模式选项
const toolModeOptions = computed<SelectOption[]>(() => [
  { value: 'all', label: t('components.settings.subagents.toolMode.all') },
  { value: 'builtin', label: t('components.settings.subagents.toolMode.builtin') },
  { value: 'mcp', label: t('components.settings.subagents.toolMode.mcp') },
  { value: 'whitelist', label: t('components.settings.subagents.toolMode.whitelist') },
  { value: 'blacklist', label: t('components.settings.subagents.toolMode.blacklist') }
])

// 按分类分组的全部工具（内置 + MCP，MCP 归入 mcp 分类）
const toolsByCategory = computed(() => groupToolsByCategory(allTools.value))

// 当前工具列表（白名单或黑名单）
const currentToolList = computed(() => {
  const mode = currentAgent.value?.tools.mode
  if (mode === 'whitelist') {
    return currentAgent.value?.tools.whitelist || []
  } else if (mode === 'blacklist') {
    return currentAgent.value?.tools.blacklist || []
  }
  return []
})

// 检查工具是否被选中
function isToolSelected(toolName: string): boolean {
  return currentToolList.value.includes(toolName)
}

// 切换工具选中状态
async function toggleTool(toolName: string, selected: boolean) {
  if (!currentAgent.value) return

  const mode = currentAgent.value.tools.mode
  const listKey = mode === 'whitelist' ? 'whitelist' : 'blacklist'
  const currentList = [...(currentAgent.value.tools[listKey] || [])]

  if (selected) {
    if (!currentList.includes(toolName)) {
      currentList.push(toolName)
    }
  } else {
    const index = currentList.indexOf(toolName)
    if (index > -1) {
      currentList.splice(index, 1)
    }
  }

  await updateAgentField('tools', {
    ...currentAgent.value.tools,
    [listKey]: currentList
  })
}

// ==================== 方法 ====================

// 加载子代理列表和全局配置
async function loadSubAgents() {
  isLoading.value = true
  try {
    const response = await sendToExtension<{ agents: SubAgentConfig[], maxConcurrentAgents?: number, generalWorkerEnabled?: boolean, defaultMaxIterations?: number, queueTimeoutSeconds?: number, defaultMaxRuntimeSeconds?: number }>(MESSAGE_NAMES['subagents.list'], {})
    if (response?.agents) {
      subAgents.value = response.agents
      // 加载全局配置
      if (response.maxConcurrentAgents !== undefined) {
        maxConcurrentAgents.value = response.maxConcurrentAgents
      }
      generalWorkerEnabled.value = response.generalWorkerEnabled !== false
      if (response.defaultMaxIterations !== undefined) {
        defaultMaxIterations.value = response.defaultMaxIterations
      }
      if (response.queueTimeoutSeconds !== undefined) {
        queueTimeoutSeconds.value = response.queueTimeoutSeconds
      }
      if (response.defaultMaxRuntimeSeconds !== undefined) {
        defaultMaxRuntimeSeconds.value = response.defaultMaxRuntimeSeconds
      }
      // 如果有代理但没有选中，选中第一个
      if (subAgents.value.length > 0 && !currentAgentType.value) {
        currentAgentType.value = subAgents.value[0].type
      }
    }
  } catch (error) {
    console.error('Failed to load subagents:', error)
  } finally {
    isLoading.value = false
  }
}

// 提取可读的错误文案，供保存失败横幅使用
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : String(error)
}

// 更新全局配置
async function updateGlobalConfig(key: string, value: unknown) {
  try {
    await sendToExtension(MESSAGE_NAMES['subagents.updateGlobalConfig'], { [key]: value })
    saveError.value = ''
  } catch (error) {
    console.error('Failed to update global config:', error)
    saveError.value = errorText(error)
  }
}

// 加载渠道列表
async function loadChannels() {
  isLoadingChannels.value = true
  try {
    const ids = await sendToExtension<string[]>(MESSAGE_NAMES['config.listConfigs'], {})
    const loadedChannels: ChannelConfig[] = []

    for (const id of ids || []) {
      const config = await sendToExtension<ChannelConfig>(MESSAGE_NAMES['config.getConfig'], { configId: id })
      if (config) {
        loadedChannels.push(config)
      }
    }

    channels.value = loadedChannels
  } catch (error) {
    console.error('Failed to load channels:', error)
  } finally {
    isLoadingChannels.value = false
  }
}

// 加载工具列表
async function loadTools() {
  isLoadingTools.value = true
  try {
    // 加载内置工具
    const builtinResponse = await sendToExtension<{ tools: any[] }>(MESSAGE_NAMES['tools.getTools'], {})
    const builtinTools: ToolInfo[] = (builtinResponse?.tools || []).map(t => ({
      ...t,
      source: 'builtin' as const
    }))

    // 加载 MCP 工具
    const mcpResponse = await sendToExtension<{ tools: any[] }>(MESSAGE_NAMES['tools.getMcpTools'], {})
    const mcpTools: ToolInfo[] = (mcpResponse?.tools || []).map(t => ({
      name: t.name,
      description: t.description || '',
      category: 'mcp',
      source: 'mcp' as const,
      serverId: t.serverId,
      serverName: t.serverName
    }))

    allTools.value = [...builtinTools, ...mcpTools]
  } catch (error) {
    console.error('Failed to load tools:', error)
  } finally {
    isLoadingTools.value = false
  }
}

// 选择子代理
function selectAgent(agentType: string) {
  currentAgentType.value = agentType
}

/**
 * 更新当前代理的单个字段。
 *
 * 返回保存结果而不是抛出：模板里的 @change / @update:modelValue 都不接 catch，
 * 抛出会变成 unhandled rejection；而原先直接吞掉错误则让 saveRename 的失败分支成了死代码，
 * 后端拒绝保存时编辑框照常关闭，用户看到的是「改成功了但值没变」。
 *
 * 乐观更新：先合并到本地再发请求，避免保存往返窗口内连续编辑互相覆盖（对象字段做字段级
 * 合并，不整体替换，防止丢 channel.modelId/syncWithCurrentModel）；保存失败时回滚本地。
 */
async function updateAgentField<K extends keyof SubAgentConfig>(field: K, value: unknown): Promise<{ ok: boolean; error?: unknown }> {
  if (!currentAgent.value) return { ok: false }

  // await 前捕获代理类型并按 agentType 定位本地对象：往返期间用户可能切换代理，
  // 本地合并始终落到捕获的旧代理上，不会污染新选中的代理
  const agentType = currentAgentType.value
  const agent = subAgents.value.find(a => a.type === agentType)
  const previous = agent ? agent[field] : undefined

  if (agent) {
    const next = isPlainObject(previous) && isPlainObject(value)
      ? { ...(previous as Record<string, unknown>), ...value }
      : value
    agent[field] = next as SubAgentConfig[K]
  }

  try {
    await sendToExtension(MESSAGE_NAMES['subagents.update'], {
      type: agentType,
      updates: { [field]: value }
    })

    saveError.value = ''
    return { ok: true }
  } catch (error) {
    // 保存失败：回滚本地状态，避免 UI 显示已保存而实际未写入
    const rollbackTarget = subAgents.value.find(a => a.type === agentType)
    if (rollbackTarget) {
      rollbackTarget[field] = previous as SubAgentConfig[K]
    }
    console.error('Failed to update subagent:', error)
    saveError.value = errorText(error)
    return { ok: false, error }
  }
}

// 判断是否为普通对象（用于 updateAgentField 的对象字段级合并）
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// 切换「与当前模型同步」：勾选后该代理忽略自身固定渠道/模型，运行时使用当前会话渠道与模型
async function toggleSyncWithCurrentModel(value: boolean) {
  if (!currentAgent.value) return
  await updateAgentField('channel', {
    ...currentAgent.value.channel,
    syncWithCurrentModel: value
  })
}

// 子组件回调：基本信息字段更新
function handleBasicFieldUpdate(field: 'description' | 'maxIterations' | 'maxRuntime' | 'enabled', value: unknown) {
  void updateAgentField(field, value)
}

// 子组件回调：工具配置更新（保持原 { ...tools, mode } 字段级合并语义）
function handleUpdateTools(tools: SubAgentToolsConfig) {
  void updateAgentField('tools', tools)
}

// 子组件回调：选择渠道（切渠道时清空模型选择）
function handleSelectChannel(channelId: string) {
  if (!currentAgent.value) return
  void updateAgentField('channel', { ...currentAgent.value.channel, channelId, modelId: '' })
}

// 子组件回调：选择模型
function handleSelectModel(modelId: string) {
  if (!currentAgent.value) return
  void updateAgentField('channel', { ...currentAgent.value.channel, modelId })
}

// 子组件回调：通用 Worker 开关
function handleGeneralWorkerToggle(value: boolean) {
  generalWorkerEnabled.value = value
  void updateGlobalConfig('generalWorkerEnabled', value)
}

// 全局数字输入非法提示（就地校验并提示，不再静默回退默认值）
const globalNumberError = ref('')

function handleGlobalNumberChange(event: Event, field: 'maxConcurrentAgents' | 'defaultMaxIterations' | 'defaultMaxRuntimeSeconds') {
  const raw = (event.target as HTMLInputElement).value
  const parsed = parseInt(raw, 10)
  // defaultMaxIterations 要求 1-1000；maxConcurrentAgents / defaultMaxRuntimeSeconds：-（无限制）或 >=1 合法，0 非法
  const isIterations = field === 'defaultMaxIterations'
  const max = isIterations ? 1000 : Number.POSITIVE_INFINITY
  const invalid = isIterations
    ? isNaN(parsed) || parsed < 1 || parsed > max
    : isNaN(parsed) || parsed < -1 || parsed === 0
  if (invalid) {
    // 非法输入：就地提示；:value 绑定已保存值，重渲染时自动回填
    globalNumberError.value = isIterations
      ? '请输入 1-1000 之间的整数'
      : '请输入 -1 或不小于 1 的整数'
    return
  }
  globalNumberError.value = ''
  if (field === 'maxConcurrentAgents') {
    maxConcurrentAgents.value = parsed
    void updateGlobalConfig('maxConcurrentAgents', parsed)
  } else if (field === 'defaultMaxIterations') {
    defaultMaxIterations.value = parsed
    void updateGlobalConfig('defaultMaxIterations', parsed)
  } else {
    defaultMaxRuntimeSeconds.value = parsed
    void updateGlobalConfig('defaultMaxRuntimeSeconds', parsed)
  }
}

// 排队超时（秒）：-1（无限制）或 >=1 合法，0 非法
function handleQueueTimeout(event: Event) {
  const raw = (event.target as HTMLInputElement).value
  const parsed = parseInt(raw, 10)
  if (isNaN(parsed) || parsed < -1 || parsed === 0) {
    globalNumberError.value = t('components.settings.subagents.queueTimeoutSecondsInvalid')
    return
  }
  globalNumberError.value = ''
  queueTimeoutSeconds.value = parsed
  void updateGlobalConfig('queueTimeoutSeconds', parsed)
}

// 打开新建对话框
function openCreateDialog() {
  newAgentName.value = ''
  createError.value = ''
  selectedPresetId.value = ''
  // 默认选中第一个可用渠道，创建后可在编辑界面调整
  newAgentChannelId.value = channelOptions.value[0]?.value || ''
  showNewDialog.value = true
}

// 关闭新建对话框
function closeCreateDialog() {
  showNewDialog.value = false
}

// 加载预设模板列表
async function loadPresets() {
  try {
    const response = await sendToExtension<{ presets: SubAgentPreset[] }>(MESSAGE_NAMES['subagents.getPresets'], {})
    presets.value = response?.presets || []
  } catch (error) {
    console.error('Failed to load subagent presets:', error)
  }
}

// presetId（kebab-case）转 i18n 键名（camelCase）
function presetI18nKey(presetId: string): string {
  return presetId.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

// 模板本地化名称（缺失时回退英文默认名）
function presetName(preset: SubAgentPreset): string {
  const key = `components.settings.subagents.presets.${presetI18nKey(preset.presetId)}.name`
  const localized = t(key)
  return localized === key ? preset.defaultName : localized
}

// 模板本地化描述（缺失时回退英文默认描述）
function presetDescription(preset: SubAgentPreset): string {
  const key = `components.settings.subagents.presets.${presetI18nKey(preset.presetId)}.description`
  const localized = t(key)
  return localized === key ? preset.defaultDescription : localized
}

// 选择模板：名称为空或仍是其他模板的默认名时自动预填；切换回空白模板则清空名称
function selectPreset(presetId: string) {
  selectedPresetId.value = presetId
  const preset = presets.value.find(p => p.presetId === presetId)
  if (!preset) {
    // 空白模板：清空名称，让用户自行输入
    newAgentName.value = ''
    return
  }
  const currentName = newAgentName.value.trim()
  const isAutoName = !currentName || presets.value.some(p => presetName(p) === currentName)
  if (isAutoName) {
    newAgentName.value = presetName(preset)
  }
}

// 生成唯一的子代理类型 ID
function generateAgentTypeId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 6)
  return `agent_${timestamp}_${random}`
}

// 创建子代理
async function createAgent() {
  const trimmedName = newAgentName.value.trim()

  if (!trimmedName) {
    createError.value = t('components.settings.subagents.createDialog.nameRequired')
    return
  }

  // 本地检查名称是否重复
  const nameExists = subAgents.value.some(
    a => a.name.toLowerCase() === trimmedName.toLowerCase()
  )
  if (nameExists) {
    createError.value = t('components.settings.subagents.createDialog.nameDuplicate')
    return
  }

  isCreating.value = true
  createError.value = ''

  // 自动生成类型 ID
  const agentTypeId = generateAgentTypeId()

  try {
    // 选中模板时预填全部字段；description/systemPrompt 使用英文原文（面向模型），UI 展示才用本地化文案
    const preset = presets.value.find(p => p.presetId === selectedPresetId.value)
    // 修改原因：preset 来自 Vue ref 响应式数组，其子对象（如 tools）是 Proxy，
    //           vscode.postMessage 的 structured clone 无法序列化 Proxy，会抛 DataCloneError。
    // 修改方式：通过 JSON 往返解包所有 Proxy，确保 payload 是纯 JSON 兼容对象。
    // 修改目的：选择预设模板创建子代理时不再报 "could not be cloned"。
    const payload = JSON.parse(JSON.stringify({
      type: agentTypeId,
      name: trimmedName,
      description: preset?.defaultDescription || '',
      systemPrompt: preset?.systemPrompt || '',
      channel: { channelId: newAgentChannelId.value || '' },
      tools: preset ? preset.tools : { mode: 'all' },
      maxIterations: preset?.maxIterations,
      maxRuntime: preset?.maxRuntime,
      enabled: true
    }))
    await sendToExtension(MESSAGE_NAMES['subagents.create'], payload)

    // 重新加载并选中新创建的
    await loadSubAgents()
    currentAgentType.value = agentTypeId
    showNewDialog.value = false
  } catch (error: any) {
    console.error('Failed to create subagent:', error)
    // 检查是否是名称重复错误
    if (error?.message?.includes('SUBAGENT_NAME_EXISTS') || error?.code === 'SUBAGENT_NAME_EXISTS') {
      createError.value = t('components.settings.subagents.createDialog.nameDuplicate')
    } else {
      createError.value = error?.message || String(error)
    }
  } finally {
    isCreating.value = false
  }
}

// 开始重命名
function startRename() {
  if (!currentAgent.value) return
  editingName.value = currentAgent.value.name
  renameError.value = ''
  isEditing.value = true
}

// 保存重命名
async function saveRename() {
  const trimmedName = editingName.value.trim()

  if (!trimmedName) {
    isEditing.value = false
    return
  }

  // 检查名称是否重复（排除当前代理）
  const nameExists = subAgents.value.some(
    a => a.type !== currentAgentType.value && a.name.toLowerCase() === trimmedName.toLowerCase()
  )
  if (nameExists) {
    renameError.value = t('components.settings.subagents.createDialog.nameDuplicate')
    return
  }

  const result = await updateAgentField('name', trimmedName)
  if (result.ok) {
    isEditing.value = false
    renameError.value = ''
    return
  }

  const error = result.error as { message?: string; code?: string } | undefined
  if (error?.message?.includes('SUBAGENT_NAME_EXISTS') || error?.code === 'SUBAGENT_NAME_EXISTS') {
    renameError.value = t('components.settings.subagents.createDialog.nameDuplicate')
  } else {
    renameError.value = errorText(error)
  }
  // 重命名失败已就地提示，不重复占用顶部横幅
  saveError.value = ''
}

// 取消重命名
function cancelRename() {
  isEditing.value = false
  editingName.value = ''
  renameError.value = ''
}

// 删除子代理
async function deleteAgent() {
  if (!deleteAgentType.value) return

  try {
    await sendToExtension(MESSAGE_NAMES['subagents.delete'], { type: deleteAgentType.value })

    // 从列表中移除
    subAgents.value = subAgents.value.filter(a => a.type !== deleteAgentType.value)

    // 如果删除的是当前选中的，选择第一个
    if (currentAgentType.value === deleteAgentType.value) {
      currentAgentType.value = subAgents.value[0]?.type || ''
    }
    saveError.value = ''
  } catch (error) {
    console.error('Failed to delete subagent:', error)
    saveError.value = errorText(error)
  } finally {
    showDeleteConfirm.value = false
    deleteAgentType.value = ''
  }
}

// 初始化
onMounted(async () => {
  await loadPresets()
  await Promise.all([
    loadSubAgents(),
    loadChannels(),
    loadTools()
  ])
})
</script>

<template>
  <div class="subagents-settings">
    <!-- 加载中 -->
    <div v-if="isLoading" class="loading-state">
      <i class="codicon codicon-loading codicon-modifier-spin"></i>
      <span>{{ t('common.loading') }}</span>
    </div>

    <!-- 主内容 -->
    <div v-else class="settings-content">
      <!-- 保存失败提示：配置写入被后端拒绝时不再静默 -->
      <div v-if="saveError" class="save-error-banner">
        <i class="codicon codicon-error"></i>
        <span>{{ t('components.settings.subagents.saveFailed', { error: saveError }) }}</span>
        <button class="dismiss-btn" @click="saveError = ''" :title="t('common.close')">
          <i class="codicon codicon-close"></i>
        </button>
      </div>

      <!-- 全局配置 -->
      <SubAgentGlobalConfigSection
        :max-concurrent-agents="maxConcurrentAgents"
        :default-max-iterations="defaultMaxIterations"
        :queue-timeout-seconds="queueTimeoutSeconds"
        :default-max-runtime-seconds="defaultMaxRuntimeSeconds"
        :global-number-error="globalNumberError"
        :general-worker-enabled="generalWorkerEnabled"
        :on-global-number-change="handleGlobalNumberChange"
        :on-queue-timeout="handleQueueTimeout"
        :on-general-worker-toggle="handleGeneralWorkerToggle"
      />

      <!-- 子代理选择器 -->
      <div class="agent-selector" data-search-anchor="subagents-selector">
        <CustomSelect
          v-if="agentOptions.length > 0"
          :modelValue="currentAgentType"
          :options="agentOptions"
          :placeholder="t('components.settings.subagents.selectAgent')"
          @update:modelValue="selectAgent"
        />
        <div v-else class="no-agents">
          <span>{{ t('components.settings.subagents.noAgents') }}</span>
        </div>

        <!-- 操作按钮 -->
        <div class="agent-actions">
          <button class="action-btn" @click="openCreateDialog" :title="t('components.settings.subagents.create')">
            <i class="codicon codicon-add"></i>
          </button>
          <button
            v-if="currentAgent"
            class="action-btn"
            @click="startRename"
            :title="t('components.settings.subagents.rename')"
          >
            <i class="codicon codicon-edit"></i>
          </button>
          <button
            v-if="currentAgent"
            class="action-btn danger"
            @click="showDeleteConfirm = true; deleteAgentType = currentAgentType"
            :title="t('components.settings.subagents.delete')"
          >
            <i class="codicon codicon-trash"></i>
          </button>
        </div>
      </div>

      <!-- 代理配置表单 -->
      <div v-if="currentAgent" class="agent-config">
        <!-- 基本信息 -->
        <SubAgentBasicInfoSection
          :agent="currentAgent"
          :on-update-field="handleBasicFieldUpdate"
        />

        <!-- 系统提示词 -->
        <div class="config-section" data-search-anchor="subagents-system-prompt">
          <h5>{{ t('components.settings.subagents.systemPrompt') }}</h5>
          <textarea
            class="system-prompt-textarea"
            :value="currentAgent.systemPrompt"
            @change="updateAgentField('systemPrompt', ($event.target as HTMLTextAreaElement).value)"
            :placeholder="t('components.settings.subagents.systemPromptPlaceholder')"
            rows="6"
          ></textarea>
        </div>

        <!-- 渠道和模型 -->
        <SubAgentChannelModelSection
          :agent="currentAgent"
          :syncs-with-current="currentAgentSyncsWithCurrent"
          :selected-channel="selectedChannel"
          :channel-options="channelOptions"
          :model-options="modelOptions"
          :on-toggle-sync="toggleSyncWithCurrentModel"
          :on-select-channel="handleSelectChannel"
          :on-select-model="handleSelectModel"
        />

        <!-- 工具配置 -->
        <SubAgentToolsSection
          :agent="currentAgent"
          :tool-mode-options="toolModeOptions"
          :tools-by-category="toolsByCategory"
          :all-tools="allTools"
          :is-tool-selected="isToolSelected"
          :on-update-tools="handleUpdateTools"
          :on-toggle-tool="toggleTool"
        />
      </div>

      <!-- 空状态 -->
      <div v-else-if="!isLoading && subAgents.length === 0" class="empty-state">
        <i class="codicon codicon-hubot"></i>
        <p>{{ t('components.settings.subagents.emptyState') }}</p>
        <button class="primary-btn" @click="openCreateDialog">
          <i class="codicon codicon-add"></i>
          {{ t('components.settings.subagents.createFirst') }}
        </button>
      </div>
    </div>

    <!-- 新建对话框 -->
    <CreateSubAgentDialog
      v-if="showNewDialog"
      v-model:new-agent-name="newAgentName"
      v-model:new-agent-channel-id="newAgentChannelId"
      :selected-preset-id="selectedPresetId"
      :presets="presets"
      :channel-options="channelOptions"
      :create-error="createError"
      :is-creating="isCreating"
      :preset-name="presetName"
      :preset-description="presetDescription"
      :on-select-preset="selectPreset"
      :on-close="closeCreateDialog"
      :on-create="createAgent"
    />

    <!-- 重命名对话框 -->
    <RenameSubAgentDialog
      v-if="isEditing"
      v-model:editing-name="editingName"
      :rename-error="renameError"
      :on-cancel="cancelRename"
      :on-save="saveRename"
    />

    <!-- 确认删除对话框 -->
    <ConfirmDialog
      v-model="showDeleteConfirm"
      :title="t('components.settings.subagents.deleteConfirm.title')"
      :message="t('components.settings.subagents.deleteConfirm.message')"
      :confirmText="t('common.delete')"
      :cancelText="t('common.cancel')"
      :isDanger="true"
      @confirm="deleteAgent"
    />
  </div>
</template>

<style scoped>
.subagents-settings {
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

.settings-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 保存失败横幅 */
.save-error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  border-radius: 4px;
  color: var(--vscode-errorForeground);
  font-size: 12px;
  word-break: break-word;
}

.save-error-banner span {
  flex: 1;
  min-width: 0;
}

.save-error-banner .dismiss-btn {
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
  opacity: 0.75;
}

.save-error-banner .dismiss-btn:hover {
  opacity: 1;
}

/* 子代理选择器 */
.agent-selector {
  display: flex;
  gap: 8px;
  align-items: center;
}

.agent-selector :deep(.custom-select) {
  flex: 1;
}

.no-agents {
  flex: 1;
  padding: 8px 12px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  color: var(--vscode-descriptionForeground);
}

.agent-actions {
  display: flex;
  gap: 4px;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
  transition: background 0.15s;
}

.action-btn:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.action-btn.danger:hover {
  background: var(--vscode-errorForeground);
  color: var(--vscode-editor-background);
}

/* 配置区块 */
.agent-config {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.config-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.config-section h5 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
}

/* 系统提示词编辑框 */
.system-prompt-textarea {
  width: 100%;
  min-height: 120px;
  padding: 12px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
  border-radius: 6px;
  color: var(--vscode-input-foreground);
  font-size: 13px;
  font-family: var(--vscode-editor-font-family), monospace;
  line-height: 1.5;
  resize: vertical;
  box-sizing: border-box;
}

.system-prompt-textarea::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.system-prompt-textarea:focus {
  outline: none;
  border-color: var(--vscode-focusBorder);
  box-shadow: 0 0 0 1px var(--vscode-focusBorder);
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 24px;
  text-align: center;
}

.empty-state i {
  font-size: 48px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.5;
}

.empty-state p {
  margin: 0;
  color: var(--vscode-descriptionForeground);
}

.primary-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.primary-btn:hover {
  background: var(--vscode-button-hoverBackground);
}

/* Loading 动画 */
.codicon-modifier-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
