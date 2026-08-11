/**
 * 声音提醒设置层：类型定义、默认值、归一化与配置（不直接操作音频引擎）
 *
 * 设计目标：
 * - 默认优先使用扩展内置音效文件（resources/sound）；若不可用则回退到 Oscillator 生成提示音
 * - 支持导入本地音效覆盖
 * - 受控于 UI 设置（enabled/volume/cues/cooldownMs）
 * - 任何播放失败都必须被吞掉（不能影响主流程）
 */

import { updateMasterGain, pruneDecodedAudioCache } from './soundAudioEngine'

// 自定义音效大小上限（与设置页导入限制保持一致）
const MAX_SOUND_ASSET_BYTES = 10 * 1024 * 1024
const MAX_SOUND_ASSET_BASE64_LENGTH = Math.ceil((MAX_SOUND_ASSET_BYTES * 4) / 3) + 4

export type SoundCue = 'warning' | 'error' | 'taskComplete' | 'taskError'

/**
 * 提示音事件所属代理角色。
 *
 * - 'main'：主代理（主对话）事件，使用 cues 顶层开关
 * - 'subagent'：子代理（SubAgent）事件，使用 cues.subagent 独立开关
 */
export type SoundAgentRole = 'main' | 'subagent'

export type BuiltinSoundAsset = {
  url: string
  name: string
}

let builtinSoundAssets: Partial<Record<SoundCue, BuiltinSoundAsset>> = {}

function loadBuiltinSoundAssetsFromWindow(): void {
  try {
    if (typeof window === 'undefined') return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (window as any).__GRAYCODE_BUILTIN_SOUND_ASSETS
    if (!raw || typeof raw !== 'object') return

    const out: Partial<Record<SoundCue, BuiltinSoundAsset>> = {}
    const cues: SoundCue[] = ['warning', 'error', 'taskComplete', 'taskError']
    for (const cue of cues) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry = (raw as any)[cue]
      if (!entry || typeof entry !== 'object') continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anyEntry = entry as any

      const url = typeof anyEntry.url === 'string' ? anyEntry.url : ''
      const name = typeof anyEntry.name === 'string' ? anyEntry.name : cue
      if (!url) continue

      out[cue] = { url, name }
    }

    builtinSoundAssets = out
  } catch {
    // ignore
  }
}

loadBuiltinSoundAssetsFromWindow()

export function getBuiltinSoundAssets(): Partial<Record<SoundCue, BuiltinSoundAsset>> {
  // 兜底：防止极端情况下脚本加载顺序导致未初始化
  if (Object.keys(builtinSoundAssets).length === 0) {
    loadBuiltinSoundAssetsFromWindow()
  }
  return builtinSoundAssets
}

export function getBuiltinSoundAsset(cue: SoundCue): BuiltinSoundAsset | undefined {
  const assets = getBuiltinSoundAssets()
  return assets[cue]
}

export interface UISoundAsset {
  /** 文件名（展示用） */
  name: string
  /** mime 类型（展示用，可为空字符串） */
  mime: string
  /** base64 内容（不含 data: 前缀） */
  dataBase64: string
}

export interface WindowsAgentStopNotificationContentSettings {
  titleTemplate?: string
  bodyTemplates?: {
    error?: string
    awaitingUserAction?: string
    continueRequired?: string
  }
}

export interface WindowsAgentStopNotificationSettings {
  enabled?: boolean
  onlyWhenWindowNotFocused?: boolean
  cases?: {
    error?: boolean
    awaitingUserAction?: boolean
    continueRequired?: boolean
  }
  content?: WindowsAgentStopNotificationContentSettings
}

export interface UISoundSettings {
  /** 总开关（默认关闭，避免打扰） */
  enabled?: boolean

  /** 音量（0-100） */
  volume?: number

  /** 最小播放间隔（毫秒），用于限流 */
  cooldownMs?: number

  /** 各类提示音开关 */
  cues?: {
    warning?: boolean
    error?: boolean
    taskComplete?: boolean
    /** 任务失败提示音（可与 error 分开控制） */
    taskError?: boolean

    /** 子代理（SubAgent）事件提示音开关：与主代理分开控制 */
    subagent?: {
      warning?: boolean
      error?: boolean
      taskComplete?: boolean
      taskError?: boolean
    }
  }

