/**
 * useCheckpointConfig - 存档点设置：配置加载/保存 + 消息/工具开关
 *
 * 从 CheckpointSettings.vue 拆分（S2 批次），纯重构不改行为：
 * - 管理整包配置 `config`（reactive）与保存链路（H-1 串行队列 + 失败回滚）
 * - loadConfig（checkpoint.getConfig）/ loadTools（tools.getTools）
 * - 消息类型存档点开关、工具 before/after 开关（单选/全选）
 * - 工具显示名/描述 i18n 辅助（独立导出，供清理模块复用）
 */

import { ref, reactive, computed } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { useChatStore } from '@/stores'
import { t } from '@/i18n'

// 消息类型存档点配置
export interface MessageCheckpointConfig {
  beforeMessages: string[]
  afterMessages: string[]
  modelOuterLayerOnly?: boolean
  mergeUnchangedCheckpoints?: boolean
}

// 排除配置（EX-08）
export interface CheckpointExclusionConfig {
  enabledProfiles: Record<string, boolean>
  /** 每类别自定义模式覆盖（profileId -> 模式清单；缺省/空数组 = 使用该类别的默认清单） */
  profilePatterns?: Record<string, string[]>
  maxFileSizeBytes: number
  customPatterns: string[]
}

// 存档点配置接口
export interface CheckpointConfig {
  enabled: boolean
  beforeTools: string[]
  afterTools: string[]
  messageCheckpoint?: MessageCheckpointConfig
  maxCheckpoints: number
  customIgnorePatterns?: string[]
  exclusion?: CheckpointExclusionConfig
}

// 工具信息接口
export interface ToolInfo {
  name: string
  description: string
  category?: string
}

// updateConfigField 函数签名（供其他 composable 复用）
export type UpdateCheckpointConfigField = (
  field: keyof CheckpointConfig,
  value: any
) => Promise<boolean>

