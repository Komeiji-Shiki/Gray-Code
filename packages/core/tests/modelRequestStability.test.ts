import type { ModelInput, ProviderCapabilities, ProviderDefinition } from '@graycode/contracts';
import { ProviderModelAdapter } from '../../../apps/server/src/model/adapter';
import { applyProviderCapabilities, buildChannelConfig } from '../../../apps/server/src/model/capabilities';
import { FormatterRegistry } from '../../../backend/modules/channel/formatters';
import { applyOpenCodeSessionHeader } from '../../../backend/modules/channel/opencodeSession';
import { ensureStrictSchema } from '../../../backend/modules/channel/formatters/base';
import { resolveCapabilities } from '../../../apps/server/src/model/capabilities';
import type { GenerateRequest, HttpRequestOptions } from '../../../backend/modules/channel/types';

/** 写时复制之前的能力适配实现（整份深复制后原地修改），作为逐字节对照的基准。 */
function legacyApplyProviderCapabilities(options: HttpRequestOptions, profile: ProviderDefinition, input: ModelInput, request: GenerateRequest): HttpRequestOptions {
  const capabilities = resolveCapabilities(profile, input.modelOverride ?? profile.model);
  const body = structuredClone(options.body) as Record<string, any>;
  const limit = profile.generation.maxOutputTokens;
  if (capabilities.outputTokenParameter !== 'protocol_default' && limit !== undefined) {
    for (const field of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) delete body[field];
    body[capabilities.outputTokenParameter] = limit;
  }
  const effort = input.reasoningEffort ?? profile.generation.reasoningEffort;
  if (capabilities.reasoningParameter !== 'protocol_default') {
    delete body.reasoning_effort;
    if (body.reasoning) delete body.reasoning.effort;
    if (body.output_config) delete body.output_config.effort;
    if (effort && capabilities.reasoningParameter !== 'disabled') {
      const field = capabilities.reasoningParameter;
      if (field === 'reasoning_effort') body.reasoning_effort = effort;
      else if (field === 'reasoning.effort') body.reasoning = { ...body.reasoning, effort };
      else if (field === 'output_config.effort') body.output_config = { ...body.output_config, effort };
      else if (profile.protocol === 'gemini')
        body.generationConfig = { ...body.generationConfig, thinkingConfig: { ...body.generationConfig?.thinkingConfig, thinkingLevel: effort } };
    }
  }
  if (Array.isArray(body.tools) && capabilities.strictTools !== 'protocol_default') {
    for (const tool of body.tools) {
      if (tool.type !== 'function') continue;
      const definition = tool.function ?? tool;
      definition.strict = capabilities.strictTools === 'enabled';
      if (definition.strict && definition.parameters) definition.parameters = ensureStrictSchema(definition.parameters, true);
    }
  }
  const headers = { ...options.headers, ...profile.customHeaders };
  return applyOpenCodeSessionHeader({ ...options, body: { ...body, ...profile.customBody }, headers }, request,
    { openCodeSessionEnabled: capabilities.compatibility.openCodeSession });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 覆盖图片与文字交错顺序、工具调用与结果（含结果图片）、思考签名和 Responses 推理项。 */
const history = (): ModelInput['messages'] => [
  { id: 'u1', role: 'user', isUserInput: true, parts: [{ text: '先看第一张' }, { inlineData: { mimeType: 'image/png', data: PNG_A } },
    { text: '再看第二张' }, { inlineData: { mimeType: 'image/png', data: PNG_B } }] },
  { id: 'm1', role: 'model', parts: [
    { text: '需要检查文件', thought: true, thoughtSignature: 'sig-thought-1' },
    { text: '我来读取。' },
    { functionCall: { id: 'call_1', name: 'inspect', args: { path: 'a.ts', options: { depth: 2, tags: ['x', 'y'] } } }, thoughtSignature: 'sig-call-1' },
  ] },
  { id: 'r1', role: 'user', isFunctionResponse: true, parts: [
    { functionResponse: { id: 'call_1', name: 'inspect', response: { success: true, data: { lines: ['one', 'two'] } } } },
    { inlineData: { mimeType: 'image/png', data: PNG_A } },
  ] },
  { id: 'm2', role: 'model', parts: [{ text: '读取完成。', thoughtSignature: 'sig-text-2' }] },
  { id: 'u2', role: 'user', isUserInput: true, parts: [{ text: '继续' }] },
];

const tools = (): ModelInput['tools'] => [
  { name: 'inspect', description: 'Inspect a file', parameters: { type: 'object', properties: {
    path: { type: 'string' }, options: { type: 'object', properties: { depth: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } } },
  }, required: ['path'] } },
  { name: 'search', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 200 } }, required: ['query'] } },
];