  /**
   * 自定义音效（可选）：为各类提示音导入本地音频文件。
   *
   * 注意：为支持“清除已导入音效”，这里允许显式写入 null。
   */
  assets?: {
    warning?: UISoundAsset | null
    error?: UISoundAsset | null
    taskComplete?: UISoundAsset | null
    taskError?: UISoundAsset | null
  }

  /** 提示音风格 */
  theme?: 'beep' | 'soft'

  /** Windows 专用 Agent 停止系统通知 */
  windowsAgentStopNotification?: WindowsAgentStopNotificationSettings
}

export interface NormalizedUISoundSettings {
  enabled: boolean
  volume: number
  cooldownMs: number
  cues: {
    warning: boolean
    error: boolean
    taskComplete: boolean
    taskError: boolean
    /** 子代理（SubAgent）事件提示音开关 */
    subagent: {
      warning: boolean
      error: boolean
      taskComplete: boolean
      taskError: boolean
    }
  }
  assets: {
    warning?: UISoundAsset
    error?: UISoundAsset
    taskComplete?: UISoundAsset
    taskError?: UISoundAsset
  }
  theme: 'beep' | 'soft'
  windowsAgentStopNotification: {
    enabled: boolean
    onlyWhenWindowNotFocused: boolean
    cases: {
      error: boolean
      awaitingUserAction: boolean
      continueRequired: boolean
    }
    content: {
      titleTemplate: string
      bodyTemplates: {
        error: string
        awaitingUserAction: string
        continueRequired: string
      }
    }
  }
}

export const DEFAULT_UI_SOUND_SETTINGS: NormalizedUISoundSettings = {
  enabled: false,
  volume: 60,
  cooldownMs: 800,
  cues: {
    warning: true,
    error: true,
    taskComplete: true,
    taskError: true,
    subagent: {
      warning: true,
      error: true,
      taskComplete: true,
      taskError: true
    }
  },
  assets: {},
  theme: 'beep',
  windowsAgentStopNotification: {
    enabled: false,
    onlyWhenWindowNotFocused: true,
    cases: {
      error: true,
      awaitingUserAction: true,
      continueRequired: true
    },
    content: {
      titleTemplate: '{windowTitle} · GrayCode',
      bodyTemplates: {
        error: 'GrayCode 已停止，请返回处理。',
        awaitingUserAction: 'GrayCode 正在等待：{actionLabel}。',
        continueRequired: 'GrayCode 已暂停，可继续处理。'
      }
    }
  }
}

export let currentSettings: NormalizedUISoundSettings = { ...DEFAULT_UI_SOUND_SETTINGS }

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeTemplateString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  return value.trim() || fallback
}

function normalizeSoundAsset(input: unknown): UISoundAsset | undefined {
  if (!input || typeof input !== 'object') return undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyInput = input as any

  const name = typeof anyInput.name === 'string' ? anyInput.name : ''
  const mime = typeof anyInput.mime === 'string' ? anyInput.mime : ''
  const dataBase64 = typeof anyInput.dataBase64 === 'string' ? anyInput.dataBase64 : ''

  if (!dataBase64 || !dataBase64.trim()) return undefined
  // 基础安全限制：避免极端大对象导致 webview 卡顿/内存暴涨
  if (dataBase64.length > MAX_SOUND_ASSET_BASE64_LENGTH) return undefined

  return {
    name: name || 'sound',
    mime,
    dataBase64
  }
}