// 获取工具显示名称（优先 i18n，fallback 机械转换）
export function getToolDisplayName(name: string): string {
  const i18nKey = `components.settings.toolsSettings.toolDisplayNames.${name}`
  const translated = t(i18nKey)
  if (translated !== i18nKey) return translated
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// 获取工具描述（优先 i18n，fallback 原文）
export function getToolDescription(name: string, fallback: string): string {
  const i18nKey = `components.settings.toolsSettings.toolDescriptions.${name}`
  const translated = t(i18nKey)
  if (translated !== i18nKey) return translated
  return fallback
}

export function useCheckpointConfig() {
  const chatStore = useChatStore()

  // 消息类型列表
  const messageTypes = computed(() => [
    {
      name: 'user',
      displayName: t('components.settings.checkpoint.sections.messages.types.user.name'),
      description: t('components.settings.checkpoint.sections.messages.types.user.description')
    },
    {
      name: 'model',
      displayName: t('components.settings.checkpoint.sections.messages.types.model.name'),
      description: t('components.settings.checkpoint.sections.messages.types.model.description')
    }
  ])

  // 配置
  const config = reactive<CheckpointConfig>({
    enabled: true,
    beforeTools: [],
    afterTools: [],
    messageCheckpoint: {
      beforeMessages: [],
      afterMessages: [],
      modelOuterLayerOnly: true,
      mergeUnchangedCheckpoints: true
    },
    maxCheckpoints: -1,  // -1 表示无上限
    customIgnorePatterns: [],
    exclusion: {
      enabledProfiles: {},
      maxFileSizeBytes: 50 * 1024 * 1024,  // 默认 50 MiB
      customPatterns: []
    }
  })

  // 配置保存错误（如 EX-12 校验拒绝）
  const configSaveError = ref<string | null>(null)

  // 所有可用的工具列表
  const allTools = ref<ToolInfo[]>([])

  // 加载状态
  const isLoading = ref(false)
  // H-2: 配置加载失败状态（失败时禁用表单，避免默认值覆盖真实配置）
  const loadError = ref<string | null>(null)

  // H-1: 配置保存串行化队列（后发覆盖先发）；任一保存失败不阻断队列
  let configSaveChain: Promise<unknown> = Promise.resolve()
  // H-1: 最近一次成功保存（或成功加载）的整包配置快照，保存失败时用于回滚对应字段
  let lastSavedConfig: CheckpointConfig | null = null

  function cloneConfigSnapshot(): CheckpointConfig {
    return JSON.parse(JSON.stringify(config))
  }

  function configFieldEquals(a: any, b: any): boolean {
    if (a === b) return true
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }

  // 构建整包配置（纯 JSON，避免 DataCloneError）
  function buildConfigToSave(): any {
    const messageCheckpointToSave = config.messageCheckpoint ? {
      beforeMessages: [...(config.messageCheckpoint.beforeMessages || [])],
      afterMessages: [...(config.messageCheckpoint.afterMessages || [])],
      modelOuterLayerOnly: config.messageCheckpoint.modelOuterLayerOnly,
      mergeUnchangedCheckpoints: config.messageCheckpoint.mergeUnchangedCheckpoints
    } : {
      beforeMessages: [],
      afterMessages: [],
      modelOuterLayerOnly: true,
      mergeUnchangedCheckpoints: true
    }

    return {
      enabled: config.enabled,
      beforeTools: [...config.beforeTools],
      afterTools: [...config.afterTools],
      messageCheckpoint: messageCheckpointToSave,
      maxCheckpoints: config.maxCheckpoints,
      customIgnorePatterns: config.customIgnorePatterns ? [...config.customIgnorePatterns] : [],
      exclusion: config.exclusion ? {
        enabledProfiles: { ...(config.exclusion.enabledProfiles || {}) },
        profilePatterns: config.exclusion.profilePatterns
          ? Object.fromEntries(
              Object.entries(config.exclusion.profilePatterns).map(([k, v]) => [k, [...v]])
            )
          : undefined,
        maxFileSizeBytes: config.exclusion.maxFileSizeBytes,
        customPatterns: [...(config.exclusion.customPatterns || [])]
      } : undefined
    }
  }

  // 更新配置字段并保存；返回是否保存成功（H-1：失败时回滚该字段）
  async function updateConfigField(field: keyof CheckpointConfig, value: any): Promise<boolean> {
    // 乐观更新本地配置（注意：多数调用方在调用前已先改本地 config，
    // 因此回滚基准是“最近一次成功保存/加载的权威快照”，而非函数内快照）
    ;(config as any)[field] = value

    const run = async (): Promise<boolean> => {
      try {
        // 在发送时构建整包配置（含所有已提交的乐观更新），避免串行队列中发送过期快照
        const result = await sendToExtension<{ config?: CheckpointConfig | null }>('checkpoint.updateConfig', {
          config: buildConfigToSave()
        })
        configSaveError.value = null
        // R3-#9: 采纳后端归一化返回值（后端会合并默认启用类别、把非法值归零等），
        // 避免本地 UI 与后端权威值长期脱节；后端未返回 config（含 null/空）时保留乐观值
        if (result?.config && typeof result.config === 'object') {
          Object.assign(config, result.config)
          // 防御：旧后端/旧配置可能没有 exclusion 字段
          if (!config.exclusion) {
            config.exclusion = { enabledProfiles: {}, maxFileSizeBytes: 50 * 1024 * 1024, customPatterns: [] }
          }
        }
        lastSavedConfig = cloneConfigSnapshot()
        return true
      } catch (error: any) {
        configSaveError.value = error?.message || String(error || 'Unknown error')
        console.error('Failed to save checkpoint config:', error)
        // 回滚：仅当该字段仍等于本次尝试保存的值（未被更新的编辑覆盖）时，
        // 用最后一次成功保存/加载的权威值覆盖，避免失败改动被后续整包保存顺带持久化
        if (lastSavedConfig !== null && configFieldEquals((config as any)[field], value)) {
          ;(config as any)[field] = (lastSavedConfig as any)[field]
        }
        return false
      }
    }

    // 串行化：后发保存覆盖先发；任一保存失败不阻断队列
    const result = configSaveChain.then(run, run)
    configSaveChain = result.catch(() => undefined)
    return result
  }

  // 加载存档点配置（H-2: 失败时展示错误横幅并禁用表单，直到重试成功）
  async function loadConfig() {
    // R3-#11: 防重入——已有加载进行中时直接返回，避免并发请求相互覆盖
    if (isLoading.value) return
    isLoading.value = true
    loadError.value = null

    // H-2: getConfig 失败时展示错误横幅并禁用表单（不把默认值暴露为可编辑配置），直到重试成功
    try {
      // 加载存档点配置
      const response = await sendToExtension<{ config: CheckpointConfig }>('checkpoint.getConfig', {})
      if (response?.config) {
        Object.assign(config, response.config)
        // 防御：旧后端/旧配置可能没有 exclusion 字段
        if (!config.exclusion) {
          config.exclusion = { enabledProfiles: {}, maxFileSizeBytes: 50 * 1024 * 1024, customPatterns: [] }
        }
        // H-1: 加载成功即视为权威基准，保存失败时据此回滚
        lastSavedConfig = cloneConfigSnapshot()
      } else {
        throw new Error('No checkpoint config returned')
      }
      loadError.value = null
    } catch (error: any) {
      console.error('Failed to load checkpoint config:', error)
      loadError.value = error?.message || String(error || 'Unknown error')
    } finally {
      isLoading.value = false
    }
  }

  // 加载工具列表（失败不阻断配置编辑，仅告警）
  async function loadTools() {
    try {
      // 加载工具列表
      const toolsResponse = await sendToExtension<{ tools: ToolInfo[] }>('tools.getTools', {})
      if (toolsResponse?.tools) {
        allTools.value = toolsResponse.tools
      }
    } catch (error) {
      console.warn('Failed to load tools:', error)
    }
  }

  // 直接使用所有工具（用户可以自由选择哪些需要备份）
  const displayTools = computed(() => allTools.value)

  // 检查消息类型是否在 before 列表中
  function isMessageInBefore(messageType: string): boolean {
    return config.messageCheckpoint?.beforeMessages?.includes(messageType) ?? false
  }

  // 检查消息类型是否在 after 列表中
  function isMessageInAfter(messageType: string): boolean {
    return config.messageCheckpoint?.afterMessages?.includes(messageType) ?? false
  }

  // 切换消息类型的 before 状态
  async function toggleMessageBefore(messageType: string, enabled: boolean) {
    if (!config.messageCheckpoint) {
      config.messageCheckpoint = { beforeMessages: [], afterMessages: [] }
    }
    const newBeforeMessages = [...(config.messageCheckpoint.beforeMessages || [])]
    if (enabled) {
      if (!newBeforeMessages.includes(messageType)) {
        newBeforeMessages.push(messageType)
      }
    } else {
      const index = newBeforeMessages.indexOf(messageType)
      if (index !== -1) {
        newBeforeMessages.splice(index, 1)
      }
    }
    config.messageCheckpoint.beforeMessages = newBeforeMessages
    await updateConfigField('messageCheckpoint', { ...config.messageCheckpoint })
  }

  // 切换消息类型的 after 状态
  async function toggleMessageAfter(messageType: string, enabled: boolean) {
    if (!config.messageCheckpoint) {
      config.messageCheckpoint = { beforeMessages: [], afterMessages: [], modelOuterLayerOnly: true }
    }
    const newAfterMessages = [...(config.messageCheckpoint.afterMessages || [])]
    if (enabled) {
      if (!newAfterMessages.includes(messageType)) {
        newAfterMessages.push(messageType)
      }
    } else {
      const index = newAfterMessages.indexOf(messageType)
      if (index !== -1) {
        newAfterMessages.splice(index, 1)
      }
    }
    config.messageCheckpoint.afterMessages = newAfterMessages
    await updateConfigField('messageCheckpoint', { ...config.messageCheckpoint })
  }

  // 切换模型消息只在最外层创建存档点
  async function toggleModelOuterLayerOnly(enabled: boolean) {
    if (!config.messageCheckpoint) {
      config.messageCheckpoint = { beforeMessages: [], afterMessages: [], modelOuterLayerOnly: enabled }
    } else {
      config.messageCheckpoint.modelOuterLayerOnly = enabled
    }
    await updateConfigField('messageCheckpoint', { ...config.messageCheckpoint })
  }

  // 切换是否合并无变更的存档点
  async function toggleMergeUnchangedCheckpoints(enabled: boolean) {
    if (!config.messageCheckpoint) {
      config.messageCheckpoint = { beforeMessages: [], afterMessages: [], mergeUnchangedCheckpoints: enabled }
    } else {
      config.messageCheckpoint.mergeUnchangedCheckpoints = enabled
    }
    // M-7: 仅保存成功时才同步 chatStore，避免设置页失败而聊天视图已切换的不一致
    const saved = await updateConfigField('messageCheckpoint', { ...config.messageCheckpoint })
    if (saved) {
      // 同步更新 chatStore，实现实时响应
      chatStore.setMergeUnchangedCheckpoints(enabled)
    }
  }

  // 检查是否启用了模型消息存档点
  const hasModelMessageCheckpoint = computed(() => {
    const mc = config.messageCheckpoint
    return mc?.beforeMessages?.includes('model') || mc?.afterMessages?.includes('model')
  })

  // 全选/取消消息 before
  async function toggleAllMessageBefore(enabled: boolean) {
    if (!config.messageCheckpoint) {
      config.messageCheckpoint = { beforeMessages: [], afterMessages: [] }
    }
    config.messageCheckpoint.beforeMessages = enabled ? messageTypes.value.map(m => m.name) : []
    await updateConfigField('messageCheckpoint', { ...config.messageCheckpoint })
  }

  // 全选/取消消息 after
  async function toggleAllMessageAfter(enabled: boolean) {
    if (!config.messageCheckpoint) {
      config.messageCheckpoint = { beforeMessages: [], afterMessages: [] }
    }
    config.messageCheckpoint.afterMessages = enabled ? messageTypes.value.map(m => m.name) : []
    await updateConfigField('messageCheckpoint', { ...config.messageCheckpoint })
  }

  // 检查消息类型是否全选
  const isAllMessageBeforeSelected = computed(() => {
    return messageTypes.value.every(m => config.messageCheckpoint?.beforeMessages?.includes(m.name))
  })

  const isAllMessageAfterSelected = computed(() => {
    return messageTypes.value.every(m => config.messageCheckpoint?.afterMessages?.includes(m.name))
  })

  // 检查工具是否在 before 列表中
  function isToolInBefore(toolName: string): boolean {
    return config.beforeTools.includes(toolName)
  }

  // 检查工具是否在 after 列表中
  function isToolInAfter(toolName: string): boolean {
    return config.afterTools.includes(toolName)
  }

  // 切换工具的 before 状态并保存
  async function toggleToolBefore(toolName: string, enabled: boolean) {
    const newBeforeTools = [...config.beforeTools]
    if (enabled) {
      if (!newBeforeTools.includes(toolName)) {
        newBeforeTools.push(toolName)
      }
    } else {
      const index = newBeforeTools.indexOf(toolName)
      if (index !== -1) {
        newBeforeTools.splice(index, 1)
      }
    }
    await updateConfigField('beforeTools', newBeforeTools)
  }

  // 切换工具的 after 状态并保存
  async function toggleToolAfter(toolName: string, enabled: boolean) {
    const newAfterTools = [...config.afterTools]
    if (enabled) {
      if (!newAfterTools.includes(toolName)) {
        newAfterTools.push(toolName)
      }
    } else {
      const index = newAfterTools.indexOf(toolName)
      if (index !== -1) {
        newAfterTools.splice(index, 1)
      }
    }
    await updateConfigField('afterTools', newAfterTools)
  }

  // 全选/取消 before 并保存
  async function toggleAllBefore(enabled: boolean) {
    const newBeforeTools = enabled ? displayTools.value.map(t => t.name) : []
    await updateConfigField('beforeTools', newBeforeTools)
  }

  // 全选/取消 after 并保存
  async function toggleAllAfter(enabled: boolean) {
    const newAfterTools = enabled ? displayTools.value.map(t => t.name) : []
    await updateConfigField('afterTools', newAfterTools)
  }

  // 检查是否全选
  const isAllBeforeSelected = computed(() => {
    return displayTools.value.length > 0 && displayTools.value.every(t => config.beforeTools.includes(t.name))
  })

  const isAllAfterSelected = computed(() => {
    return displayTools.value.length > 0 && displayTools.value.every(t => config.afterTools.includes(t.name))
  })

  return {
    config,
    configSaveError,
    isLoading,
    loadError,
    allTools,
    loadConfig,
    loadTools,
    updateConfigField,
    messageTypes,
    displayTools,
    isMessageInBefore,
    isMessageInAfter,
    toggleMessageBefore,
    toggleMessageAfter,
    toggleModelOuterLayerOnly,
    toggleMergeUnchangedCheckpoints,
    hasModelMessageCheckpoint,
    toggleAllMessageBefore,
    toggleAllMessageAfter,
    isAllMessageBeforeSelected,
    isAllMessageAfterSelected,
    isToolInBefore,
    isToolInAfter,
    toggleToolBefore,
    toggleToolAfter,
    toggleAllBefore,
    toggleAllAfter,
    isAllBeforeSelected,
    isAllAfterSelected
  }
}
