/**
 * Webview 声音提醒（Web Audio API）
 *
 * 设计目标：
 * - 默认优先使用扩展内置音效文件（resources/sound）；若不可用则回退到 Oscillator 生成提示音
 * - 支持导入本地音效覆盖
 * - 受控于 UI 设置（enabled/volume/cues/cooldownMs）
 * - 任何播放失败都必须被吞掉（不能影响主流程）
 *
 * 实现已按职责拆分（本文件仅保留 re-export，消费方 import 路径不变）：
 * - ./soundCueSettings  设置类型/默认值/归一化/配置
 * - ./soundAudioEngine  音频引擎（AudioContext/解码缓存/播放原语）
 * - ./soundPlayback     playCue 编排（冷却/播放槽预留）
 */

export {
  getBuiltinSoundAssets,
  DEFAULT_UI_SOUND_SETTINGS,
  normalizeUISoundSettings,
  configureSoundSettings,
  getSoundSettings
} from './soundCueSettings'

export type {
  SoundCue,
  SoundAgentRole,
  BuiltinSoundAsset,
  UISoundAsset,
  WindowsAgentStopNotificationContentSettings,
  WindowsAgentStopNotificationSettings,
  UISoundSettings,
  NormalizedUISoundSettings
} from './soundCueSettings'

export { unlockAudio, stopAllSounds } from './soundAudioEngine'

export { isCueEnabled, playCue } from './soundPlayback'
