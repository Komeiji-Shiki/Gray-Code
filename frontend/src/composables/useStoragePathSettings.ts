import { ref, reactive, watch } from 'vue'
import { sendToExtension } from '@/utils/vscode'
import { MESSAGE_NAMES } from '@shared/protocol'
import { useI18n } from '@/i18n'
import { useDeferredSave } from './useDeferredSave'
import { useOneShotTimer } from './useOneShotTimer'

/**
 * SettingsPanel「存储路径」区块的领域逻辑（S7 批次拆分，纯重构，行为零变化）。
 *
 * 从 SettingsPanel.vue 中抽出：状态（storageSettings / 校验结果 / 迁移进度 / 消息）与
 * 动作（加载 / 选择目录 / 打开资源管理器 / 校验 / 迁移 / 重置 / 重载）全部下放到此
 * composable，SettingsPanel 只保留编排与模板接线。
 */
export function useStoragePathSettings() {
  const { t } = useI18n()

  // 存储路径设置
  const storageSettings = reactive({
    currentPath: '',
    defaultPath: '',
    customPath: '',
    isCustom: false
  })
  const isValidatingPath = ref(false)
  const pathValidationResult = ref<{ valid: boolean; message?: string } | null>(null)
  const isMigrating = ref(false)
  const showMigrateDialog = ref(false)
  const storageMessage = ref('')
  const storageMessageType = ref<'success' | 'error' | 'info'>('success')
  const needsReload = ref(false) // 迁移完成后需要重新加载
  let pathValidationRequestId = 0

  // 防抖校验（卸载时取消，不再执行；原逻辑也是卸载清定时器）
  const deferredValidate = useDeferredSave({ delay: 500, flushOnUnmount: false })
  // 存储消息自动消失定时器（卸载时由 useOneShotTimer 清理）
  const storageMessageTimer = useOneShotTimer()

  // 加载存储路径配置
  async function loadStorageConfig() {
    try {
      const response = await sendToExtension<any>(MESSAGE_NAMES['storagePath.getConfig'], {})
      if (response) {
        storageSettings.currentPath = response.effectivePath || ''
        storageSettings.defaultPath = response.defaultPath || ''
        storageSettings.customPath = response.config?.customDataPath || ''
        storageSettings.isCustom = !!response.config?.customDataPath
      }
    } catch (error) {
      console.error('Failed to load storage config:', error)
    }
  }

  // 打开系统文件夹选择器
  async function pickStoragePath() {
    try {
      const response = await sendToExtension<any>(MESSAGE_NAMES['storagePath.selectFolder'], {}, { timeoutMs: 120000 })
      if (response?.path) {
        storageSettings.customPath = response.path
      }
    } catch (error: any) {
      storageMessage.value = error?.message || t('components.settings.storageSettings.notifications.validationFailed').replace('{error}', '')
      storageMessageType.value = 'error'
    }
  }

  // 在文件资源管理器中打开存储目录
  async function openStoragePathInExplorer() {
    try {
      await sendToExtension(MESSAGE_NAMES['storagePath.openInExplorer'], {
        path: storageSettings.currentPath
      })
    } catch (error: any) {
      storageMessage.value = error?.message || t('components.settings.storageSettings.notifications.openInExplorerFailed').replace('{error}', '')
      storageMessageType.value = 'error'
    }
  }

  // 验证路径
  async function validateStoragePath(path: string) {
    const normalizedPath = path.trim()
    const requestId = ++pathValidationRequestId

    if (!normalizedPath) {
      pathValidationResult.value = null
      isValidatingPath.value = false
      return
    }

    isValidatingPath.value = true
    pathValidationResult.value = null

    try {
      const response = await sendToExtension<any>(MESSAGE_NAMES['storagePath.validate'], { path: normalizedPath })
      if (requestId === pathValidationRequestId && storageSettings.customPath.trim() === normalizedPath) {
        pathValidationResult.value = {
          valid: response?.valid ?? false,
          message: response?.error
        }
      }
    } catch (error: any) {
      if (requestId === pathValidationRequestId && storageSettings.customPath.trim() === normalizedPath) {
        pathValidationResult.value = {
          valid: false,
          message: error?.message || 'Validation failed'
        }
      }
    } finally {
      if (requestId === pathValidationRequestId) {
        isValidatingPath.value = false
      }
    }
  }

  // 防抖验证
  function debouncedValidatePath(path: string) {
    pathValidationRequestId++
    isValidatingPath.value = path.trim() !== ''
    pathValidationResult.value = null
    deferredValidate.schedule(() => {
      validateStoragePath(path)
    })
  }

  // 监听自定义路径变化
  watch(() => storageSettings.customPath, (newPath) => {
    debouncedValidatePath(newPath)
  })

  // 应用存储路径（迁移数据到新路径）
  async function applyStoragePath() {
    if (isMigrating.value) return

    const newPath = storageSettings.customPath.trim()

    if (!newPath) {
      storageMessage.value = t('components.settings.storageSettings.notifications.applyEmptyHint')
      storageMessageType.value = 'info'
      return
    }

    if (!pathValidationResult.value?.valid) {
      // 路径验证未通过
      storageMessage.value = pathValidationResult.value?.message || t('components.settings.storageSettings.notifications.validationFailed').replace('{error}', '')
      storageMessageType.value = 'error'
      return
    }

    // 使用迁移接口来应用新路径（迁移到新路径）
    confirmMigrate()
  }

  // 重置为默认路径
  async function resetStoragePath() {
    if (isMigrating.value) return

    if (!storageSettings.isCustom) {
      // 已经是默认路径，无需重置
      storageMessage.value = t('components.settings.storageSettings.notifications.alreadyDefault')
      storageMessageType.value = 'info'
      return
    }

    isMigrating.value = true
    needsReload.value = false

    try {
      const response = await sendToExtension<any>(MESSAGE_NAMES['storagePath.reset'], {})

      if (response?.success) {
        storageSettings.customPath = ''
        pathValidationResult.value = null
        storageMessage.value = t('components.settings.storageSettings.notifications.migrationSuccess')
        storageMessageType.value = 'success'
        needsReload.value = true  // 重置也需要重新加载窗口才能生效
        await loadStorageConfig()
      } else {
        storageMessage.value = response?.error || 'Failed to reset storage path'
        storageMessageType.value = 'error'
      }
    } catch (error: any) {
      storageMessage.value = error?.message || 'Failed to reset storage path'
      storageMessageType.value = 'error'
    } finally {
      isMigrating.value = false
    }

    // 只有非成功消息才自动消失
    if (!needsReload.value) {
      storageMessageTimer.schedule(5000, () => {
        storageMessage.value = ''
      })
    }
  }

  // 打开迁移确认对话框
  function confirmMigrate() {
    showMigrateDialog.value = true
  }

  // 执行数据迁移
  async function executeMigration() {
    if (isMigrating.value) return

    showMigrateDialog.value = false
    isMigrating.value = true
    needsReload.value = false

    try {
      const response = await sendToExtension<any>(MESSAGE_NAMES['storagePath.migrate'], {
        path: storageSettings.customPath.trim()
      })

      if (response?.success) {
        storageMessage.value = t('components.settings.storageSettings.notifications.migrationSuccess')
        storageMessageType.value = 'success'
        needsReload.value = true  // 迁移成功，需要重新加载
        await loadStorageConfig()
      } else {
        const errorMsg = response?.error || 'Migration failed'
        storageMessage.value = t('components.settings.storageSettings.notifications.migrationFailed').replace('{error}', errorMsg)
        storageMessageType.value = 'error'
      }
    } catch (error: any) {
      storageMessage.value = t('components.settings.storageSettings.notifications.migrationFailed').replace('{error}', error?.message || 'Unknown error')
      storageMessageType.value = 'error'
    } finally {
      isMigrating.value = false
    }

    // 只有非成功消息才自动消失
    if (!needsReload.value) {
      storageMessageTimer.schedule(5000, () => {
        storageMessage.value = ''
      })
    }
  }

  // 重新加载窗口
  async function reloadWindow() {
    try {
      await sendToExtension(MESSAGE_NAMES.reloadWindow, {})
    } catch (error) {
      console.error('Failed to reload window:', error)
    }
  }

  return {
    storageSettings,
    isValidatingPath,
    pathValidationResult,
    isMigrating,
    showMigrateDialog,
    storageMessage,
    storageMessageType,
    needsReload,
    loadStorageConfig,
    pickStoragePath,
    openStoragePathInExplorer,
    applyStoragePath,
    resetStoragePath,
    executeMigration,
    reloadWindow
  }
}
