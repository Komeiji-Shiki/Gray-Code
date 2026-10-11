import { ref, computed, onMounted, onBeforeUnmount, type Ref } from 'vue'
import { MESSAGE_NAMES } from '@shared/protocol'
import { validateNotificationQuietHours } from '@shared/notificationPolicy'
import { useDesktopSettingsDraft } from '@/platform/settingsDraft'
import { sendToExtension } from '@/utils/vscode'
import { formatFileSize } from '@/utils/file'
import { useI18n } from '@/i18n'
import {
  DEFAULT_UI_SOUND_SETTINGS,
  normalizeUISoundSettings,
  configureSoundSettings,
  getBuiltinSoundAssets,
  unlockAudio,
  type SoundCue,
  type UISoundAsset,
  type UISoundSettings
} from '@/services/soundCues'
import { useSoundSettingsPreview } from './useSoundSettingsPreview'

/** 设置草稿统一负责读取、导入、序列化与保存，组件只绑定表单。 */
export function useSoundSettings(assetFileInputRef: Ref<HTMLInputElement | null>) {
  const { t } = useI18n()

  const isLoading = ref(true)
  const isSaving = ref(false)

  const saveMessage = ref('')
  const saveMessageType = ref<'success' | 'error'>('success')
  // 保存消息自动消失定时器（组件卸载时清理）
  let saveMessageTimer: ReturnType<typeof setTimeout> | null = null

  const builtinAssets = getBuiltinSoundAssets()

  const assetMessage = ref('')
  const assetMessageType = ref<'success' | 'error'>('success')

  // ============ 表单状态 ============
  const enabled = ref(DEFAULT_UI_SOUND_SETTINGS.enabled)
  const quietHours = ref({ ...DEFAULT_UI_SOUND_SETTINGS.quietHours })
  const volume = ref(DEFAULT_UI_SOUND_SETTINGS.volume)
  const cooldownMs = ref(DEFAULT_UI_SOUND_SETTINGS.cooldownMs)

  const cueWarning = ref(DEFAULT_UI_SOUND_SETTINGS.cues.warning)
  const cueError = ref(DEFAULT_UI_SOUND_SETTINGS.cues.error)
  const cueTaskComplete = ref(DEFAULT_UI_SOUND_SETTINGS.cues.taskComplete)
  const cueTaskError = ref(DEFAULT_UI_SOUND_SETTINGS.cues.taskError)
  const cueSubagentWarning = ref(DEFAULT_UI_SOUND_SETTINGS.cues.subagent.warning)
  const cueSubagentError = ref(DEFAULT_UI_SOUND_SETTINGS.cues.subagent.error)
  const cueSubagentTaskComplete = ref(DEFAULT_UI_SOUND_SETTINGS.cues.subagent.taskComplete)
  const cueSubagentTaskError = ref(DEFAULT_UI_SOUND_SETTINGS.cues.subagent.taskError)
  const windowsAgentStopNotificationEnabled = ref(DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.enabled)
  const windowsAgentStopNotificationOnlyWhenWindowNotFocused = ref(
    DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.onlyWhenWindowNotFocused
  )
  const windowsAgentStopNotificationCaseError = ref(DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.cases.error)
  const windowsAgentStopNotificationCaseAwaitingUserAction = ref(DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.cases.awaitingUserAction)
  const windowsAgentStopNotificationCaseContinueRequired = ref(DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.cases.continueRequired)
  const windowsAgentStopNotificationTitleTemplate = ref(DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.content.titleTemplate)
  const windowsAgentStopNotificationErrorBodyTemplate = ref(DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.content.bodyTemplates.error)
  const windowsAgentStopNotificationAwaitingUserActionBodyTemplate = ref(
    DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.content.bodyTemplates.awaitingUserAction
  )
  const windowsAgentStopNotificationContinueRequiredBodyTemplate = ref(
    DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.content.bodyTemplates.continueRequired
  )

  const windowsAgentStopTemplateVariables = ['{appName}', '{windowTitle}', '{actionLabel}', '{reasonLabel}']

  const assetWarning = ref<UISoundAsset | null>(null)
  const assetError = ref<UISoundAsset | null>(null)
  const assetTaskComplete = ref<UISoundAsset | null>(null)
  const assetTaskError = ref<UISoundAsset | null>(null)

  // 用于在保存时判断“清除音效”是否需要显式写入 null
  const originalAssets = ref<{
    warning?: UISoundAsset
    error?: UISoundAsset
    taskComplete?: UISoundAsset
    taskError?: UISoundAsset
  }>({})

  const selectingAssetCue = ref<SoundCue | null>(null)
  const MAX_ASSET_BYTES = 10 * 1024 * 1024

  const theme = ref<UISoundSettings['theme']>(DEFAULT_UI_SOUND_SETTINGS.theme)

  function toPlainAsset(asset: UISoundAsset | null | undefined): UISoundAsset | undefined {
    if (!asset) return undefined
    return {
      // 显式构造纯对象，避免把 Vue Proxy 直接 postMessage 导致 DataCloneError
      name: String(asset.name || ''),
      mime: String(asset.mime || ''),
      dataBase64: String(asset.dataBase64 || '')
    }
  }

  const volumeText = computed(() => `${volume.value}%`)

  function buildWindowsAgentStopNotificationContentDraft() {
    return {
      titleTemplate: windowsAgentStopNotificationTitleTemplate.value,
      bodyTemplates: {
        error: windowsAgentStopNotificationErrorBodyTemplate.value,
        awaitingUserAction: windowsAgentStopNotificationAwaitingUserActionBodyTemplate.value,
        continueRequired: windowsAgentStopNotificationContinueRequiredBodyTemplate.value
      }
    }
  }

  const { testMessage, testMessageType, testCue, triggerWindowsNotificationPreview, cancelPendingRestore } = useSoundSettingsPreview({
    volume,
    assets: { warning: assetWarning, error: assetError, taskComplete: assetTaskComplete, taskError: assetTaskError },
    buildNotificationContent: buildWindowsAgentStopNotificationContentDraft
  })

  function buildCurrentSettings(): UISoundSettings {
    const assets: NonNullable<UISoundSettings['assets']> = {}

    const warningAsset = toPlainAsset(assetWarning.value)
    const errorAsset = toPlainAsset(assetError.value)
    const taskCompleteAsset = toPlainAsset(assetTaskComplete.value)
    const taskErrorAsset = toPlainAsset(assetTaskError.value)

    if (warningAsset) assets.warning = warningAsset
    else if (originalAssets.value.warning) assets.warning = null

    if (errorAsset) assets.error = errorAsset
    else if (originalAssets.value.error) assets.error = null

    if (taskCompleteAsset) assets.taskComplete = taskCompleteAsset
    else if (originalAssets.value.taskComplete) assets.taskComplete = null

    if (taskErrorAsset) assets.taskError = taskErrorAsset
    else if (originalAssets.value.taskError) assets.taskError = null

    return {
      enabled: enabled.value,
      quietHours: validateNotificationQuietHours({ ...quietHours.value }),
      volume: Math.min(100, Math.max(0, Number(volume.value) || 0)),
      cooldownMs: Math.min(60_000, Math.max(0, Number(cooldownMs.value) || 0)),
      cues: {
        warning: cueWarning.value,
        error: cueError.value,
        taskComplete: cueTaskComplete.value,
        taskError: cueTaskError.value,
        subagent: {
          warning: cueSubagentWarning.value,
          error: cueSubagentError.value,
          taskComplete: cueSubagentTaskComplete.value,
          taskError: cueSubagentTaskError.value
        }
      },
      assets: Object.keys(assets).length > 0 ? assets : undefined,
      windowsAgentStopNotification: {
        enabled: windowsAgentStopNotificationEnabled.value,
        onlyWhenWindowNotFocused: windowsAgentStopNotificationOnlyWhenWindowNotFocused.value,
        cases: {
          error: windowsAgentStopNotificationCaseError.value,
          awaitingUserAction: windowsAgentStopNotificationCaseAwaitingUserAction.value,
          continueRequired: windowsAgentStopNotificationCaseContinueRequired.value
        },
        content: buildWindowsAgentStopNotificationContentDraft()
      },
      theme: theme.value
    }
  }

  function showAssetMessage(message: string, type: 'success' | 'error') {
    assetMessage.value = message
    assetMessageType.value = type
    setTimeout(() => {
      assetMessage.value = ''
    }, 2500)
  }

  function triggerSelectAsset(cue: SoundCue) {
    selectingAssetCue.value = cue
    assetFileInputRef.value?.click()
  }

  function setAssetForCue(cue: SoundCue, asset: UISoundAsset | null) {
    switch (cue) {
      case 'warning':
        assetWarning.value = asset
        break
      case 'error':
        assetError.value = asset
        break
      case 'taskComplete':
        assetTaskComplete.value = asset
        break
      case 'taskError':
        assetTaskError.value = asset
        break
    }
  }

  async function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('read failed'))
      reader.readAsDataURL(file)
    })
  }

  async function handleAssetFileChange(e: Event) {
    const cue = selectingAssetCue.value
    selectingAssetCue.value = null

    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    // reset: 允许重复选择同一文件也触发 change
    input.value = ''

    if (!cue || !file) return

    if (file.size > MAX_ASSET_BYTES) {
      showAssetMessage(
        t('components.settings.soundSettings.assets.fileTooLarge', { size: formatFileSize(MAX_ASSET_BYTES) }),
        'error'
      )
      return
    }

    try {
      const dataUrl = await readFileAsDataUrl(file)
      const match = dataUrl.match(/^data:(.*?);base64,(.*)$/)
      const mime = (match?.[1] || file.type || '').trim()
      const dataBase64 = match?.[2] || ''

      if (!dataBase64) {
        showAssetMessage(t('components.settings.soundSettings.assets.invalidFile'), 'error')
        return
      }

      setAssetForCue(cue, {
        name: file.name,
        mime,
        dataBase64
      })

      showAssetMessage(
        t('components.settings.soundSettings.assets.importSuccess', { name: file.name }),
        'success'
      )
    } catch (err) {
      console.error('Failed to import sound asset:', err)
      showAssetMessage(t('components.settings.soundSettings.assets.invalidFile'), 'error')
    }
  }

  function clearAsset(cue: SoundCue) {
    setAssetForCue(cue, null)
    showAssetMessage(t('components.settings.soundSettings.assets.clearSuccess'), 'success')
  }

  async function loadConfig() {
    isLoading.value = true
    try {
      const response = await sendToExtension<any>(MESSAGE_NAMES.getSettings, {})
      const normalized = normalizeUISoundSettings(response?.settings?.ui?.sound)

      enabled.value = normalized.enabled
      quietHours.value = { ...normalized.quietHours }
      volume.value = normalized.volume
      cooldownMs.value = normalized.cooldownMs

      cueWarning.value = normalized.cues.warning
      cueError.value = normalized.cues.error
      cueTaskComplete.value = normalized.cues.taskComplete
      cueTaskError.value = normalized.cues.taskError

      cueSubagentWarning.value = normalized.cues.subagent.warning
      cueSubagentError.value = normalized.cues.subagent.error
      cueSubagentTaskComplete.value = normalized.cues.subagent.taskComplete
      cueSubagentTaskError.value = normalized.cues.subagent.taskError

      assetWarning.value = normalized.assets.warning ?? null
      assetError.value = normalized.assets.error ?? null
      assetTaskComplete.value = normalized.assets.taskComplete ?? null
      assetTaskError.value = normalized.assets.taskError ?? null

      originalAssets.value = {
        warning: normalized.assets.warning,
        error: normalized.assets.error,
        taskComplete: normalized.assets.taskComplete,
        taskError: normalized.assets.taskError
      }

      theme.value = normalized.theme
      windowsAgentStopNotificationEnabled.value = normalized.windowsAgentStopNotification.enabled
      windowsAgentStopNotificationOnlyWhenWindowNotFocused.value = normalized.windowsAgentStopNotification.onlyWhenWindowNotFocused
      windowsAgentStopNotificationCaseError.value = normalized.windowsAgentStopNotification.cases.error
      windowsAgentStopNotificationCaseAwaitingUserAction.value = normalized.windowsAgentStopNotification.cases.awaitingUserAction
      windowsAgentStopNotificationCaseContinueRequired.value = normalized.windowsAgentStopNotification.cases.continueRequired
      windowsAgentStopNotificationTitleTemplate.value = normalized.windowsAgentStopNotification.content.titleTemplate
      windowsAgentStopNotificationErrorBodyTemplate.value = normalized.windowsAgentStopNotification.content.bodyTemplates.error
      windowsAgentStopNotificationAwaitingUserActionBodyTemplate.value = normalized.windowsAgentStopNotification.content.bodyTemplates.awaitingUserAction
      windowsAgentStopNotificationContinueRequiredBodyTemplate.value = normalized.windowsAgentStopNotification.content.bodyTemplates.continueRequired

      // 同步到运行时（即使用户不点击保存，也保证显示与运行时一致）
      configureSoundSettings(normalized)
    } catch (error) {
      console.error('Failed to load sound settings:', error)
    } finally {
      isLoading.value = false
    }
  }

  async function saveConfig() {
    isSaving.value = true
    saveMessage.value = ''

    try {
      const settings = buildCurrentSettings()

      await sendToExtension(MESSAGE_NAMES.updateUISettings, {
        ui: {
          sound: settings
        }
      })

      // 立即生效
      configureSoundSettings(settings)

      // 若之前存在试听恢复定时器，取消并提升版本，避免旧回调回滚最新保存配置
      cancelPendingRestore()

      // 保存按钮属于用户手势：尝试解锁音频上下文，提升后续自动播放成功率
      if (settings.enabled) {
        void unlockAudio()
      }

      saveMessage.value = t('components.settings.soundSettings.saveSuccess')
      saveMessageType.value = 'success'

      // 更新“原始值快照”，确保后续保存/清除逻辑正确
      originalAssets.value = {
        warning: assetWarning.value ?? undefined,
        error: assetError.value ?? undefined,
        taskComplete: assetTaskComplete.value ?? undefined,
        taskError: assetTaskError.value ?? undefined
      }

      if (saveMessageTimer) clearTimeout(saveMessageTimer)
      saveMessageTimer = setTimeout(() => {
        saveMessage.value = ''
      }, 2000)
    } catch (error) {
      console.error('Failed to save sound settings:', error)
      saveMessage.value = error instanceof Error ? error.message : t('components.settings.soundSettings.saveFailed')
      saveMessageType.value = 'error'
      throw error
    } finally {
      isSaving.value = false
    }
  }

  async function resetToDefault() {
    quietHours.value = { ...DEFAULT_UI_SOUND_SETTINGS.quietHours }
    enabled.value = DEFAULT_UI_SOUND_SETTINGS.enabled
    volume.value = DEFAULT_UI_SOUND_SETTINGS.volume
    cooldownMs.value = DEFAULT_UI_SOUND_SETTINGS.cooldownMs

    cueWarning.value = DEFAULT_UI_SOUND_SETTINGS.cues.warning
    cueError.value = DEFAULT_UI_SOUND_SETTINGS.cues.error
    cueTaskComplete.value = DEFAULT_UI_SOUND_SETTINGS.cues.taskComplete
    cueTaskError.value = DEFAULT_UI_SOUND_SETTINGS.cues.taskError
    cueSubagentWarning.value = DEFAULT_UI_SOUND_SETTINGS.cues.subagent.warning
    cueSubagentError.value = DEFAULT_UI_SOUND_SETTINGS.cues.subagent.error
    cueSubagentTaskComplete.value = DEFAULT_UI_SOUND_SETTINGS.cues.subagent.taskComplete
    cueSubagentTaskError.value = DEFAULT_UI_SOUND_SETTINGS.cues.subagent.taskError
    windowsAgentStopNotificationEnabled.value = DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.enabled
    windowsAgentStopNotificationOnlyWhenWindowNotFocused.value = DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.onlyWhenWindowNotFocused
    windowsAgentStopNotificationCaseError.value = DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.cases.error
    windowsAgentStopNotificationCaseAwaitingUserAction.value = DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.cases.awaitingUserAction
    windowsAgentStopNotificationCaseContinueRequired.value = DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.cases.continueRequired
    windowsAgentStopNotificationTitleTemplate.value = DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.content.titleTemplate
    windowsAgentStopNotificationErrorBodyTemplate.value = DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.content.bodyTemplates.error
    windowsAgentStopNotificationAwaitingUserActionBodyTemplate.value =
      DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.content.bodyTemplates.awaitingUserAction
    windowsAgentStopNotificationContinueRequiredBodyTemplate.value =
      DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.content.bodyTemplates.continueRequired

    assetWarning.value = null
    assetError.value = null
    assetTaskComplete.value = null
    assetTaskError.value = null

    theme.value = DEFAULT_UI_SOUND_SETTINGS.theme

    await saveConfig()
  }

  onMounted(() => {
    loadConfig()
  })

  onBeforeUnmount(() => {
    // 清理消息自动消失定时器，避免卸载后仍修改状态
    if (saveMessageTimer) {
      clearTimeout(saveMessageTimer)
      saveMessageTimer = null
    }
  })
  useDesktopSettingsDraft(saveConfig, () => !isLoading.value)

  return {
    t,
    isLoading,
    isSaving,
    saveMessage,
    saveMessageType,
    testMessage,
    testMessageType,
    builtinAssets,
    assetMessage,
    assetMessageType,
    enabled,
    quietHours,
    volume,
    volumeText,
    cooldownMs,
    cueWarning,
    cueError,
    cueTaskComplete,
    cueTaskError,
    cueSubagentWarning,
    cueSubagentError,
    cueSubagentTaskComplete,
    cueSubagentTaskError,
    windowsAgentStopNotificationEnabled,
    windowsAgentStopNotificationOnlyWhenWindowNotFocused,
    windowsAgentStopNotificationCaseError,
    windowsAgentStopNotificationCaseAwaitingUserAction,
    windowsAgentStopNotificationCaseContinueRequired,
    windowsAgentStopNotificationTitleTemplate,
    windowsAgentStopNotificationErrorBodyTemplate,
    windowsAgentStopNotificationAwaitingUserActionBodyTemplate,
    windowsAgentStopNotificationContinueRequiredBodyTemplate,
    windowsAgentStopTemplateVariables,
    assetWarning,
    assetError,
    assetTaskComplete,
    assetTaskError,
    MAX_ASSET_BYTES,
    triggerSelectAsset,
    handleAssetFileChange,
    clearAsset,
    testCue,
    triggerWindowsNotificationPreview,
    saveConfig,
    resetToDefault
  }
}
