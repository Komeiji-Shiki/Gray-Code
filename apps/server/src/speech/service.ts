import { randomUUID } from 'node:crypto';
import type { SpeechClip, SpeechCloneInput, SpeechCloneResult, SpeechSettings, SpeechStatus, SpeechSynthesisResult } from '@graycode/contracts';
import { createProxyFetch } from '../../../../backend/modules/channel/proxyFetch';
import { SPEECH_MAX_TEXT, speechSegments } from '../../../../shared/speech';
import type { PlatformApplication } from '../application';
import { speechSettings } from './settings';
import { listSystemVoices, synthesizeSystem } from './systemVoice';

const maxAudioBytes = 30 * 1024 * 1024;
/** Fish 参考录音的解码后上限；控制接口按它推算请求体上限。 */
export const maxReferenceAudioBytes = 50 * 1024 * 1024;
const formats = new Set(['mp3', 'wav', 'opus']);
const mimeTypes: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg' };

export type SpeechFormat = 'mp3' | 'wav' | 'opus';
export interface SpeechInput { text: string; voice?: string; speed?: number; format?: SpeechFormat }

/** 上游语音服务失败或返回了不可用的内容；控制接口据此返回 502。 */
export class SpeechProviderError extends Error {
  readonly code = 'UPSTREAM_FAILED';
}

