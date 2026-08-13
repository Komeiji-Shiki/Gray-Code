import { ref } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { MESSAGE_NAMES } from '@shared/protocol'
import { useI18n } from '@/i18n'

/**
 * SettingsPanel「自动更新」区块的领域逻辑（S7 批次拆分，纯重构，行为零变化）。
 */
export function useUpdateSettings() {
  const { t } = useI18n()

  const checkUpdatesEnabled = ref(true)
  const updateChannel = ref<'stable' | 'nightly'>('stable')
  const isUpdateChecking = ref(false)
  const isUpdating = ref(false)
  const updateCheckResult = ref<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  // 保存自动检查开关
  async function saveCheckUpdates(value: boolean) {
    const previous = checkUpdatesEnabled.value
    checkUpdatesEnabled.value = value
    try {
      const response = await sendToExtension<any>(MESSAGE_NAMES.updateSettings, { settings: { checkForUpdates: value } })
      // SettingsHandler.updateSettings 失败时 resolve { success: false }（不抛错），
      // 必须显式检查并回滚 UI 状态，否则界面显示已切换而实际未保存（对比 saveUpdateChannel）
      if (response?.success === false) {
        checkUpdatesEnabled.value = previous
        console.error('Failed to save update check setting:', response?.error?.message || response?.error)
      }
    } catch (error) {
      checkUpdatesEnabled.value = previous
      console.error('Failed to save update check setting:', error)
    }
  }

  // 保存更新渠道（stable 正式版 / nightly 每日构建）
  async function saveUpdateChannel(value: string) {
    const channel = value === 'nightly' ? 'nightly' : 'stable'
    const previous = updateChannel.value
    updateChannel.value = channel
    try {
      const response = await sendToExtension<any>(MESSAGE_NAMES.updateSettings, { settings: { updateChannel: channel } })
      // SettingsHandler.updateSettings 失败时 resolve { success: false }（不抛错，内部 try/catch 捕获），
      // 必须显式检查并回滚 UI 选择，否则界面显示已切换而实际未保存（静默丢失用户操作）。
      if (response?.success === false) {
        updateChannel.value = previous
        console.error('Failed to save update channel setting:', response?.error?.message || response?.error)
      }
    } catch (error) {
      updateChannel.value = previous
      console.error('Failed to save update channel setting:', error)
    }
  }

  // 立即检查更新（忽略 24h 节流）
  async function checkUpdateNow() {
    if (isUpdateChecking.value) return
    isUpdateChecking.value = true
    updateCheckResult.value = null
    try {
      const response = await sendToExtension<any>(MESSAGE_NAMES.checkUpdateNow, {})
      const status = response?.status
      if (!status) {
        updateCheckResult.value = { type: 'error', text: t('components.settings.settingsPanel.update.error') }
      } else if (status.state === 'updateAvailable') {
        updateCheckResult.value = {
          type: 'success',
          text: t('components.settings.settingsPanel.update.updateAvailable').replace('{version}', status.update?.version || '')
        }
      } else if (status.state === 'upToDate') {
        updateCheckResult.value = { type: 'success', text: t('components.settings.settingsPanel.update.upToDate') }
      } else if (status.state === 'disabled') {
        updateCheckResult.value = { type: 'info', text: t('components.settings.settingsPanel.update.disabledHint') }
      } else if (status.state === 'error') {
        updateCheckResult.value = { type: 'error', text: t('components.settings.settingsPanel.update.error') }
      }
    } catch (error) {
      console.error('Failed to check update:', error)
      updateCheckResult.value = { type: 'error', text: t('components.settings.settingsPanel.update.error') }
    } finally {
      isUpdateChecking.value = false
    }
  }

  // 一键更新：立即检查，有新版本自动下载并安装（安装完成后后端提示重启窗口，用户只需重启）
  async function updateNow() {
    if (isUpdating.value || isUpdateChecking.value) return
    isUpdating.value = true
    updateCheckResult.value = null
    try {
      const response = await sendToExtension<any>(MESSAGE_NAMES.updateNow, {})
      if (response?.alreadyUpToDate) {
        updateCheckResult.value = { type: 'success', text: t('components.settings.settingsPanel.update.upToDate') }
      } else if (response?.version) {
        updateCheckResult.value = {
          type: 'success',
          text: t('components.settings.settingsPanel.update.installedHint').replace('{version}', response.version)
        }
      }
    } catch (error: any) {
      console.error('Failed to update now:', error)
      updateCheckResult.value = { type: 'error', text: error?.message || t('components.settings.settingsPanel.update.error') }
    } finally {
      isUpdating.value = false
    }
  }

  return {
    checkUpdatesEnabled,
    updateChannel,
    isUpdateChecking,
    isUpdating,
    updateCheckResult,
    saveCheckUpdates,
    saveUpdateChannel,
    checkUpdateNow,
    updateNow
  }
}
