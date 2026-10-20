import type { SpeechProvider, SpeechSettings } from '@graycode/contracts';

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  enabled: false,
  provider: 'fish',
  endpoint: 'https://api.fish.audio',
  model: 'drama-3',
  format: 'mp3',
  speed: 1,
  autoPlay: false,
};

const providers = new Set<SpeechProvider>(['fish', 'openai', 'qwen', 'system']);
const formats = new Set(['mp3', 'wav', 'opus']);

/** 合成设置随界面草稿保存；非法的端点或音色在写入前就拒绝。 */
export function validateSpeechSettings(settings?: SpeechSettings): void {
  if (!settings) return;
  if (typeof settings.enabled !== 'boolean') throw new Error('语音合成需要明确的启用状态。');
  if (!providers.has(settings.provider)) throw new Error('请选择支持的语音合成提供商。');
  if (settings.endpoint !== undefined && settings.endpoint !== '') {
    const value = new URL(settings.endpoint);
    if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password)
      throw new Error('语音合成接口必须是 HTTP 或 HTTPS 地址。');
    settings.endpoint = settings.endpoint.replace(/\/+$/, '');
  }
  if (settings.credentialRef !== undefined && (typeof settings.credentialRef !== 'string' || !settings.credentialRef.trim()))
    throw new Error('语音合成凭据引用无效。');
  if (settings.provider === 'fish' && settings.enabled && !settings.credentialRef)
    throw new Error('Fish Audio 需要填写 API Key。');
  if (settings.provider === 'qwen' && settings.enabled && !settings.credentialRef)
    throw new Error('Qwen 语音合成需要填写 DashScope API Key。');
  if (settings.provider === 'openai' && !settings.voice?.trim()) settings.voice = 'alloy';
  if (settings.provider === 'qwen' && !settings.voice?.trim()) settings.voice = 'Cherry';
  if (settings.provider === 'fish' && settings.enabled && !settings.referenceId?.trim())
    throw new Error('Fish Audio 需要先创建克隆音色，并填写音色 ID。');
  if (settings.speed !== undefined && (!Number.isFinite(settings.speed) || settings.speed < 0.5 || settings.speed > 2))
    throw new Error('语速必须在 0.5 至 2 之间。');
  if (settings.format !== undefined && !formats.has(settings.format)) throw new Error('语音格式无效。');
}

const providerDefaults: Record<SpeechProvider, Partial<SpeechSettings>> = {
  fish: { endpoint: 'https://api.fish.audio', model: 'drama-3', format: 'mp3' },
  openai: { endpoint: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy', format: 'mp3' },
  qwen: { endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
    model: 'qwen-audio-3.1-tts-flash', voice: 'Cherry', format: 'mp3' },
  system: { format: 'wav' },
};

/** 未填写端点时按提供商补齐，避免切换提供商后沿用另一家的地址。 */
export function speechSettings(value?: SpeechSettings): SpeechSettings {
  const provider = value?.provider ?? DEFAULT_SPEECH_SETTINGS.provider;
  const defaults = providerDefaults[provider];
  const merged: SpeechSettings = { ...DEFAULT_SPEECH_SETTINGS, ...defaults, ...value,
    endpoint: value?.endpoint?.trim() || defaults.endpoint, model: value?.model?.trim() || defaults.model };
  if (provider === 'system') { merged.format = 'wav'; merged.endpoint = undefined; }
  return merged;
}
