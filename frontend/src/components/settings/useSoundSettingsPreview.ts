import { onBeforeUnmount, ref, type Ref } from 'vue'
import { MESSAGE_NAMES } from '@shared/protocol'
import { isNotificationQuiet } from '@shared/notificationPolicy'
import { useI18n } from '@/i18n'
import { sendToExtension } from '@/utils/vscode'
import {
  configureSoundSettings,
  getSoundSettings,
  unlockAudio,
  stopAllSounds,
  playCue,
  type SoundCue,
  type UISoundAsset,
  type WindowsAgentStopNotificationContentSettings
} from '@/services/soundCues'

type WindowsAgentStopPreviewReason = 'error' | 'awaiting_user_action' | 'continue_required'

interface SoundSettingsPreviewOptions {
  volume: Readonly<Ref<number>>
  assets: Record<SoundCue, Readonly<Ref<UISoundAsset | null>>>
  buildNotificationContent: () => WindowsAgentStopNotificationContentSettings
}

/** 试听临时覆盖运行时设置，保存和卸载共用恢复版本，避免旧回调覆盖新配置。 */
export function useSoundSettingsPreview(options: SoundSettingsPreviewOptions) {
  const { t } = useI18n()
  const { volume, assets, buildNotificationContent } = options
  const { warning: assetWarning, error: assetError, taskComplete: assetTaskComplete, taskError: assetTaskError } = assets
  let testMessageTimer: ReturnType<typeof setTimeout> | null = null
  const testMessage = ref('')
  const testMessageType = ref<'success' | 'error'>('success')

  // 试听恢复保护：避免旧的 setTimeout 在用户保存/再次试听后回滚最新配置
  const testRestoreVersion = ref(0)
  let pendingRestoreTimer: ReturnType<typeof setTimeout> | null = null

  function clearPendingTestRestore() {
    if (pendingRestoreTimer) {
      clearTimeout(pendingRestoreTimer)
      pendingRestoreTimer = null
    }
  }

  const activeTestControllers = new Set<AbortController>()

  function cancelActiveTests() {
    for (const controller of Array.from(activeTestControllers)) {
      controller.abort()
    }
    activeTestControllers.clear()
  }

  function cancelPendingRestore() {
    testRestoreVersion.value += 1
    clearPendingTestRestore()
  }

  async function triggerWindowsNotificationPreview(reason: WindowsAgentStopPreviewReason): Promise<void> {
    try {
      const payload = {
        reason,
        actionType: reason === 'awaiting_user_action'
          ? 'execute_plan'
          : reason === 'continue_required'
            ? 'continue'
            : undefined,
        content: buildNotificationContent()
      }

      const result = await sendToExtension<{ shown?: boolean; reason?: string }>(MESSAGE_NAMES['notifications.preview'], payload)
      testMessage.value = result?.reason === 'do_not_disturb'
        ? t('components.settings.soundSettings.quietHours.active')
        : result?.shown ? t('components.settings.soundSettings.quietHours.previewShown') : t('components.settings.soundSettings.quietHours.previewUnavailable')
      testMessageType.value = result?.shown || result?.reason === 'do_not_disturb' ? 'success' : 'error'
    } catch (error) {
      console.error('Failed to trigger Windows notification preview:', error)
    }
  }

  async function testCue(cue: SoundCue) {
    testMessage.value = ''
    if (isNotificationQuiet(getSoundSettings().quietHours)) {
      testMessage.value = t('components.settings.soundSettings.quietHours.active')
      testMessageType.value = 'success'
      return
    }

    // 试听应使用当前表单音量，但不应把“未保存”的 enabled/cues 等设置带到运行时。
    // 因此这里临时覆盖运行时音量，播放后再恢复。
    const prev = getSoundSettings()
    const restoreVersion = ++testRestoreVersion.value
    clearPendingTestRestore()
    const tempVolume = Math.min(100, Math.max(0, Number(volume.value) || 0))
    configureSoundSettings({
      ...prev,
      volume: tempVolume,
      assets: {
        warning: assetWarning.value ?? undefined,
        error: assetError.value ?? undefined,
        taskComplete: assetTaskComplete.value ?? undefined,
        taskError: assetTaskError.value ?? undefined
      }
    })
    const controller = new AbortController()
    activeTestControllers.add(controller)

    try {
      if (controller.signal.aborted) return
      const unlocked = await unlockAudio()
      if (!unlocked.success) {
        testMessage.value = t('components.settings.soundSettings.testBlocked')
        testMessageType.value = 'error'
        return
      }

      const ok = await playCue(cue, { ignoreEnabled: true, bypassCooldown: true, abortSignal: controller.signal })
      if (ok) {
        testMessage.value = t('components.settings.soundSettings.testPlayed')
        testMessageType.value = 'success'
      } else {
        testMessage.value = t('components.settings.soundSettings.testFailed')
        testMessageType.value = 'error'
      }
      if (controller.signal.aborted) return
    } finally {
      activeTestControllers.delete(controller)
      // 给音频调度留一点时间，避免恢复音量影响当前试听
      pendingRestoreTimer = setTimeout(() => {
        if (testRestoreVersion.value !== restoreVersion) {
          pendingRestoreTimer = null
          return
        }
        configureSoundSettings(prev)
        pendingRestoreTimer = null
      }, 800)
    }

    if (testMessageTimer) clearTimeout(testMessageTimer)
    testMessageTimer = setTimeout(() => {
      testMessage.value = ''
    }, 2500)
  }

  onBeforeUnmount(() => {
    // 离开设置页时中止试听并停止当前播放，避免切页后声音继续
    cancelPendingRestore()
    cancelActiveTests()
    stopAllSounds()
    if (testMessageTimer) {
      clearTimeout(testMessageTimer)
      testMessageTimer = null
    }
  })

  return { testMessage, testMessageType, testCue, triggerWindowsNotificationPreview, cancelPendingRestore }
}
