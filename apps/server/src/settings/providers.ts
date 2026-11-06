import type { ProviderDefinition, ProviderProtocol } from '@graycode/contracts';
import type { ChannelConfig } from '../../../../backend/modules/config/types';
import { buildChannelConfig } from '../model/capabilities';
import { protocolReasoningLevels } from '../../../../shared/reasoningEffort';

type Options = Record<string, any>;

/**
 * product-settings 里的渠道只保存 provider 表示不了的部分：协议专属选项、重试与上下文设置、
 * 关闭时记住的温度和输出上限等。端点、模型、生成参数与能力开关只存在 provider 中，
 * 渠道视图每次由两者合成，两边不会读到不同的值，也不需要和上一次的值比较。
 * type 记录这些选项所属的协议：provider 换了协议时，旧协议的选项不再适用。
 */
export type StoredChannel = { id: string; type?: ProviderProtocol } & Record<string, unknown>;

/** 完全由 provider 决定的顶层字段。 */
const PROVIDER_FIELDS = ['name', 'url', 'model', 'timeout', 'preferStream', 'authMode', 'apiKey', 'strictToolsEnabled',
  'responsesWebSocketEnabled', 'responsesAsyncToolsEnabled', 'openCodeSessionEnabled', 'deepSeekUserIdEnabled',
  'deepSeekVisionEnabled', 'pdfAttachmentEnabled', 'toolMediaUserMessageEnabled',
  'sendHistoryThoughtSignatures', 'reasoningSignatureMode', 'providerReasoningContentEnabled'];

const tokenKey = (protocol: string) => protocol.startsWith('gemini') ? 'maxOutputTokens' : protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens';
const thinkingKey = (protocol: string) => protocol.startsWith('gemini') ? 'thinkingConfig' : protocol === 'anthropic' ? 'thinking' : 'reasoning';

/**
 * 设置页把档位外的强度保存为 custom + effortCustom，格式器原样透传。Gemini 只有固定档位，
 * 而且只在 level 模式下发送；default 与 budget 模式留下的档位不是当前强度。
 */
function effortOf(protocol: string, value: Options | undefined): string | undefined {
  if (protocol.startsWith('gemini')) return value?.mode === 'level' ? value.thinkingLevel : undefined;
  return value?.effort === 'custom' ? value.effortCustom?.trim() || undefined : value?.effort;
}
function withEffort(protocol: ProviderProtocol, value: Options | undefined, effort: string): Options {
  if (protocol.startsWith('gemini')) return { ...value, mode: 'level', thinkingLevel: effort };
  const level = protocolReasoningLevels(protocol).includes(effort) ? { effort } : { effort: 'custom', effortCustom: effort };
  return protocol === 'anthropic' ? { ...value, type: value?.type ?? 'adaptive', ...level } : { ...value, ...level };
}
function withoutEffort(protocol: string, value: Options | undefined): Options | undefined {
  if (!value) return value;
  const rest = { ...value };
  for (const field of protocol.startsWith('gemini') ? ['thinkingLevel'] : ['effort', 'effortCustom']) delete rest[field];
  return rest;
}
const compact = (value: Options) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

/**
 * 推理签名：provider 只记签名类型。Responses 关闭签名时记住所选模式，DeepSeek 模式不决定是否发送历史签名，
 * 这两项细节留在渠道里；其他协议只有发送开关，codex 与 deepseek 只能由 provider 指定。
 */
function signatureOf(channel: ChannelConfig, previous?: ProviderDefinition): ProviderDefinition['capabilities']['reasoningSignature'] {
  const send = channel.sendHistoryThoughtSignatures;
  if (channel.type === 'openai-responses') {
    const mode = (channel as any).reasoningSignatureMode;
    return mode === 'deepseek' ? 'deepseek' : send === false ? 'none' : mode === 'codex' ? 'codex' : 'native';
  }
  const prior = previous?.capabilities.reasoningSignature;
  return send === false ? 'none' : send === true && prior === 'none' ? 'native' : prior ?? 'native';
}
function signatureFields(profile: ProviderDefinition, stored: Options) {
  const signature = profile.capabilities.reasoningSignature;
  const responses = profile.protocol === 'openai-responses';
  const remembered = responses && signature === 'none' && stored.reasoningSignatureMode === 'codex' ? 'codex' : 'official';
  return {
    sendHistoryThoughtSignatures: signature === 'deepseek' && responses ? stored.sendHistoryThoughtSignatures ?? true : signature !== 'none',
    reasoningSignatureMode: signature === 'codex' ? 'codex' : signature === 'deepseek' ? 'deepseek' : remembered,
    providerReasoningContentEnabled: signature === 'deepseek',
  };
}

