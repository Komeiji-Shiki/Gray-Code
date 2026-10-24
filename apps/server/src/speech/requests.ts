import type { SpeechCloneInput } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import type { ClientSession } from '../transport/router';
import type { SpeechInput } from './service';

const cloudProviders = new Set(['fish', 'openai', 'qwen']);

/** 界面 ui.request 与平台 RPC 共用的语音入口，在这里统一确认主人身份。 */
export async function speechRequest(app: PlatformApplication, session: ClientSession, method: string, params: Record<string, any>) {
  app.requireOwner(session.actorId);
  switch (method) {
    case 'speech.status': return app.speech.status();
    case 'speech.synthesize': return app.speech.synthesize(params as SpeechInput);
    case 'speech.clone': return app.speech.clone(params as SpeechCloneInput);
    case 'speech.credential': {
      // 设置页切换提供商时回填该提供商已保存的密钥；凭据按提供商分开保存。
      const provider = String(params.provider ?? '');
      if (!cloudProviders.has(provider)) return { token: '' };
      const saved = app.settings.read('speech').speech;
      const reference = saved?.provider === provider && saved.credentialRef ? saved.credentialRef : `speech_${provider}_key`;
      return { token: await app.settings.credential(reference) ?? '' };
    }
    default: throw new Error('未知语音操作。');
  }
}