/** 代理请求只接受字符串或字节，multipart 由这里拼成 Buffer，不依赖 FormData 的序列化。 */
function multipart(boundary: string, fields: { name: string; value: string }[],
  file: { name: string; filename: string; mimeType: string; bytes: Buffer }): Buffer {
  const safe = (value: string) => value.replace(/["\r\n]/g, ' ').slice(0, 2_000);
  const chunks: Buffer[] = [];
  for (const field of fields)
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`, 'utf8'));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${safe(file.filename)}"\r\n`
    + `Content-Type: ${file.mimeType}\r\n\r\n`, 'utf8'));
  chunks.push(file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function clip(text: string, mimeType: string, bytes: Buffer): SpeechClip {
  if (!bytes.length) throw new SpeechProviderError('语音合成返回了空音频。');
  if (bytes.length > maxAudioBytes) throw new SpeechProviderError('语音合成返回的单段音频超过 30 MiB。');
  return { text, mimeType, base64: bytes.toString('base64') };
}

/** 调用方（界面、RPC 与控制接口）在各自入口确认主人身份，这里只校验参数并调用提供商。 */
export class SpeechService {
  private voices?: Promise<string[]>;
  constructor(private readonly app: PlatformApplication) {}

  settings(): SpeechSettings { return speechSettings(this.app.settings.read('speech').speech); }

  private credential(reference?: string): Promise<string | null> {
    return reference ? this.app.settings.credential(reference) : Promise.resolve(null);
  }

  async status(): Promise<SpeechStatus> {
    const settings = this.settings();
    const status: SpeechStatus = { available: true, enabled: settings.enabled, provider: settings.provider };
    if (settings.provider === 'system') {
      try {
        this.voices ??= listSystemVoices();
        status.systemVoices = await this.voices;
      } catch (error) {
        this.voices = undefined;
        status.available = false;
        status.error = error instanceof Error ? error.message : String(error);
      }
    }
    return status;
  }

  async synthesize(input: SpeechInput): Promise<SpeechSynthesisResult> {
    const settings = this.settings();
    if (!settings.enabled) throw new Error('请先在设置中启用语音合成。');
    if (typeof input.text !== 'string') throw new Error('text 必须是字符串。');
    if (input.text.length > SPEECH_MAX_TEXT) throw new Error(`单次最多朗读 ${SPEECH_MAX_TEXT} 个字符，请分段发送。`);
    const texts = speechSegments(input.text);
    if (!texts.length) throw new Error('没有可朗读的文字。');
    const voice = typeof input.voice === 'string' && input.voice.trim() ? input.voice.trim() : settings.voice;
    const speed = input.speed ?? settings.speed!;
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('语速必须在 0.5 至 2 之间。');
    if (settings.provider === 'system') {
      const items = await synthesizeSystem(texts, voice, speed);
      return { provider: 'system', voice, clips: items.map(item => clip(item.text, 'audio/wav', item.bytes)) };
    }
    const format = input.format ?? settings.format!;
    if (!formats.has(format)) throw new Error('format 只能是 mp3、wav 或 opus。');
    if (settings.provider === 'qwen' && format === 'opus') throw new Error('Qwen-Audio-TTS 不支持 Opus 输出。');
    const clips: SpeechClip[] = [];
    for (const text of texts) {
      const bytes = settings.provider === 'fish' ? await this.fish(settings, text, speed, format)
        : settings.provider === 'qwen' ? await this.qwen(settings, text, speed, format, voice!)
        : await this.openai(settings, text, speed, format, voice!);
      clips.push(clip(text, mimeTypes[format], bytes));
    }
    return { provider: settings.provider, ...(settings.provider === 'fish' ? {} : { voice }), clips };
  }

  private async request(url: string, init: RequestInit, timeout = 120_000): Promise<Response> {
    const fetcher = createProxyFetch(this.app.product.runtimeSettings().getEffectiveProxyUrl());
    let response: Response;
    try { response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeout) }); }
    catch (error) { throw new SpeechProviderError(`无法连接语音合成接口：${(error as Error).message}`); }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SpeechProviderError(`语音合成接口返回 ${response.status}${body ? `：${body.slice(0, 400)}` : ''}`);
    }
    return response;
  }

  private async audio(response: Response): Promise<Buffer> {
    return Buffer.from(await response.arrayBuffer());
  }

  private async fish(settings: SpeechSettings, text: string, speed: number, format: string): Promise<Buffer> {
    const apiKey = await this.credential(settings.credentialRef);
    if (!apiKey) throw new Error('Fish Audio API Key 不可用，请重新填写。');
    if (!settings.referenceId?.trim()) throw new Error('请先在语音设置中创建或填写 Fish Audio 克隆音色 ID。');
    const response = await this.request(`${settings.endpoint}/v1/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', model: settings.model! },
      body: JSON.stringify({ text, reference_id: settings.referenceId.trim(), format, ...(speed !== 1 ? { speed } : {}) }),
    });
    return this.audio(response);
  }

  private async openai(settings: SpeechSettings, text: string, speed: number, format: string, voice: string): Promise<Buffer> {
    const apiKey = await this.credential(settings.credentialRef);
    const response = await this.request(`${settings.endpoint}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: settings.model, input: text, voice, speed, response_format: format }),
    });
    return this.audio(response);
  }

  /** Qwen-Audio-TTS 同步接口把音频放在 URL 或 base64 字段中，两种都接受。 */
  private async qwen(settings: SpeechSettings, text: string, speed: number, format: string, voice: string): Promise<Buffer> {
    const apiKey = await this.credential(settings.credentialRef);
    if (!apiKey) throw new Error('Qwen 语音合成需要 DashScope API Key，请重新填写。');
    const response = await this.request(settings.endpoint!, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.model, input: { text, voice, format, ...(speed !== 1 ? { rate: speed } : {}) } }),
    });
    const value = await response.json().catch(() => null) as {
      output?: { audio?: { url?: string; data?: string } }; message?: string; code?: string;
    } | null;
    const audio = value?.output?.audio;
    if (audio?.data) return Buffer.from(audio.data.slice(audio.data.indexOf(',') + 1), 'base64');
    if (audio?.url) return this.audio(await this.request(audio.url, { method: 'GET' }, 60_000));
    throw new SpeechProviderError(value?.message || value?.code || 'Qwen 没有返回音频。');
  }

  /** Fish Audio 持久化克隆：上传参考录音一次，之后只使用返回的音色 ID。 */
  async clone(input: SpeechCloneInput): Promise<SpeechCloneResult> {
    const settings = this.settings();
    if (settings.provider !== 'fish') throw new Error('只有 Fish Audio 支持创建克隆音色，请先切换提供商并保存。');
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw new Error('请填写音色名称。');
    if (typeof input.audio !== 'string' || !input.audio) throw new Error('请提供 base64 编码的参考录音。');
    if (typeof input.mimeType !== 'string' || !input.mimeType.startsWith('audio/')) throw new Error('mimeType 必须是音频类型，例如 audio/wav。');
    const bytes = Buffer.from(input.audio, 'base64');
    if (!bytes.length) throw new Error('参考录音内容为空。');
    if (bytes.length > maxReferenceAudioBytes) throw new Error('参考录音不能超过 50 MiB。');
    const apiKey = await this.credential(settings.credentialRef);
    if (!apiKey) throw new Error('Fish Audio API Key 不可用，请先填写并保存。');
    const extension = input.mimeType.includes('wav') ? 'wav' : input.mimeType.includes('mpeg') ? 'mp3'
      : input.mimeType.includes('mp4') || input.mimeType.includes('m4a') ? 'm4a' : input.mimeType.includes('ogg') ? 'opus' : 'wav';
    const boundary = `----GrayCode${randomUUID().replace(/-/g, '')}`;
    const fields = [
      { name: 'type', value: 'tts' },
      { name: 'title', value: title.slice(0, 80) },
      { name: 'train_mode', value: 'fast' },
      { name: 'visibility', value: 'private' },
      ...(typeof input.text === 'string' && input.text.trim() ? [{ name: 'text', value: input.text.trim().slice(0, 2_000) }] : []),
    ];
    const body = multipart(boundary, fields, { name: 'voices', filename: `reference.${extension}`, mimeType: input.mimeType, bytes });
    const response = await this.request(`${settings.endpoint}/model`, {
      // Node 的 Buffer 都以 ArrayBuffer 为底层，直接共享内存，不再复制一份录音。
      method: 'POST', body: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    });
    const value = await response.json().catch(() => null) as { _id?: string; id?: string; state?: string; title?: string } | null;
    const id = value?._id || value?.id;
    if (!id) throw new SpeechProviderError('Fish Audio 没有返回音色 ID。');
    return { id, ...(value?.state ? { state: value.state } : {}), ...(value?.title ? { title: value.title } : {}) };
  }
}
