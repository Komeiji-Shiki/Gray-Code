/**
 * MessageTaskCards 拆分：渠道 / 模式 / 模型选择的加载与持久化编排。
 *
 * 原实现内联在主组件里，此处按「渠道配置加载 + 提示词模式选择」边界整体搬出。
 * 函数体与原组件逐字一致，保证渠道配置加载（并行拉取、单条失败容忍）、
 * 模式偏好持久化与模型默认选中逻辑的运行时行为不变。
 */
import { computed, ref, watch } from 'vue'
import { useChatStore, useSettingsStore } from '@/stores'
import { loadState, saveState } from '@/utils/vscode'
import { t } from '@/i18n'
import * as configService from '@/services/config'
import type { ChannelConfig } from '@/types'
import type { PromptMode, ChannelOption, ModelInfo } from '@/components/input/types'
import type { TaskCardKind } from '@/components/message/messageTaskCards/taskCardTypes'

export const PLAN_EXECUTION_MODE_STATE_KEY = 'planExecution.preferredModeId'
export const PLAN_GENERATION_MODE_STATE_KEY = 'planGeneration.preferredModeId'

export function useTaskCardChannels() {
  const chatStore = useChatStore()
  const settingsStore = useSettingsStore()

  // ============ 渠道选择相关 ============
  const channelConfigs = ref<ChannelConfig[]>([])
  const selectedChannelId = ref('')
  const selectedPlanExecutionModeId = ref('code')
  const selectedPlanGenerationModeId = ref('plan')
  const selectedModelId = ref('')
  const modelOptions = ref<ModelInfo[]>([])
  const isLoadingChannels = ref(false)
  const isLoadingModes = ref(false)
  const promptModeOptions = ref<PromptMode[]>([])
  const isLoadingModels = ref(false)

  const channelOptions = computed<ChannelOption[]>(() =>
    channelConfigs.value
      .filter(config => config.enabled !== false)
      .map(config => ({
        id: config.id,
        name: config.name,
        model: config.model || config.id,
        type: config.type
      }))
  )

  function openModeSettings() {
    settingsStore.showSettings('prompt')
  }

  function resolvePreferredModeId(
    modes: PromptMode[],
    storageKey: string,
    fallbackModeId: string,
    currentModeId?: string
  ): string {
    const persisted = String(loadState<string>(storageKey, '') || '').trim()
    if (persisted && modes.some(mode => mode.id === persisted)) return persisted

    if (fallbackModeId && modes.some(mode => mode.id === fallbackModeId)) return fallbackModeId

    const current = String(currentModeId || '').trim()
    if (current && modes.some(mode => mode.id === current)) return current

    return modes[0]?.id || fallbackModeId || 'code'
  }

  function getModeIdForKind(kind: TaskCardKind): string {
    return kind === 'plan'
      ? selectedPlanExecutionModeId.value
      : selectedPlanGenerationModeId.value
  }

  function handleModeChange(kind: TaskCardKind, modeId: string) {
    const normalized = String(modeId || '').trim()
    if (!normalized) return

    if (kind === 'plan') {
      selectedPlanExecutionModeId.value = normalized
      saveState(PLAN_EXECUTION_MODE_STATE_KEY, normalized)
      return
    }

    selectedPlanGenerationModeId.value = normalized
    saveState(PLAN_GENERATION_MODE_STATE_KEY, normalized)
  }

  async function loadPromptModes() {
    isLoadingModes.value = true
    try {
      const result = await configService.getPromptModes()
      const modes = Array.isArray(result?.modes) ? result.modes : []
      promptModeOptions.value = modes

      const preferredExecutionModeId = resolvePreferredModeId(
        modes,
        PLAN_EXECUTION_MODE_STATE_KEY,
        'code',
        result?.currentModeId
      )
      const preferredGenerationModeId = resolvePreferredModeId(
        modes,
        PLAN_GENERATION_MODE_STATE_KEY,
        'plan',
        result?.currentModeId
      )

      selectedPlanExecutionModeId.value = preferredExecutionModeId
      selectedPlanGenerationModeId.value = preferredGenerationModeId
      saveState(PLAN_EXECUTION_MODE_STATE_KEY, preferredExecutionModeId)
      saveState(PLAN_GENERATION_MODE_STATE_KEY, preferredGenerationModeId)
    } catch (error) {
      console.error('[task-cards] Failed to load prompt modes:', error)
      selectedPlanExecutionModeId.value = 'code'
      selectedPlanGenerationModeId.value = 'plan'
    } finally {
      isLoadingModes.value = false
    }
  }

  async function loadChannels() {
    isLoadingChannels.value = true
    try {
      const ids = await configService.listConfigIds()

      // 并行拉取全部渠道配置（原为串行 N 次 IPC）；单条失败仅跳过该条，不拖垮整批
      const results = await Promise.all(ids.map(async (id) => {
        try {
          return await configService.getConfig(id)
        } catch (error) {
          console.warn(`[task-cards] Failed to load config ${id}:`, error)
          return null
        }
      }))
      const loaded = results.filter((c): c is ChannelConfig => !!c)

      channelConfigs.value = loaded
      if (chatStore.configId && !selectedChannelId.value) {
        selectedChannelId.value = chatStore.configId
      } else if (loaded.length > 0 && !selectedChannelId.value) {
        selectedChannelId.value = loaded[0].id
      }
    } catch (error) {
      console.error(t('components.message.tool.planCard.loadChannelsFailed'), error)
    } finally {
      isLoadingChannels.value = false
    }
  }

  function getSelectedChannelConfig() {
    return channelConfigs.value.find(c => c.id === selectedChannelId.value)
  }

  async function loadModelsForChannel(configId: string) {
    if (!configId) {
      modelOptions.value = []
      selectedModelId.value = ''
      return
    }

    isLoadingModels.value = true
    try {
      const cfg = channelConfigs.value.find(c => c.id === configId)

      // 1) 优先使用本地配置里已保存的 models（来自“模型管理”）
      const storedModels = cfg?.models
      const localModels = Array.isArray(storedModels) ? storedModels : []
      let models = localModels.length > 0 ? localModels : await configService.getChannelModels(configId)

      // 2) 确保当前配置的 model 一定能显示/被选中
      const current = (cfg?.model || '').trim()
      if (current && !models.some(m => m.id === current)) {
        models = [{ id: current, name: current }, ...models]
      }

      modelOptions.value = models

      // 3) 默认选中：当前 config.model -> 第一项
      if (!selectedModelId.value) {
        selectedModelId.value = current || models[0]?.id || ''
      }
    } catch (error) {
      console.error(t('components.message.tool.planCard.loadModelsFailed'), error)
      const current = (getSelectedChannelConfig()?.model || '').trim()
      modelOptions.value = current ? [{ id: current, name: current }] : []
      if (!selectedModelId.value) selectedModelId.value = current
    } finally {
      isLoadingModels.value = false
    }
  }

  watch(
    () => selectedChannelId.value,
    async (id) => {
      const cfg = channelConfigs.value.find(c => c.id === id)
      selectedModelId.value = (cfg?.model || '').trim()
      await loadModelsForChannel(id)
    }
  )

  return {
    channelConfigs,
    selectedChannelId,
    selectedPlanExecutionModeId,
    selectedPlanGenerationModeId,
    selectedModelId,
    modelOptions,
    isLoadingChannels,
    isLoadingModes,
    promptModeOptions,
    isLoadingModels,
    channelOptions,
    openModeSettings,
    resolvePreferredModeId,
    getModeIdForKind,
    handleModeChange,
    loadPromptModes,
    loadChannels,
    getSelectedChannelConfig,
    loadModelsForChannel
  }
}
