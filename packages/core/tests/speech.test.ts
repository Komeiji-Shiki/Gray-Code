import type { SpeechSettings } from '@graycode/contracts';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { SpeechService, splitSpeechText } from '../../../apps/server/src/speech/service';
import { speechSettings, validateSpeechSettings } from '../../../apps/server/src/speech/settings';

function fakeApp(settings: SpeechSettings, credential: string | null = 'test-key'): PlatformApplication {
  return {
    requireOwner: () => {},
    settings: {
      read: (key: string) => key === 'speech' ? { speech: settings } : {},
      credential: async () => credential,
    },
    product: { runtimeSettings: () => ({ getEffectiveProxyUrl: () => undefined }) },
  } as unknown as PlatformApplication;
}

const fish: SpeechSettings = { enabled: true, provider: 'fish', endpoint: 'https://api.fish.audio', model: 'drama-3',
  credentialRef: 'speech_fish_key', referenceId: 'voice-1', format: 'mp3', speed: 1 };

describe('speech text splitting', () => {
  test('splits long text at sentence boundaries without losing content', () => {
    const text = '第一句。第二句！第三句？\n第四句；'.repeat(120);
    const chunks = splitSpeechText(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 80)).toBe(true);
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  test('hard-cuts oversized text without splitting surrogate pairs', () => {
    const text = '😀'.repeat(700);
    const chunks = splitSpeechText(text, 1200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1200);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
    expect(chunks.join('')).toBe(text);
  });

  test('returns no clips for whitespace', () => {
    expect(splitSpeechText(' \n\t ')).toEqual([]);
  });
});

describe('speech settings', () => {
  test('feeds provider defaults and validates Fish cloning', () => {
    const value = speechSettings({ enabled: true, provider: 'fish', credentialRef: 'key', referenceId: 'voice' });
    expect(value.model).toBe('drama-3');
    expect(value.format).toBe('mp3');
    expect(() => validateSpeechSettings({ enabled: true, provider: 'fish', credentialRef: 'key' })).toThrow('音色');
    expect(() => validateSpeechSettings(value)).not.toThrow();
  });

  test('requires credentials for cloud providers and fixes Windows output', () => {
    expect(() => validateSpeechSettings({ enabled: true, provider: 'qwen', endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer' }))
      .toThrow('API Key');
    const system = speechSettings({ enabled: true, provider: 'system', format: 'mp3' });
    validateSpeechSettings(system);
    expect(system.format).toBe('wav');
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
    const result = await new SpeechService(fakeApp(fish)).synthesize({ text: '你好。' }, 'owner');
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
    const result = await new SpeechService(fakeApp(settings)).synthesize({ text: '你好。' }, 'owner');
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
    await new SpeechService(fakeApp(settings, null)).synthesize({ text: 'Hello.' }, 'owner');
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8880/v1/audio/speech');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'kokoro', voice: 'af_heart', response_format: 'mp3', speed: 1.2 });
  });

  test('clone uploads the reference audio as private Fish voice', async () => {
    const request = jest.fn(async () => new Response(JSON.stringify({ _id: 'new-voice', state: 'trained' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    globalThis.fetch = request as unknown as typeof fetch;
    const result = await new SpeechService(fakeApp(fish)).clone({ title: '灰魂', audio: Buffer.from('wav').toString('base64'),
      mimeType: 'audio/wav' }, 'owner');
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
});
