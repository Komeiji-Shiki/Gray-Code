import { computed, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from '@/composables'
import { useChatStore } from '@/stores'
import type { ChannelConfig } from '@/types'
import type { ChannelOption, ModelInfo } from '../../input/types'
import * as configService from '@/services/config'
import { onExtensionCommand } from '@/utils/vscode'
import { generateId } from '@/utils/format'

/** 计划执行拥有独立的渠道、模型和订阅生命周期，普通写入结果无需承担这些状态。 */
export function useWriteFilePlans() {
  const { t } = useI18n()
  const chatStore = useChatStore()
  let disposed = false
  let channelsSequence = 0
  let modelsSequence = 0
  // ============ Plan 执行相关 ============
  const channelConfigs = ref<ChannelConfig[]>([])
  const selectedChannelId = ref('')
  const selectedModelId = ref('')
  const modelOptions = ref<ModelInfo[]>([])
  const isLoadingChannels = ref(false)
  const isLoadingModels = ref(false)
  const expandedPlanFiles = ref<Set<string>>(new Set())
  const isExecutingPlan = ref(false)
  let unsubscribeConfigChanged: (() => void) | null = null

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

  async function loadChannels() {
    if (disposed) return
    const sequence = ++channelsSequence
    isLoadingChannels.value = true
    try {
      const ids = await configService.listConfigIds()
      if (disposed || sequence !== channelsSequence) return
      const loaded: ChannelConfig[] = []
      for (const id of ids) {
        const config = await configService.getConfig(id)
        if (disposed || sequence !== channelsSequence) return
        if (config) loaded.push(config)
      }
      channelConfigs.value = loaded
      // 默认选择当前渠道
      if (chatStore.configId && !selectedChannelId.value) {
        selectedChannelId.value = chatStore.configId
      } else if (loaded.length > 0 && !selectedChannelId.value) {
        selectedChannelId.value = loaded[0].id
      }
    } catch (error) {
      console.error(t('components.message.tool.planCard.loadChannelsFailed'), error)
    } finally {
      if (!disposed && sequence === channelsSequence) isLoadingChannels.value = false
    }
  }

  function getSelectedChannelConfig() {
    return channelConfigs.value.find(c => c.id === selectedChannelId.value)
  }

  async function loadModelsForChannel(configId: string) {
    if (disposed) return
    const sequence = ++modelsSequence
    if (!configId) {
      isLoadingModels.value = false
      modelOptions.value = []
      selectedModelId.value = ''
      return
    }

    isLoadingModels.value = true
    try {
      const cfg = channelConfigs.value.find(c => c.id === configId)
      const storedModels = cfg?.models
      const localModels = Array.isArray(storedModels) ? storedModels : []
      let models = localModels.length > 0 ? localModels : await configService.getChannelModels(configId)
      if (disposed || sequence !== modelsSequence || selectedChannelId.value !== configId) return

      const current = (cfg?.model || '').trim()
      if (current && !models.some(m => m.id === current)) {
        models = [{ id: current, name: current }, ...models]
      }

      modelOptions.value = models
      if (!selectedModelId.value) {
        selectedModelId.value = current || models[0]?.id || ''
      }
    } catch (error) {
      if (disposed || sequence !== modelsSequence || selectedChannelId.value !== configId) return
      console.error(t('components.message.tool.planCard.loadModelsFailed'), error)
      const current = (getSelectedChannelConfig()?.model || '').trim()
      modelOptions.value = current ? [{ id: current, name: current }] : []
      if (!selectedModelId.value) selectedModelId.value = current
    } finally {
      if (!disposed && sequence === modelsSequence) isLoadingModels.value = false
    }
  }

  function togglePlanExpand(path: string) {
    if (expandedPlanFiles.value.has(path)) {
      expandedPlanFiles.value.delete(path)
    } else {
      expandedPlanFiles.value.add(path)
    }
  }

  function isPlanExpanded(path: string): boolean {
    return expandedPlanFiles.value.has(path)
  }

  function getPlanTitle(planContent: string, planPath?: string): string {
    const m = (planContent || '').match(/^\s*#\s+(.+)\s*$/m)
    if (m && m[1] && m[1].trim()) return m[1].trim()

    if (planPath) {
      const parts = planPath.replace(/\\/g, '/').split('/')
      const file = parts[parts.length - 1] || planPath
      return file.replace(/\.md$/i, '') || t('components.message.tool.planCard.title')
    }

    return t('components.message.tool.planCard.title')
  }

  async function executePlan(planContent: string, planPath?: string) {
    if (isExecutingPlan.value || !planContent.trim()) return
    isExecutingPlan.value = true

    try {
      // 一次性渠道/模型覆盖：仅本次请求生效，不写后端全局设置与对话元数据
      const planChannelId = selectedChannelId.value || undefined
      const planModelId = selectedModelId.value || undefined

      // 启动 Build 顶部卡片（Cursor-like）
      await chatStore.setActiveBuild({
        id: generateId(),
        conversationId: chatStore.currentConversationId || '',
        title: getPlanTitle(planContent, planPath),
        planContent,
        planPath,
        channelId: planChannelId,
        modelId: planModelId,
        startedAt: Date.now(),
        status: 'running'
      })

      // 发送 Plan 内容作为新消息
      const prompt = t('components.message.tool.planCard.promptPrefix', { plan: planContent })
      await chatStore.sendMessage(prompt, undefined, {
        configIdOverride: planChannelId,
        modelOverride: planModelId
      })
    } catch (error) {
      console.error(t('components.message.tool.planCard.executePlanFailed'), error)
    } finally {
      isExecutingPlan.value = false
    }
  }

  onMounted(() => {
    loadChannels()
    // 设置面板中渠道/模型变更后刷新（新增模型无需重启扩展即可在下拉框看到）
    unsubscribeConfigChanged = onExtensionCommand('channels.configChanged', () => {
      loadChannels()
    })
  })

  watch(
    () => selectedChannelId.value,
    async (id) => {
      const cfg = channelConfigs.value.find(c => c.id === id)
      selectedModelId.value = (cfg?.model || '').trim()
      await loadModelsForChannel(id)
    }
  )


  onBeforeUnmount(() => { disposed = true; channelsSequence++; modelsSequence++; unsubscribeConfigChanged?.() })
  return { channelOptions, selectedChannelId, selectedModelId, modelOptions, isLoadingChannels, isLoadingModels, isExecutingPlan, togglePlanExpand, isPlanExpanded, getPlanTitle, executePlan }
}