/** 由 provider 与渠道附加选项合成完整渠道配置；没有附加选项时使用协议默认值。 */
export function channelView(profile: ProviderDefinition, stored?: StoredChannel): ChannelConfig {
  const defaults = buildChannelConfig({ ...profile, generation: { ...profile.generation, reasoningEffort: undefined } },
    { conversationId: '', providerId: profile.id, systemPrompt: '', messages: [], tools: [], signal: new AbortController().signal }, '');
  // 换了协议后旧协议的选项不再适用，只保留与协议无关的自动总结方式。
  const own = stored?.type === profile.protocol ? stored : undefined;
  const extras: Options = own ?? (stored?.autoSummarizeMethod !== undefined ? { autoSummarizeMethod: stored.autoSummarizeMethod } : {});
  const caps = profile.capabilities;
  const options: Options = { ...(extras.options ?? defaults.options) };
  const enabled: Record<string, boolean> = { ...(extras.optionsEnabled ?? defaults.optionsEnabled) };
  for (const [key, value] of [['temperature', profile.generation.temperature], [tokenKey(profile.protocol), profile.generation.maxOutputTokens]] as const) {
    if (value !== undefined) options[key] = value;
    enabled[key] = value !== undefined;
  }
  // 设置页的流式开关与格式器都读 options.stream，适配器按 provider.stream 选择读取方式，两者必须一致。
  options.stream = profile.stream;
  const effort = profile.generation.reasoningEffort;
  if (effort !== undefined) {
    const key = thinkingKey(profile.protocol);
    options[key] = withEffort(profile.protocol, options[key], effort);
    enabled[key] = true;
  }
  const extraModels = (extras.models ?? []) as Options[];
  return {
    ...defaults, ...extras,
    id: profile.id, name: profile.name, type: profile.protocol, url: profile.endpoint, model: profile.model,
    timeout: profile.timeoutMs, preferStream: profile.stream, apiKey: '',
    ...(profile.protocol === 'openai-responses' ? { authMode: profile.authMode } : {}),
    models: profile.models.map(model => ({ ...extraModels.find(item => item.id === model.id), id: model.id, name: model.name ?? model.id })),
    options, optionsEnabled: enabled,
    responsesWebSocketEnabled: caps.responsesWebSocket === true,
    responsesAsyncToolsEnabled: caps.responsesAsyncTools === true,
    openCodeSessionEnabled: caps.compatibility.openCodeSession,
    deepSeekUserIdEnabled: caps.compatibility.deepSeekUserId, deepSeekVisionEnabled: caps.compatibility.deepSeekVision,
    pdfAttachmentEnabled: caps.compatibility.nativePdf, toolMediaUserMessageEnabled: caps.compatibility.toolMediaUserMessage === true,
    ...signatureFields(profile, extras),
    ...(caps.strictTools !== 'protocol_default' ? { strictToolsEnabled: caps.strictTools === 'enabled' } : {}),
  } as ChannelConfig;
}

/**
 * 渠道里由 provider 表示的字段写进 provider，其余原样留给附加选项。provider 独有的字段
 * （模型能力、推理参数名与档位、自定义请求头和正文）沿用 previous。
 * 推理强度只有 provider 已经设置过时才跟随渠道：其余渠道的思考配置可能使用档位外的值，
 * 写进 provider 会让请求按模型档位校验失败。
 */