type Variant = { name: string; capabilities: Partial<ProviderCapabilities>; generation?: ProviderDefinition['generation']; customBody?: Record<string, unknown>; customHeaders?: Record<string, string> };
const variants: Variant[] = [
  { name: 'protocol defaults', capabilities: {} },
  { name: 'max_tokens + reasoning_effort + strict', capabilities: { outputTokenParameter: 'max_tokens', reasoningParameter: 'reasoning_effort', strictTools: 'enabled' } },
  { name: 'max_completion_tokens + reasoning.effort + non-strict', capabilities: { outputTokenParameter: 'max_completion_tokens', reasoningParameter: 'reasoning.effort', strictTools: 'disabled' } },
  { name: 'max_output_tokens + output_config.effort', capabilities: { outputTokenParameter: 'max_output_tokens', reasoningParameter: 'output_config.effort', strictTools: 'enabled' } },
  { name: 'thinking_level', capabilities: { reasoningParameter: 'thinking_level' } },
  { name: 'reasoning disabled without effort', capabilities: { reasoningParameter: 'disabled', strictTools: 'disabled' }, generation: { maxOutputTokens: 64 } },
  { name: 'custom body/headers + compatibility identities', capabilities: { strictTools: 'enabled', reasoningSignature: 'deepseek',
    compatibility: { deepSeekUserId: true, openCodeSession: true, deepSeekVision: false, nativePdf: true } },
    customBody: { temperature: 0.2, reasoning: { summary: 'auto' } }, customHeaders: { 'x-fixture': 'stable' } },
  { name: 'no thought signatures', capabilities: { reasoningSignature: 'none', outputTokenParameter: 'max_tokens' } },
];
const protocols = ['openai', 'openai-responses', 'anthropic', 'gemini', 'gemini-interactions'] as const;

function profileFor(protocol: typeof protocols[number], variant: Variant): ProviderDefinition {
  const levels = variant.capabilities.reasoningParameter === 'disabled' ? [] : ['low', 'high'];
  return { id: 'stable', name: 'stable', protocol, endpoint: 'http://127.0.0.1:9/v1', model: 'fixture-model', models: [], stream: false, timeoutMs: 5000,
    generation: variant.generation ?? { maxOutputTokens: 321, reasoningEffort: levels.length ? 'high' : undefined, temperature: 0.5 },
    customBody: variant.customBody, customHeaders: variant.customHeaders,
    capabilities: { outputTokenParameter: 'protocol_default', strictTools: 'protocol_default', reasoningParameter: 'protocol_default',
      reasoningLevels: levels, reasoningSignature: 'native', ...variant.capabilities,
      compatibility: { deepSeekUserId: false, openCodeSession: false, deepSeekVision: false, nativePdf: false, ...variant.capabilities.compatibility } } } as ProviderDefinition;
}

const input = (promptContext?: ModelInput['promptContext']): ModelInput => ({ providerId: 'stable', conversationId: 'stable-conversation', systemPrompt: 'Stable system',
  messages: history(), tools: tools(), promptContext, signal: new AbortController().signal });

const promptContext: ModelInput['promptContext'] = { historyPlacement: 'entry',
  beforeHistoryMessages: [{ role: 'user', parts: [{ text: '固定环境' }, { inlineData: { mimeType: 'image/png', data: PNG_B } }] }],
  afterHistoryMessages: [{ role: 'user', parts: [{ text: '当前发言者：fixture-member' }] }] };

describe('模型请求能力适配的写时复制保持请求逐字节不变', () => {
  const cases = protocols.flatMap(protocol => variants.map(variant => [protocol, variant.name, variant] as const));

  test.each(cases)('%s / %s 与深复制实现序列化一致且不修改格式器正文', (protocol, _name, variant) => {
    const profile = profileFor(protocol, variant);
    for (const context of [undefined, promptContext]) {
      const request = input(context);
      const config = buildChannelConfig(profile, request, '');
      const generate: GenerateRequest = { configId: profile.id, conversationId: request.conversationId, history: request.messages as any,
        abortSignal: request.signal, dynamicContextStrategy: 'preserve', promptContext: request.promptContext as GenerateRequest['promptContext'] };
      const formatter = new FormatterRegistry().get(protocol)!;
      const built = formatter.buildRequest(generate, config, request.tools as any);
      const expected = JSON.stringify(legacyApplyProviderCapabilities(built, profile, request, generate));
      const frozen = deepFreeze(formatter.buildRequest(generate, config, request.tools as any));
      const snapshot = JSON.stringify(frozen);
      // 冻结的格式器正文若被原地修改会直接抛错，保证调用方与共享的嵌套对象不受影响。
      const actual = applyProviderCapabilities(frozen, profile, request, generate);
      expect(JSON.stringify(actual)).toBe(expected);
      expect(JSON.stringify(frozen)).toBe(snapshot);
    }
  });
});

describe('适配器请求准备不修改调用方数据，重复准备逐字节一致', () => {
  test.each(protocols.flatMap(protocol => variants.map(variant => [protocol, variant.name, variant] as const)))('%s / %s', async (protocol, _name, variant) => {
    const profile = profileFor(protocol, variant);
    const adapter = new ProviderModelAdapter({ profile: async () => profile, credential: async () => '' });
    const fresh = () => ({ ...input(structuredClone(promptContext)), maxOutputTokens: 77 });
    const frozen = fresh();
    deepFreeze(frozen.messages); deepFreeze(frozen.tools); deepFreeze(frozen.promptContext);
    const first = JSON.stringify((await adapter.preview(frozen)).body);
    const second = JSON.stringify((await adapter.preview(fresh())).body);
    expect(first).toBe(second);
    expect(JSON.stringify(frozen.messages)).toBe(JSON.stringify(history()));
    // 图片按原顺序全部保留。
    expect(first.indexOf(PNG_A)).toBeGreaterThanOrEqual(0);
    expect(first.indexOf(PNG_B)).toBeGreaterThanOrEqual(0);
  });
});
