import { ref } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { MESSAGE_NAMES } from '@shared/protocol'
import { useI18n } from '@/i18n'
import { useOneShotTimer } from './useOneShotTimer'

/**
 * SettingsPanel「设置导入/导出」区块的领域逻辑（S7 批次拆分，纯重构，行为零变化）。
 */
export function useSettingsImportExport() {
  const { t } = useI18n()

  const isExporting = ref(false)
  const isImporting = ref(false)
  const importExportMessage = ref('')
  const importExportMessageType = ref<'success' | 'error'>('success')
  const importExportMessageTimer = useOneShotTimer()

  async function handleExportSettings() {
    isExporting.value = true
    importExportMessage.value = ''

    try {
      const response = await sendToExtension<any>(MESSAGE_NAMES['settings.export'], {})
      if (response?.success) {
        importExportMessage.value = t('components.settings.settingsPanel.exportImport.exportSuccess', { path: response.filePath })
        importExportMessageType.value = 'success'
      } else if (response?.cancelled) {
        // 用户取消了，不显示消息
      } else {
        importExportMessage.value = t('components.settings.settingsPanel.exportImport.exportFailed')
        importExportMessageType.value = 'error'
      }
    } catch (error: any) {
      importExportMessage.value = error?.message || t('components.settings.settingsPanel.exportImport.exportFailed')
      importExportMessageType.value = 'error'
    } finally {
      isExporting.value = false
      if (importExportMessage.value) {
        importExportMessageTimer.schedule(5000, () => { importExportMessage.value = '' })
      }
    }
  }

  async function handleImportSettings() {
    isImporting.value = true
    importExportMessage.value = ''

    try {
      // 先让用户选择导入方式（弹出确认对话框由扩展端处理）
      // 这里直接调用导入，扩展端会弹出文件选择器和覆盖确认
      const response = await sendToExtension<any>(MESSAGE_NAMES['settings.import'], { overwrite: false })
      if (response?.success) {
        const parts: string[] = []
        if (response.imported?.vscodeSettings) parts.push(t('components.settings.settingsPanel.exportImport.vscodeSettings'))
        if (response.imported?.channelConfigs > 0) parts.push(`${response.imported.channelConfigs} ${t('components.settings.settingsPanel.exportImport.channelConfigs')}`)
        if (response.imported?.mcpServers > 0) parts.push(`${response.imported.mcpServers} ${t('components.settings.settingsPanel.exportImport.mcpServers')}`)
        if (response.imported?.skills > 0) parts.push(`${response.imported.skills} ${t('components.settings.settingsPanel.exportImport.skills')}`)
        importExportMessage.value = parts.length > 0
          ? t('components.settings.settingsPanel.exportImport.importSuccess', { items: parts.join('、') })
          : t('components.settings.settingsPanel.exportImport.importNoItems')
        importExportMessageType.value = 'success'
      } else if (response?.cancelled) {
        // 用户取消了
      } else {
        importExportMessage.value = response?.errors?.join('；') || t('components.settings.settingsPanel.exportImport.importFailed')
        importExportMessageType.value = 'error'
      }
    } catch (error: any) {
      importExportMessage.value = error?.message || t('components.settings.settingsPanel.exportImport.importFailed')
      importExportMessageType.value = 'error'
    } finally {
      isImporting.value = false
      if (importExportMessage.value) {
        importExportMessageTimer.schedule(8000, () => { importExportMessage.value = '' })
      }
    }
  }

  return {
    isExporting,
    isImporting,
    importExportMessage,
    importExportMessageType,
    handleExportSettings,
    handleImportSettings
  }
}