export function channelProfile(channel: ChannelConfig, previous?: ProviderDefinition, credentialRef?: string): ProviderDefinition {
  const options: Options = channel.options ?? {};
  const enabled = (channel.optionsEnabled ?? {}) as Record<string, boolean | undefined>;
  const thinking = thinkingKey(channel.type);
  return {
    ...previous,
    id: channel.id, name: channel.name, protocol: channel.type, endpoint: channel.url, model: channel.model ?? '',
    models: (channel.models ?? []).map(model => ({ id: model.id, name: model.name, capabilities: previous?.models.find(item => item.id === model.id)?.capabilities })),
    credentialRef, stream: (options.stream ?? channel.preferStream) !== false, timeoutMs: channel.timeout ?? previous?.timeoutMs ?? 120_000,
    authMode: channel.type === 'openai-responses' ? channel.authMode : undefined,
    generation: compact({
      reasoningEffort: previous?.generation.reasoningEffort !== undefined && enabled[thinking] ? effortOf(channel.type, options[thinking]) : undefined,
      temperature: enabled.temperature ? options.temperature : undefined,
      maxOutputTokens: enabled[tokenKey(channel.type)] ? options[tokenKey(channel.type)] : undefined }),
    capabilities: {
      outputTokenParameter: 'protocol_default', reasoningParameter: 'protocol_default', reasoningLevels: [],
      ...previous?.capabilities,
      reasoningSignature: signatureOf(channel, previous),
      responsesWebSocket: (channel as any).responsesWebSocketEnabled === true,
      responsesAsyncTools: (channel as any).responsesAsyncToolsEnabled === true,
      strictTools: channel.strictToolsEnabled === undefined ? previous?.capabilities.strictTools ?? 'protocol_default' : channel.strictToolsEnabled ? 'enabled' : 'disabled',
      compatibility: { openCodeSession: channel.openCodeSessionEnabled === true,
        deepSeekUserId: (channel as any).deepSeekUserIdEnabled === true, deepSeekVision: (channel as any).deepSeekVisionEnabled === true,
        nativePdf: (channel as any).pdfAttachmentEnabled === true,
        toolMediaUserMessage: (channel as any).toolMediaUserMessageEnabled === true },
    },
  };
}

/** 去掉 profile 已经表示的字段；同一渠道视图按它的 provider 拆分，得到的附加选项合成后不变。 */
export function channelExtras(channel: ChannelConfig, profile: ProviderDefinition): StoredChannel {
  const extras: Options = { ...channel };
  for (const field of PROVIDER_FIELDS) delete extras[field];
  const signature = profile.capabilities.reasoningSignature;
  if (channel.type === 'openai-responses' && signature === 'none' && (channel as any).reasoningSignatureMode === 'codex') extras.reasoningSignatureMode = 'codex';
  if (channel.type === 'openai-responses' && signature === 'deepseek') extras.sendHistoryThoughtSignatures = channel.sendHistoryThoughtSignatures;
  const options: Options = { ...channel.options };
  const enabled: Options = { ...channel.optionsEnabled };
  delete options.stream;
  for (const [key, value] of [['temperature', profile.generation.temperature], [tokenKey(channel.type), profile.generation.maxOutputTokens]] as const) {
    // 关闭时的数值由渠道记住，下次开启时设置页还能显示原值。
    if (value !== undefined) delete options[key];
    delete enabled[key];
  }
  if (profile.generation.reasoningEffort !== undefined) {
    const key = thinkingKey(channel.type);
    options[key] = withoutEffort(channel.type, options[key]);
    // 合成时由 provider 的强度重新开启；provider 清除强度后保持关闭（Gemini 把缺省当作开启）。
    enabled[key] = false;
  }
  extras.options = options; extras.optionsEnabled = enabled;
  const models = (channel.models ?? []).flatMap(({ id, name: _name, ...rest }) => Object.keys(rest).length ? [{ id, ...rest }] : []);
  if (models.length) extras.models = models; else delete extras.models;
  return compact(extras) as StoredChannel;
}

/**
 * 读取已保存的附加选项。旧版本保存的是完整渠道，与 provider 重叠的字段一律以 provider 为准；
 * 新格式经合成再拆分后保持不变。
 */
export function storedChannel(profile: ProviderDefinition, stored?: StoredChannel): StoredChannel {
  return channelExtras(channelView(profile, stored), profile);
}
