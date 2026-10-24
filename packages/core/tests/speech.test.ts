import type { SpeechSettings } from '@graycode/contracts';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { SpeechService } from '../../../apps/server/src/speech/service';
import { speechRequest } from '../../../apps/server/src/speech/requests';
import { speechSettings, validateSpeechSettings } from '../../../apps/server/src/speech/settings';

function fakeApp(settings: SpeechSettings, credential: string | null = 'test-key'): PlatformApplication {
  const app = {
    requireOwner: (actorId: string) => { if (actorId !== 'owner') throw new Error('Owner access is required.'); },
    settings: {
      read: (key: string) => key === 'speech' ? { speech: settings } : {},
      credential: async () => credential,
    },
    product: { runtimeSettings: () => ({ getEffectiveProxyUrl: () => undefined }) },
  } as unknown as PlatformApplication & { speech: SpeechService };
  app.speech = new SpeechService(app);
  return app;
}

const fish: SpeechSettings = { enabled: true, provider: 'fish', endpoint: 'https://api.fish.audio', model: 'drama-3',
  credentialRef: 'speech_fish_key', referenceId: 'voice-1', format: 'mp3', speed: 1 };

describe('speech settings', () => {
  test('fills provider defaults at read time without the save step rewriting settings', () => {
    const value = speechSettings({ enabled: true, provider: 'fish', credentialRef: 'key', referenceId: 'voice', speed: undefined });
    expect(value).toMatchObject({ model: 'drama-3', format: 'mp3', speed: 1, endpoint: 'https://api.fish.audio' });
    expect(speechSettings({ enabled: true, provider: 'openai', endpoint: 'http://127.0.0.1:8880/v1/' }))
      .toMatchObject({ endpoint: 'http://127.0.0.1:8880/v1', voice: 'alloy', model: 'tts-1' });
    // 克隆音色要先保存 API Key 才能创建，保存时不能要求音色 ID 已经存在。
    const draft: SpeechSettings = { enabled: true, provider: 'fish', credentialRef: 'key', endpoint: 'https://api.fish.audio/' };
    const before = structuredClone(draft);
    expect(() => validateSpeechSettings(draft)).not.toThrow();
    expect(draft).toEqual(before);
  });

  test('requires credentials for cloud providers and fixes Windows output', () => {
    expect(() => validateSpeechSettings({ enabled: true, provider: 'qwen', endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer' }))
      .toThrow('API Key');
    const system = speechSettings({ enabled: true, provider: 'system', format: 'mp3' });
    validateSpeechSettings(system);
    expect(system).toMatchObject({ format: 'wav', endpoint: undefined, model: undefined });
    expect(() => validateSpeechSettings({ enabled: false, provider: 'qwen', format: 'opus' })).toThrow('Opus');
  });

  test('rejects invalid endpoints and speeds', () => {
    expect(() => validateSpeechSettings({ enabled: false, provider: 'openai', endpoint: 'ftp://example.com' })).toThrow('HTTP');
    expect(() => validateSpeechSettings({ enabled: false, provider: 'openai', endpoint: 'https://example.com', speed: 3 })).toThrow('语速');
  });
});

describe('speech providers', () => {
  const original = globalThis.fetch;
  afterEach(() => { globalThis.fetch = original; jest.restoreAllMocks(); });

  test('Fish Audio sends model and reference in the expected request', async () => {
    const request = jest.fn(async () => new Response(Buffer.from('mp3-data'), { status: 200 }));
    globalThis.fetch = request as unknown as typeof fetch;
    const result = await new SpeechService(fakeApp(fish)).synthesize({ text: '你好。' }, 'ui');
    expect(result.provider).toBe('fish');
    expect(result.clips).toEqual([{ text: '你好。', mimeType: 'audio/mpeg', base64: Buffer.from('mp3-data').toString('base64') }]);
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.fish.audio/v1/tts');
    expect(new Headers(init.headers).get('model')).toBe('drama-3');
    expect(JSON.parse(String(init.body))).toMatchObject({ text: '你好。', reference_id: 'voice-1', format: 'mp3' });
  });

  test('Qwen accepts base64 audio from output.audio.data', async () => {
    const settings: SpeechSettings = { enabled: true, provider: 'qwen', credentialRef: 'speech_qwen_key',
      endpoint: 'https://dashscope.example.com/api/v1/services/audio/tts/SpeechSynthesizer',
      model: 'qwen-audio-3.1-tts-flash', voice: 'Cherry', format: 'wav' };
    const request = jest.fn(async () => new Response(JSON.stringify({ output: { audio: {
      data: Buffer.from('wav-data').toString('base64') } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    globalThis.fetch = request as unknown as typeof fetch;
    const result = await new SpeechService(fakeApp(settings)).synthesize({ text: '你好。' }, 'ui');
    expect(result.clips[0]).toMatchObject({ mimeType: 'audio/wav', base64: Buffer.from('wav-data').toString('base64') });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(settings.endpoint);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'qwen-audio-3.1-tts-flash',
      input: { text: '你好。', voice: 'Cherry', format: 'wav' } });
  });

  test('OpenAI-compatible endpoint uses response_format and voice', async () => {
    const settings: SpeechSettings = { enabled: true, provider: 'openai', endpoint: 'http://127.0.0.1:8880/v1',
      model: 'kokoro', voice: 'af_heart', format: 'mp3', speed: 1.2 };
    const request = jest.fn(async () => new Response(Buffer.from('audio'), { status: 200 }));
    globalThis.fetch = request as unknown as typeof fetch;
    await new SpeechService(fakeApp(settings, null)).synthesize({ text: 'Hello.' }, 'ui');
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8880/v1/audio/speech');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'kokoro', voice: 'af_heart', response_format: 'mp3', speed: 1.2 });
  });

  test('clone uploads the reference audio as private Fish voice', async () => {
    const request = jest.fn(async () => new Response(JSON.stringify({ _id: 'new-voice', state: 'trained' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    globalThis.fetch = request as unknown as typeof fetch;
    const result = await new SpeechService(fakeApp(fish)).clone({ title: 'Gray', audio: Buffer.from('wav').toString('base64'),
      mimeType: 'audio/wav' });
    expect(result).toEqual({ id: 'new-voice', state: 'trained' });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.fish.audio/model');
    expect(new Headers(init.headers).get('content-type')).toContain('multipart/form-data');
    const body = Buffer.from(init.body as Uint8Array).toString('latin1');
    expect(body).toContain('name="type"\r\n\r\ntts');
    expect(body).toContain('name="visibility"\r\n\r\nprivate');
    expect(body).toContain('name="voices"; filename="reference.wav"');
    expect(body).toContain('Content-Type: audio/wav');
  });

  test('reads Markdown as plain text and marks provider failures as upstream errors', async () => {
    const request = jest.fn(async () => new Response(Buffer.from('mp3-data'), { status: 200 }));
    globalThis.fetch = request as unknown as typeof fetch;
    await new SpeechService(fakeApp(fish)).synthesize({ text: '## 标题\n\n**好的**，见 [文档](https://example.com)。\n```\ncode\n```' }, 'ui');
    const [, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text).toBe('标题\n\n好的，见 文档。');

    globalThis.fetch = jest.fn(async () => new Response('quota exceeded', { status: 429 })) as unknown as typeof fetch;
    await expect(new SpeechService(fakeApp(fish)).synthesize({ text: '你好。' }, 'ui'))
      .rejects.toMatchObject({ code: 'UPSTREAM_FAILED', message: expect.stringContaining('429') });
    globalThis.fetch = jest.fn(async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(new SpeechService(fakeApp(fish)).synthesize({ text: '你好。' }, 'ui')).rejects.toMatchObject({ code: 'UPSTREAM_FAILED' });
  });

  test('one request entry checks the owner once and validates clone input types', async () => {
    const app = fakeApp(fish);
    await expect(speechRequest(app, { actorId: 'guest', clientId: 'remote' }, 'speech.synthesize', { text: '你好' })).rejects.toThrow('Owner');
    await expect(speechRequest(app, { actorId: 'owner', clientId: 'ui' }, 'speech.clone', { title: 42, audio: 'AAAA', mimeType: 'audio/wav' }))
      .rejects.toThrow('音色名称');
    await expect(speechRequest(app, { actorId: 'owner', clientId: 'ui' }, 'speech.credential', { provider: 'fish' })).resolves.toEqual({ token: 'test-key' });
    await expect(speechRequest(app, { actorId: 'owner', clientId: 'ui' }, 'speech.unknown', {})).rejects.toThrow('未知语音操作');
  });

  test('reuses synthesized clips until a voice-affecting setting changes', async () => {
    const request = jest.fn(async () => new Response(Buffer.from('mp3-data'), { status: 200 }));
    globalThis.fetch = request as unknown as typeof fetch;
    const service = new SpeechService(fakeApp(fish));
    const first = await service.synthesize({ text: '同一句话。' }, 'ui');
    expect(await service.synthesize({ text: '同一句话。' }, 'ui')).toEqual(first);
    expect(request).toHaveBeenCalledTimes(1);
    await service.synthesize({ text: '同一句话。', speed: 1.5 }, 'ui');
    expect(request).toHaveBeenCalledTimes(2);
    await service.synthesize({ text: '同一句话。\n新的一句。' }, 'ui');
    expect(request).toHaveBeenCalledTimes(3);
  });

  test('deduplicates repeated sentences within one call, keeps plain text intact and cancels only the calling client', async () => {
    const calls: string[] = [];
    globalThis.fetch = jest.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body));
      calls.push(parsed.text);
      return new Response(Buffer.from(`audio:${parsed.text}`), { status: 200 });
    }) as unknown as typeof fetch;
    const app = fakeApp(fish);
    const sentence = `${'重复'.repeat(350)}。`;
    const repeated = `${sentence}${sentence}`;
    const result = await app.speech.synthesize({ text: repeated }, 'ui');
    expect(result.clips).toHaveLength(2);
    expect(result.clips[0]).toEqual(result.clips[1]);
    expect(calls).toHaveLength(1);
    expect((app.speech as unknown as { cacheSize: number }).cacheSize).toBe(result.clips[0].base64.length);

    calls.length = 0;
    await app.speech.synthesize({ text: '1. 保留 [原始](文本)。', plain: true }, 'ui');
    expect(calls).toEqual(['1. 保留 [原始](文本)。']);

    globalThis.fetch = jest.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), { once: true });
    })) as unknown as typeof fetch;
    const own = speechRequest(app, { actorId: 'owner', clientId: 'ui' }, 'speech.synthesize', { text: '正在合成的长句。' });
    const other = app.speech.synthesize({ text: '另一个客户端的句子。' }, 'control-api');
    let otherSettled = false;
    other.catch(() => {}).finally(() => { otherSettled = true; });
    await speechRequest(app, { actorId: 'owner', clientId: 'ui' }, 'speech.cancel', {});
    const cancelled = await own.catch(error => error);
    expect(cancelled.message).toBe('语音合成已取消。');
    expect(cancelled.code).toBeUndefined();
    await new Promise(resolve => setImmediate(resolve));
    expect(otherSettled).toBe(false);
    app.speech.close();
    await expect(other).rejects.toThrow('语音服务已关闭。');
  });
});
