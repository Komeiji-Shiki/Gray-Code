import type {
  ProviderCapabilities,
  ProviderDefinition,
  ModelInput,
} from "@graycode/contracts";
import type { ChannelConfig } from "../../../../backend/modules/config/types";
import type {
  HttpRequestOptions,
  GenerateRequest,
} from "../../../../backend/modules/channel/types";
import { applyOpenCodeSessionHeader } from "../../../../backend/modules/channel/opencodeSession";
import { ensureStrictSchema } from "../../../../backend/modules/channel/formatters/base";
import { reasoningLevelsForModel } from '../../../../shared/reasoningEffort';

export function resolveCapabilities(
  profile: ProviderDefinition,
  model: string,
): ProviderCapabilities {
  const override = profile.models.find(
    (value) => value.id === model,
  )?.capabilities;
  return {
    ...profile.capabilities,
    ...override,
    compatibility: {
      ...profile.capabilities.compatibility,
      ...override?.compatibility,
    },
  };
}

/** Reuse the tested formatters, translating the new capability profile in one place. */
export function buildChannelConfig(
  profile: ProviderDefinition,
  input: ModelInput,
  apiKey: string,
): ChannelConfig {
  const model = input.modelOverride ?? profile.model;
  const capability = resolveCapabilities(profile, model);
  const effort = input.reasoningEffort ?? profile.generation.reasoningEffort;
  if (
    effort &&
    (!reasoningLevelsForModel(profile, model).includes(effort) ||
      capability.reasoningParameter === "disabled")
  )
    throw new Error(
      `Reasoning effort is not enabled for this model: ${effort}`,
    );
  const tokenLimit = profile.generation.maxOutputTokens;
  const temperature = profile.generation.temperature;
  const options: Record<string, unknown> = {
    stream: profile.stream,
    temperature,
    max_tokens: tokenLimit,
    max_output_tokens: tokenLimit,
    maxOutputTokens: tokenLimit,
    ...(effort
      ? {
          reasoning: { effort },
          thinking: { type: "adaptive", effort },
          thinkingConfig: {
            mode: "level",
            thinkingLevel: effort,
            includeThoughts: true,
          },
        }
      : {}),
  };
  const optionsEnabled = {
    temperature: temperature !== undefined,
    max_tokens: tokenLimit !== undefined,
    max_output_tokens: tokenLimit !== undefined,
    maxOutputTokens: tokenLimit !== undefined,
    reasoning: !!effort,
    thinking: !!effort,
    thinkingConfig: !!effort,
  };
  return {
    id: profile.id,
    name: profile.name,
    type: profile.protocol,
    enabled: true,
    url: profile.endpoint,
    model,
    apiKey,
    createdAt: 0,
    updatedAt: 0,
    systemInstruction: input.systemPrompt,
    timeout: profile.timeoutMs,
    toolMode: "function_call",
    options,
    optionsEnabled,
    // reasoning item 是 Responses 协议的标准输入形态，官方 GPT 与 DeepSeek 端点都接受
    // plain reasoning_text 回传，因此 Responses 默认回传；其余协议仍按签名能力判断。
    sendHistoryThoughts: capability.reasoningSignature === "deepseek",
    sendHistoryThoughtSignatures: capability.reasoningSignature !== "none",
    sendCurrentThoughts: true,
    reasoningSignatureMode:
      capability.reasoningSignature === "codex" ? "codex" : "official",
    deepSeekUserIdEnabled: capability.compatibility.deepSeekUserId,
    deepSeekVisionEnabled: capability.compatibility.deepSeekVision,
    openCodeSessionEnabled: capability.compatibility.openCodeSession,
    pdfAttachmentEnabled: capability.compatibility.nativePdf,
    // Explicitly supplied capabilities override model-name inference in Responses replay.
    providerReasoningContentEnabled:
      capability.reasoningSignature === "deepseek",
  } as unknown as ChannelConfig;
}

/** 临时档位只覆盖对应协议的思考字段，保留摘要、预算和其他生成参数。 */
export function overrideChannelReasoning(channel: ChannelConfig, effort: string): Pick<ChannelConfig, 'options' | 'optionsEnabled'> {
  const options = channel.options as Record<string, any>;
  const key = channel.type.startsWith('gemini') ? 'thinkingConfig' : channel.type === 'anthropic' ? 'thinking' : 'reasoning';
  const thinking = key === 'thinkingConfig' ? { ...options?.thinkingConfig, mode: 'level', thinkingLevel: effort }
    : key === 'thinking' ? { ...options?.thinking, type: options?.thinking?.type === 'enabled' ? 'enabled' : 'adaptive', effort }
      : { ...options?.reasoning, effort };
  return { options: { ...channel.options, [key]: thinking }, optionsEnabled: { ...channel.optionsEnabled, [key]: true } };
}

export function applyProviderCapabilities(
  options: HttpRequestOptions,
  profile: ProviderDefinition,
  input: ModelInput,
  request: GenerateRequest,
): HttpRequestOptions {
  const capabilities = resolveCapabilities(
    profile,
    input.modelOverride ?? profile.model,
  );
  const body = structuredClone(options.body) as Record<string, any>;
  const limit = profile.generation.maxOutputTokens;
  if (
    capabilities.outputTokenParameter !== "protocol_default" &&
    limit !== undefined
  ) {
    for (const field of [
      "max_tokens",
      "max_completion_tokens",
      "max_output_tokens",
    ])
      delete body[field];
    body[capabilities.outputTokenParameter] = limit;
  }
  const effort = input.reasoningEffort ?? profile.generation.reasoningEffort;
  if (capabilities.reasoningParameter !== "protocol_default") {
    delete body.reasoning_effort;
    if (body.reasoning) delete body.reasoning.effort;
    if (body.output_config) delete body.output_config.effort;
    if (effort && capabilities.reasoningParameter !== "disabled") {
      const field = capabilities.reasoningParameter;
      if (field === "reasoning_effort") body.reasoning_effort = effort;
      else if (field === "reasoning.effort")
        body.reasoning = { ...body.reasoning, effort };
      else if (field === "output_config.effort")
        body.output_config = { ...body.output_config, effort };
      else if (profile.protocol === "gemini")
        body.generationConfig = {
          ...body.generationConfig,
          thinkingConfig: {
            ...body.generationConfig?.thinkingConfig,
            thinkingLevel: effort,
          },
        };
    }
  }
  if (
    Array.isArray(body.tools) &&
    capabilities.strictTools !== "protocol_default"
  ) {
    for (const tool of body.tools) {
      if (tool.type !== "function") continue;
      const definition = tool.function ?? tool;
      definition.strict = capabilities.strictTools === "enabled";
      if (definition.strict && definition.parameters)
        definition.parameters = ensureStrictSchema(definition.parameters, true);
    }
  }
  const headers = { ...options.headers, ...profile.customHeaders };
  return applyOpenCodeSessionHeader(
    { ...options, body: { ...body, ...profile.customBody }, headers },
    request,
    { openCodeSessionEnabled: capabilities.compatibility.openCodeSession },
  );
}
