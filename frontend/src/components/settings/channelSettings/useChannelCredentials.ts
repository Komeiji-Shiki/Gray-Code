import { ref, onUnmounted, type Ref } from 'vue'
import type { ChannelConfig } from '@/types'
import { useDeferredSave } from '@/composables/useDeferredSave'
import { useDesktopSettingsDraft } from '@/platform/settingsDraft'
import { sendToExtension } from '@/utils/vscode'
import { MESSAGE_NAMES } from '@shared/protocol'

/** URL/密钥的延迟保存和明文读取共用渠道身份，切换后不回填上一渠道。 */
export function useChannelCredentials(currentConfigId: Ref<string>, currentConfig: Readonly<Ref<ChannelConfig | undefined>>, updateConfigFields: (patch: Partial<ChannelConfig>) => Promise<boolean>) {
  const showApiKey = ref(false)
  const revealedApiKey = ref<string | null>(null)
  const apiKeyRevealError = ref('')
  let apiKeyRevealEpoch = 0


  const { schedule: scheduleApiKeyUrlSave, flush: flushApiKeyUrlSave, cancel: cancelApiKeyUrlSave } = useDeferredSave({ delay: 300, flushOnUnmount: true })

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
    if (field === 'apiKey') {
      // 用户正在编辑时，迟到的已保存密钥不能覆盖输入框中的新值。
      apiKeyRevealEpoch++
      apiKeyRevealError.value = ''
      if (showApiKey.value) revealedApiKey.value = value
    }
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

  async function toggleApiKeyVisibility() {
    if (showApiKey.value) {
      apiKeyRevealEpoch++
      showApiKey.value = false
      revealedApiKey.value = null
      apiKeyRevealError.value = ''
      return
    }
    const config = currentConfig.value
    if (!config) return
    const configId = config.id
    const pendingKey = pendingUrlApiKeyConfigId === configId ? pendingUrlApiKeyPatch?.apiKey : undefined
    apiKeyRevealError.value = ''
    if (pendingKey !== undefined || !window.__GRAYCODE_HOST || config.apiKey !== '••••••••') {
      revealedApiKey.value = pendingKey ?? null
      showApiKey.value = true
      return
    }
    const epoch = ++apiKeyRevealEpoch
    try {
      const result = await sendToExtension<{ apiKey: string }>(MESSAGE_NAMES['config.revealApiKey'], { configId })
      if (epoch !== apiKeyRevealEpoch || currentConfigId.value !== configId) return
      revealedApiKey.value = result.apiKey
      showApiKey.value = true
    } catch (error) {
      if (epoch !== apiKeyRevealEpoch || currentConfigId.value !== configId) return
      apiKeyRevealError.value = '读取已保存的 API Key 失败，请重试。'
      console.error('Failed to reveal channel API key:', error)
    }
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


  function hideApiKey() { apiKeyRevealEpoch++; showApiKey.value = false; revealedApiKey.value = null; apiKeyRevealError.value = '' }
  onUnmounted(hideApiKey)
  useDesktopSettingsDraft(prepareModelFetch, () => !!currentConfigId.value, () => { cancelApiKeyUrlSave(); pendingUrlApiKeyPatch = null })
  return { showApiKey, revealedApiKey, apiKeyRevealError, handleApiKeyUrlInput, toggleApiKeyVisibility, prepareModelFetch, hideApiKey }
}