export function normalizeUISoundSettings(input?: UISoundSettings | null): NormalizedUISoundSettings {
  const enabled = typeof input?.enabled === 'boolean' ? input.enabled : DEFAULT_UI_SOUND_SETTINGS.enabled
  const volume = clampNumber(input?.volume, 0, 100, DEFAULT_UI_SOUND_SETTINGS.volume)
  const cooldownMs = clampNumber(input?.cooldownMs, 0, 60_000, DEFAULT_UI_SOUND_SETTINGS.cooldownMs)

  const cues = {
    warning: typeof input?.cues?.warning === 'boolean' ? input.cues.warning : DEFAULT_UI_SOUND_SETTINGS.cues.warning,
    error: typeof input?.cues?.error === 'boolean' ? input.cues.error : DEFAULT_UI_SOUND_SETTINGS.cues.error,
    taskComplete: typeof input?.cues?.taskComplete === 'boolean' ? input.cues.taskComplete : DEFAULT_UI_SOUND_SETTINGS.cues.taskComplete,
    taskError: typeof input?.cues?.taskError === 'boolean' ? input.cues.taskError : DEFAULT_UI_SOUND_SETTINGS.cues.taskError,
    subagent: {
      warning: typeof input?.cues?.subagent?.warning === 'boolean' ? input.cues.subagent.warning : DEFAULT_UI_SOUND_SETTINGS.cues.subagent.warning,
      error: typeof input?.cues?.subagent?.error === 'boolean' ? input.cues.subagent.error : DEFAULT_UI_SOUND_SETTINGS.cues.subagent.error,
      taskComplete: typeof input?.cues?.subagent?.taskComplete === 'boolean' ? input.cues.subagent.taskComplete : DEFAULT_UI_SOUND_SETTINGS.cues.subagent.taskComplete,
      taskError: typeof input?.cues?.subagent?.taskError === 'boolean' ? input.cues.subagent.taskError : DEFAULT_UI_SOUND_SETTINGS.cues.subagent.taskError
    }
  }

  const theme = input?.theme === 'soft' || input?.theme === 'beep'
    ? input.theme
    : DEFAULT_UI_SOUND_SETTINGS.theme

  const assets = {
    warning: normalizeSoundAsset(input?.assets?.warning),
    error: normalizeSoundAsset(input?.assets?.error),
    taskComplete: normalizeSoundAsset(input?.assets?.taskComplete),
    taskError: normalizeSoundAsset(input?.assets?.taskError)
  }

  const windowsAgentStopNotification = {
    enabled: typeof input?.windowsAgentStopNotification?.enabled === 'boolean'
      ? input.windowsAgentStopNotification.enabled
      : DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.enabled,
    onlyWhenWindowNotFocused: typeof input?.windowsAgentStopNotification?.onlyWhenWindowNotFocused === 'boolean'
      ? input.windowsAgentStopNotification.onlyWhenWindowNotFocused
      : DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.onlyWhenWindowNotFocused,
    cases: {
      error: typeof input?.windowsAgentStopNotification?.cases?.error === 'boolean' ? input.windowsAgentStopNotification.cases.error : DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.cases.error,
      awaitingUserAction: typeof input?.windowsAgentStopNotification?.cases?.awaitingUserAction === 'boolean' ? input.windowsAgentStopNotification.cases.awaitingUserAction : DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.cases.awaitingUserAction,
      continueRequired: typeof input?.windowsAgentStopNotification?.cases?.continueRequired === 'boolean' ? input.windowsAgentStopNotification.cases.continueRequired : DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.cases.continueRequired
    },
    content: {
      titleTemplate: normalizeTemplateString(
        input?.windowsAgentStopNotification?.content?.titleTemplate,
        DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.content.titleTemplate
      ),
      bodyTemplates: {
        error: normalizeTemplateString(input?.windowsAgentStopNotification?.content?.bodyTemplates?.error, DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.content.bodyTemplates.error),
        awaitingUserAction: normalizeTemplateString(input?.windowsAgentStopNotification?.content?.bodyTemplates?.awaitingUserAction, DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.content.bodyTemplates.awaitingUserAction),
        continueRequired: normalizeTemplateString(input?.windowsAgentStopNotification?.content?.bodyTemplates?.continueRequired, DEFAULT_UI_SOUND_SETTINGS.windowsAgentStopNotification.content.bodyTemplates.continueRequired)
      }
    }
  }

  return {
    enabled,
    volume,
    cooldownMs,
    cues,
    assets,
    theme,
    windowsAgentStopNotification
  }
}

export function configureSoundSettings(settings?: UISoundSettings | null): void {
  currentSettings = normalizeUISoundSettings(settings)
  updateMasterGain()
  pruneDecodedAudioCache(currentSettings.assets)
}

export function getSoundSettings(): NormalizedUISoundSettings {
  return currentSettings
}
