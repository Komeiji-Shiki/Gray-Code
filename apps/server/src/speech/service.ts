import { randomUUID } from 'node:crypto';
import type { SpeechClip, SpeechCloneInput, SpeechCloneResult, SpeechSettings, SpeechStatus, SpeechSynthesisResult } from '@graycode/contracts';
import { createProxyFetch } from '../../../../backend/modules/channel/proxyFetch';
import type { PlatformApplication } from '../application';
import { speechSettings } from './settings';
import { listSystemVoices, synthesizeSystem } from './systemVoice';

const maxTextLength = 12_000;
const chunkLimit = 1_200;
const maxAudioBytes = 30 * 1024 * 1024;
/** Fish 参考录音的解码后上限；控制接口按它推算请求体上限。 */
export const maxReferenceAudioBytes = 50 * 1024 * 1024;
const mimeTypes: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg' };
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
const endpointDefaults: Record<string, string> = { fish: 'https://api.fish.audio', openai: 'https://api.openai.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer' };
const qwenFallback = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';

/** 在句末或换行处分段；单句超长时按字符上限硬切，避免把代理对拆开。 */
export function splitSpeechText(value: string, limit = chunkLimit): string[] {
  const text = value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!text) return [];
  const chunks: string[] = [];
  let current = '';
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ''; };
  for (const sentence of text.split(/(?<=[。！？!?；;\n])/u)) {
    let rest = sentence;
    while (rest.length > limit) {
      let cut = limit;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
      flush();
      const piece = rest.slice(0, cut).trim();
      if (piece) chunks.push(piece);
      rest = rest.slice(cut);
    }
    if (current.length + rest.length > limit) flush();
    current += rest;
  }
  flush();
  return chunks;
}

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

  async synthesize(input: { text: string; voice?: string; speed?: number; format?: 'mp3' | 'wav' | 'opus' }, actorId: string): Promise<SpeechSynthesisResult> {
    this.app.requireOwner(actorId);
    const settings = this.settings();
    if (!settings.enabled) throw new Error('请先在设置中启用语音合成。');
    if (typeof input.text !== 'string') throw new Error('语音合成需要文本内容。');
    if (input.text.length > maxTextLength) throw new Error(`单次最多朗读 ${maxTextLength} 个字符，请分段发送。`);
    const texts = splitSpeechText(input.text);
    if (!texts.length) throw new Error('没有可朗读的文本。');
    const speed = input.speed ?? settings.speed ?? 1;
    if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('语速必须在 0.5 至 2 之间。');
    const format = input.format ?? settings.format ?? 'mp3';
    if (!['mp3', 'wav', 'opus'].includes(format)) throw new Error('语音格式无效。');
    if (settings.provider === 'qwen' && format === 'opus') throw new Error('Qwen-Audio-TTS 不支持 Opus 输出。');
    if (settings.provider === 'system') {
      const voice = input.voice ?? settings.voice;
      const clips: SpeechClip[] = (await synthesizeSystem(texts, voice, speed)).map(item => ({
        text: item.text, mimeType: 'audio/wav', base64: item.bytes.toString('base64'),
      }));
      return { provider: 'system', voice, clips };
    }
    const clips: SpeechClip[] = [];
    for (const text of texts) {
      const bytes = settings.provider === 'fish'
        ? await this.fish(settings, text, speed, format)
        : settings.provider === 'qwen'
          ? await this.qwen(settings, text, speed, format, input.voice)
          : await this.openai(settings, text, speed, format, input.voice);
      clips.push({ text, mimeType: mimeTypes[format] ?? 'audio/mpeg', base64: bytes.toString('base64') });
    }
    return { provider: settings.provider, voice: input.voice ?? settings.voice, clips };
  }

  private endpoint(settings: SpeechSettings, provider: keyof typeof endpointDefaults): string {
    return (settings.endpoint?.trim() || endpointDefaults[provider]).replace(/\/+$/, '');
  }

  private async request(url: string, init: RequestInit, timeout = 120_000): Promise<Response> {
    const proxy = this.app.product.runtimeSettings().getEffectiveProxyUrl();
    const fetcher = createProxyFetch(proxy);
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeout) } as Parameters<typeof fetcher>[1]);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`语音合成接口返回 ${response.status}${body ? `：${body.slice(0, 400)}` : ''}`);
    }
    return response;
  }

  private async audio(response: Response): Promise<Buffer> {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error('语音合成接口返回了空音频。');
    if (bytes.length > maxAudioBytes) throw new Error('语音合成接口返回的音频过大。');
    return bytes;
  }

  private async fish(settings: SpeechSettings, text: string, speed: number, format: string): Promise<Buffer> {
    const apiKey = await this.credential(settings.credentialRef);
    if (!apiKey) throw new Error('Fish Audio API Key 不可用，请重新填写。');
    if (!settings.referenceId?.trim()) throw new Error('请先创建或填写 Fish Audio 克隆音色 ID。');
    const response = await this.request(`${this.endpoint(settings, 'fish')}/v1/tts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model: settings.model?.trim() || 'drama-3',
      },
      body: JSON.stringify({ text, reference_id: settings.referenceId.trim(), format,
        ...(speed !== 1 ? { speed } : {}) }),
    });
    return this.audio(response);
  }

  private async openai(settings: SpeechSettings, text: string, speed: number, format: string, voiceOverride?: string): Promise<Buffer> {
    const apiKey = await this.credential(settings.credentialRef);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await this.request(`${this.endpoint(settings, 'openai')}/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: settings.model?.trim() || 'tts-1',
        input: text,
        voice: voiceOverride?.trim() || settings.voice?.trim() || 'alloy',
        speed,
        response_format: format,
      }),
    });
    return this.audio(response);
  }

  /** Qwen-Audio-TTS 同步接口把音频放在 URL 或 base64 字段中，两种都接受。 */
  private async qwen(settings: SpeechSettings, text: string, speed: number, format: string, voiceOverride?: string): Promise<Buffer> {
    const apiKey = await this.credential(settings.credentialRef);
    if (!apiKey) throw new Error('Qwen 语音合成需要 DashScope API Key，请重新填写。');
    const endpoint = settings.endpoint?.trim() ? this.endpoint(settings, 'qwen') : qwenFallback;
    const response = await this.request(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model?.trim() || 'qwen-audio-3.1-tts-flash',
        input: { text, voice: voiceOverride?.trim() || settings.voice?.trim() || 'Cherry', format,
          ...(speed !== 1 ? { rate: speed } : {}) },
      }),
    });
    const value = await response.json().catch(() => null) as {
      output?: { audio?: { url?: string; data?: string } }; message?: string; code?: string;
    } | null;
    const audio = value?.output?.audio;
    if (audio?.data) {
      const base64 = audio.data.includes(',') ? audio.data.slice(audio.data.indexOf(',') + 1) : audio.data;
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length > maxAudioBytes) throw new Error('Qwen 返回的音频过大。');
      return bytes;
    }
    if (audio?.url) {
      const download = await this.request(audio.url, { method: 'GET' }, 60_000);
      return this.audio(download);
    }
    throw new Error(value?.message || value?.code || 'Qwen 没有返回音频。');
  }

  /** Fish Audio 持久化克隆：上传参考录音一次，之后只使用返回的音色 ID。 */
  async clone(input: SpeechCloneInput, actorId: string): Promise<SpeechCloneResult> {
    this.app.requireOwner(actorId);
    const settings = this.settings();
    if (settings.provider !== 'fish') throw new Error('只有 Fish Audio 支持创建克隆音色。');
    const title = input.title?.trim();
    if (!title) throw new Error('请填写音色名称。');
    if (typeof input.audio !== 'string' || !input.audio) throw new Error('请选择参考录音。');
    if (!/^audio\//.test(input.mimeType)) throw new Error('参考录音必须是音频文件。');
    const bytes = Buffer.from(input.audio, 'base64');
    if (!bytes.length) throw new Error('参考录音内容为空。');
    if (bytes.length > maxReferenceAudioBytes) throw new Error('参考录音不能超过 50 MiB。');
    const apiKey = await this.credential(settings.credentialRef);
    if (!apiKey) throw new Error('Fish Audio API Key 不可用，请重新填写。');
    const extension = input.mimeType.includes('wav') ? 'wav' : input.mimeType.includes('mpeg') ? 'mp3'
      : input.mimeType.includes('mp4') || input.mimeType.includes('m4a') ? 'm4a' : input.mimeType.includes('ogg') ? 'opus' : 'wav';
    const boundary = `----GrayCode${randomUUID().replace(/-/g, '')}`;
    const fields = [
      { name: 'type', value: 'tts' },
      { name: 'title', value: title.slice(0, 80) },
      { name: 'train_mode', value: 'fast' },
      { name: 'visibility', value: 'private' },
      ...(input.text?.trim() ? [{ name: 'text', value: input.text.trim().slice(0, 2_000) }] : []),
    ];
    const body = multipart(boundary, fields, { name: 'voices', filename: `reference.${extension}`,
      mimeType: input.mimeType, bytes });
    const response = await this.request(`${this.endpoint(settings, 'fish')}/model`, {
      method: 'POST', body: new Uint8Array(body),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    });
    const value = await response.json().catch(() => null) as { _id?: string; id?: string; state?: string; title?: string } | null;
    const id = value?._id || value?.id;
    if (!id) throw new Error('Fish Audio 没有返回音色 ID。');
    return { id, ...(value?.state ? { state: value.state } : {}), ...(value?.title ? { title: value.title } : {}) };
  }
}
