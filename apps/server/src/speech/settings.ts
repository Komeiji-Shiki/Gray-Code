import type { SpeechProvider, SpeechSettings } from '@graycode/contracts';
import { DEFAULT_SPEECH_SETTINGS, SPEECH_PROVIDER_DEFAULTS } from '../../../../shared/speech';

const providers = new Set<SpeechProvider>(['fish', 'openai', 'qwen', 'system']);
const formats = new Set(['mp3', 'wav', 'opus']);

/**
 * 保存时只拒绝无法使用的值，不改写设置。Fish 的克隆音色 ID 允许先空着：
 * 创建克隆需要先保存 API Key，合成时再提示缺少音色。
 */
export function validateSpeechSettings(settings?: SpeechSettings): void {
  if (!settings) return;
  if (typeof settings.enabled !== 'boolean') throw new Error('语音合成需要明确的启用状态。');
  if (!providers.has(settings.provider)) throw new Error('请选择支持的语音合成提供商。');
  if (settings.endpoint) {
    let url: URL;
    try { url = new URL(settings.endpoint); } catch { throw new Error('语音合成接口地址无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('语音合成接口必须是 HTTP 或 HTTPS 地址，且不能包含账号密码。');
  }
  if (settings.credentialRef !== undefined && (typeof settings.credentialRef !== 'string' || !settings.credentialRef.trim()))
    throw new Error('语音合成凭据引用无效。');
  if (settings.enabled && settings.provider === 'fish' && !settings.credentialRef) throw new Error('Fish Audio 需要填写 API Key。');
  if (settings.enabled && settings.provider === 'qwen' && !settings.credentialRef) throw new Error('Qwen 语音合成需要填写 DashScope API Key。');
  if (settings.speed !== undefined && (!Number.isFinite(settings.speed) || settings.speed < 0.5 || settings.speed > 2))
    throw new Error('语速必须在 0.5 至 2 之间。');
  if (settings.format !== undefined && !formats.has(settings.format)) throw new Error('语音格式无效。');
  if (settings.provider === 'qwen' && settings.format === 'opus') throw new Error('Qwen-Audio-TTS 不支持 Opus 输出。');
}

/** 读取时按提供商补齐未填写的端点、模型与音色，去掉端点末尾的斜杠；本机语音固定输出 WAV。 */
export function speechSettings(value?: SpeechSettings): SpeechSettings {
  const provider = value?.provider ?? DEFAULT_SPEECH_SETTINGS.provider;
  const defaults = SPEECH_PROVIDER_DEFAULTS[provider];
  const merged: SpeechSettings = { ...DEFAULT_SPEECH_SETTINGS, ...defaults, ...value,
    endpoint: (value?.endpoint?.trim() || defaults.endpoint)?.replace(/\/+$/, ''),
    model: value?.model?.trim() || defaults.model,
    voice: value?.voice?.trim() || defaults.voice,
    // 设置页草稿会带着值为 undefined 的字段保存，展开不会回落到默认值。
    speed: value?.speed ?? DEFAULT_SPEECH_SETTINGS.speed,
    format: value?.format ?? defaults.format };
  if (provider === 'system') { merged.format = 'wav'; merged.endpoint = undefined; merged.model = undefined; }
  return merged;
}
