import type { ProviderDefinition } from '@graycode/contracts';
import { parseDecisionReview, reviewWithSystemOne, validateDecisionProvider } from '../../../apps/server/src/model/decisionReviewer';
import { PlatformApplication } from '../../../apps/server/src/application';
import { ApplicationRouter } from '../../../apps/server/src/transport/router';
import { fixture } from './fixtures';

const profile = {
  endpoint: 'https://decision.example.com/api/v1/judge',
  model: 'decision-v2',
  timeoutMs: 12_000,
} as ProviderDefinition;

function answer(choice: string, confidence = 0.9) {
  return { model: 'decision-v2', answers: { approval: { type: 'choice', choice, confidence } } };
}

test('System One 审核使用独立接口、渠道密钥和 typed choice 问题', async () => {
  const transport = { executeRequest: jest.fn().mockResolvedValue({ status: 200, headers: {}, body: answer('no_extra_approval') }) };
  const result = await reviewWithSystemOne({ toolName: 'write_file', args: { path: 'a.txt', content: 'test' },
    effects: ['workspace_write'], signal: new AbortController().signal }, profile, 'test-key', transport);
  expect(result.requireApproval).toBe(false);
  expect(transport.executeRequest).toHaveBeenCalledWith(expect.objectContaining({
    url: profile.endpoint, method: 'POST', timeout: profile.timeoutMs,
    headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    body: expect.objectContaining({ model: 'decision-v2',
      state: { tool: 'write_file', args: { path: 'a.txt', content: 'test' }, effects: ['workspace_write'] },
      questions: { approval: expect.objectContaining({ type: 'choice', criteria: expect.objectContaining({
        approval_required: expect.any(String), no_extra_approval: expect.any(String), uncertain: expect.any(String),
      }) }) },
    }),
  }), expect.any(AbortSignal));
});

test('决策模型仅在明确无需额外确认时放行', () => {
  expect(parseDecisionReview(answer('approval_required')).requireApproval).toBe(true);
  expect(parseDecisionReview(answer('uncertain')).requireApproval).toBe(true);
  expect(parseDecisionReview(answer('unexpected')).requireApproval).toBe(true);
  expect(parseDecisionReview({ answers: { approval: { type: 'choice', choice: 'no_extra_approval' } } }).requireApproval).toBe(true);
  expect(parseDecisionReview(answer('no_extra_approval', Number.NaN)).requireApproval).toBe(true);
});

test('决策审核渠道允许服务商自定义地址和模型名', () => {
  expect(() => validateDecisionProvider(profile)).not.toThrow();
  expect(() => validateDecisionProvider({ ...profile, endpoint: 'http://127.0.0.1:8000/decision' })).not.toThrow();
  expect(() => validateDecisionProvider({ ...profile, endpoint: 'ftp://example.com/decision' })).toThrow('HTTP(S)');
  expect(() => validateDecisionProvider({ ...profile, model: ' ' })).toThrow('模型名');
});

test('审核设置可以选取尚未保存的决策渠道，并随渠道密钥一起保存', async () => {
  const f = await fixture(); await f.store.close();
  const app = await PlatformApplication.open({ dataDirectory: f.data, secretCodec: {
    encrypt: async value => Buffer.from(value, 'utf8'),
    decrypt: async value => Buffer.from(value).toString('utf8'),
  } });
  const router = new ApplicationRouter(app);
  const call = (type: string, data: Record<string, unknown> = {}) =>
    router.call({ actorId: 'owner', clientId: 'decision-settings' }, 'ui.request', { type, data }) as Promise<any>;
  try {
    await call('ui.settings.begin');
    const chat = await call('config.createConfig', { name: '普通聊天', type: 'openai' });
    await call('config.updateConfig', { configId: chat, updates: { url: 'https://example.com/v1/chat/completions', model: 'chat-model' } });
    await call('settings.setActiveChannelId', { channelId: chat });
    const reviewer = await call('config.createConfig', { name: '百炼决策', type: 'openai' });
    await call('config.updateConfig', { configId: reviewer, updates: { url: profile.endpoint, model: profile.model, apiKey: 'fixture-key' } });
    expect((await call('platform.reviewers.get')).providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: reviewer, endpoint: profile.endpoint, model: profile.model }),
    ]));
    await call('platform.reviewers.update', { id: 'default', reviewerProviderId: reviewer, reviewerApi: 'systemone' });
    await call('ui.settings.save');
    const saved = app.settings.snapshot().settings;
    expect(saved.agents[0]).toMatchObject({ providerId: chat, reviewerProviderId: reviewer, reviewerApi: 'systemone' });
    const reference = saved.providers.find(item => item.id === reviewer)?.credentialRef;
    expect(reference).toBeTruthy();
    expect(await app.settings.credential(reference!)).toBe('fixture-key');
    await call('config.updateConfig', { configId: reviewer, updates: {
      url: 'https://another.example.org/decision/check', model: 'judge-next', apiKey: 'fixture-key-updated',
    } });
    await call('ui.settings.save');
    expect(app.settings.snapshot().settings.providers.find(item => item.id === reviewer)).toMatchObject({
      endpoint: 'https://another.example.org/decision/check', model: 'judge-next',
    });
    expect(await app.settings.credential(reference!)).toBe('fixture-key-updated');
  } finally { await app.close(); await f.cleanup(); }
});
