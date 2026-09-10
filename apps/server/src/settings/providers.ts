import type { ProviderDefinition } from '@graycode/contracts';
import type { ChannelConfig } from '../../../../backend/modules/config/types';
import { buildChannelConfig } from '../model/capabilities';

type Options = Record<string, any>;

/** Basic fields belong to the provider document; preserve advanced legacy fields in its projection. */
export function projectChannels(profiles: ProviderDefinition[], channels: ChannelConfig[], previous: ProviderDefinition[]): ChannelConfig[] {
  return profiles.map(profile => {
    const old = channels.find(channel => channel.id === profile.id && channel.type === profile.protocol);
    const before = previous.find(item => item.id === profile.id);
    const defaults = buildChannelConfig({ ...profile, generation: { ...profile.generation, reasoningEffort: undefined } },
      { conversationId: '', providerId: profile.id, systemPrompt: '', messages: [], tools: [], signal: new AbortController().signal }, '');
    const channel = { ...defaults, ...old, id: profile.id, name: profile.name, type: profile.protocol,
      url: profile.endpoint, model: profile.model, timeout: profile.timeoutMs, preferStream: profile.stream, apiKey: '',
      models: profile.models.map(model => ({ ...old?.models?.find(item => item.id === model.id), id: model.id, name: model.name ?? model.id })),
    } as ChannelConfig;
    const options: Options = { ...channel.options };
    const enabled: Record<string, boolean> = { ...channel.optionsEnabled };
    for (const [key, value, changed] of [
      ['temperature', profile.generation.temperature, before?.generation.temperature !== profile.generation.temperature],
      [profile.protocol.startsWith('gemini') ? 'maxOutputTokens' : profile.protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens',
        profile.generation.maxOutputTokens, before?.generation.maxOutputTokens !== profile.generation.maxOutputTokens],
    ] as const) if (!old || changed) { options[key] = value; enabled[key] = value !== undefined; }
    if (!old || before?.generation.reasoningEffort !== profile.generation.reasoningEffort) {
      const effort = profile.generation.reasoningEffort;
      // Keep protocol-specific thought controls; only project the shared effort field.
      if (profile.protocol.startsWith('gemini')) {
        options.thinkingConfig = { ...options.thinkingConfig, mode: 'level', thinkingLevel: effort };
        enabled.thinkingConfig = effort !== undefined;
      } else if (profile.protocol === 'anthropic') {
        options.thinking = { ...options.thinking, effort };
        if (effort !== undefined) { options.thinking.type ??= 'adaptive'; enabled.thinking = true; }
      } else {
        options.reasoning = { ...options.reasoning, effort };
        enabled.reasoning = effort !== undefined;
      }
    }
    channel.options = options; channel.optionsEnabled = enabled;
    if (!old || JSON.stringify(before?.capabilities) !== JSON.stringify(profile.capabilities)) {
      const caps = profile.capabilities;
      Object.assign(channel, { openCodeSessionEnabled: caps.compatibility.openCodeSession,
        deepSeekUserIdEnabled: caps.compatibility.deepSeekUserId, deepSeekVisionEnabled: caps.compatibility.deepSeekVision,
        pdfAttachmentEnabled: caps.compatibility.nativePdf, sendHistoryThoughtSignatures: caps.reasoningSignature !== 'none',
        reasoningSignatureMode: caps.reasoningSignature === 'codex' ? 'codex' : 'official',
        providerReasoningContentEnabled: caps.reasoningSignature === 'deepseek',
        ...(caps.strictTools !== 'protocol_default' ? { strictToolsEnabled: caps.strictTools === 'enabled' } : {}),
      });
    }
    return channel;
  });
}

export function channelProfile(channel: ChannelConfig, previous?: ProviderDefinition, credentialRef?: string): ProviderDefinition {
  const options: Options = channel.options ?? {};
  const enabled = (channel.optionsEnabled ?? {}) as Record<string, boolean | undefined>;
  const tokenKey = channel.type.startsWith('gemini') ? 'maxOutputTokens' : channel.type === 'openai-responses' ? 'max_output_tokens' : 'max_tokens';
  return {
    ...previous,
    id: channel.id, name: channel.name, protocol: channel.type, endpoint: channel.url, model: channel.model ?? '',
    models: (channel.models ?? []).map(model => ({ id: model.id, name: model.name, capabilities: previous?.models.find(item => item.id === model.id)?.capabilities })),
    credentialRef, stream: channel.preferStream !== false, timeoutMs: channel.timeout ?? previous?.timeoutMs ?? 120_000,
    generation: { ...previous?.generation,
      ...(previous?.generation.reasoningEffort !== undefined ? { reasoningEffort: channel.type.startsWith('gemini')
        ? enabled.thinkingConfig ? options.thinkingConfig?.thinkingLevel : undefined
        : channel.type === 'anthropic' ? enabled.thinking ? options.thinking?.effort : undefined
        : enabled.reasoning ? (options.reasoning?.effort === 'custom' ? options.reasoning?.effortCustom : options.reasoning?.effort) : undefined } : {}),
      temperature: enabled.temperature ? options.temperature : undefined,
      maxOutputTokens: enabled[tokenKey] ? options[tokenKey] : undefined },
    capabilities: {
      outputTokenParameter: 'protocol_default', reasoningParameter: 'protocol_default', reasoningLevels: [],
      reasoningSignature: channel.sendHistoryThoughtSignatures === false ? 'none' : 'native',
      ...previous?.capabilities,
      strictTools: channel.strictToolsEnabled === undefined ? previous?.capabilities.strictTools ?? 'protocol_default' : channel.strictToolsEnabled ? 'enabled' : 'disabled',
      compatibility: { openCodeSession: channel.openCodeSessionEnabled === true,
        deepSeekUserId: (channel as any).deepSeekUserIdEnabled === true, deepSeekVision: (channel as any).deepSeekVisionEnabled === true,
        nativePdf: (channel as any).pdfAttachmentEnabled === true },
    },
  };
}
