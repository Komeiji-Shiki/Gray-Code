/**
 * useLanguageSettings - 语言 / 外观 / 声音设置加载 Composable
 *
 * 从 App.vue 拆分（F-06）：
 * - 加载语言设置并写入 settingsStore 与 i18n
 * - 加载外观设置（loadingText / 选区上下文 / TPS 条 / 开屏动画）
 * - 加载声音提醒设置（不依赖 store，直接配置运行时服务）
 * - 维护 languageLoaded 标记（控制首帧渲染与 Splash ready）
 */

import { ref } from 'vue'
import { MESSAGE_NAMES } from '@shared/protocol'
import { useSettingsStore } from '../stores'
import { setLanguage, SUPPORTED_LANGUAGES } from '../i18n'
import type { SupportedLanguage } from '../i18n/types'
import { sendToExtension } from '../utils/vscode'
import { configureSoundSettings } from '../services/soundCues'

type SettingsStore = ReturnType<typeof useSettingsStore>

export function useLanguageSettings(settingsStore: SettingsStore) {
  // 语言是否已加载
  const languageLoaded = ref(false)

  function resolveSelectionContextEnabled(appearance: any): boolean {
    if (!appearance) return true
    if (typeof appearance.selectionContextEnabled === 'boolean') {
      return appearance.selectionContextEnabled
    }

    const hasLegacy =
      typeof appearance.selectionContextHoverEnabled === 'boolean' ||
      typeof appearance.selectionContextCodeActionEnabled === 'boolean'

    if (!hasLegacy) return true

    return (appearance.selectionContextHoverEnabled ?? true) ||
      (appearance.selectionContextCodeActionEnabled ?? true)
  }

  async function loadLanguageSettings() {
    try {
      const response = await sendToExtension<{
        settings?: {
          ui?: {
            language?: string
            appearance?: Record<string, any>
            sound?: any
          }
        }
      }>(MESSAGE_NAMES.getSettings, {})
      const language = response?.settings?.ui?.language
      // 运行时守卫：仅接受 SUPPORTED_LANGUAGES 中的合法语言值，类型系统据此收窄
      if (language && SUPPORTED_LANGUAGES.some(l => l.value === language)) {
        const lang = language as SupportedLanguage
        settingsStore.setLanguage(lang)
        setLanguage(lang)
      }

      // 加载外观设置
      if (response?.settings?.ui?.appearance) {
        const appearance = response.settings.ui.appearance
        settingsStore.setAppearanceLoadingText(appearance.loadingText || '')
        settingsStore.setSelectionContextEnabled(resolveSelectionContextEnabled(appearance))
        settingsStore.setTpsBarEnabled(appearance.tpsBarEnabled !== false)
        settingsStore.setSplashEnabled(appearance.splashEnabled !== false)
      }

      // 加载声音提醒设置（不依赖 store，直接配置运行时服务）
      configureSoundSettings(response?.settings?.ui?.sound)
    } catch (error) {
      console.error('Failed to load language settings:', error)
    } finally {
      languageLoaded.value = true
    }
  }

  return {
    languageLoaded,
    loadLanguageSettings
  }
}
