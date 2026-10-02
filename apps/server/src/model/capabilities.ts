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
  const capabilities: ProviderCapabilities = {
    ...profile.capabilities,
    ...override,
    compatibility: {
      ...profile.capabilities.compatibility,
      ...override?.compatibility,
    },
  };
  // 订阅认证的协议能力固定，兼容渠道遗留选项不能改变官方请求。
  return profile.authMode === 'chatgpt' ? {
    ...capabilities,
    reasoningSignature: 'codex',
    compatibility: { ...capabilities.compatibility, openCodeSession: false, deepSeekVision: false },
  } : capabilities;
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
    // plain reasoning_text 回传，因此 Responses 协议默认回传历史思考；其余协议仍按签名能力判断。
    sendHistoryThoughts: profile.protocol === "openai-responses" || capability.reasoningSignature === "deepseek",
    sendHistoryThoughtSignatures: capability.reasoningSignature !== "none",
    sendCurrentThoughts: true,
    reasoningSignatureMode:
      capability.reasoningSignature === "codex"
        ? "codex"
        : capability.reasoningSignature === "deepseek"
          ? "deepseek"
          : "official",
    responsesWebSocketEnabled: capability.responsesWebSocket === true,
    responsesAsyncToolsEnabled: capability.responsesAsyncTools === true,
    deepSeekUserIdEnabled: capability.compatibility.deepSeekUserId,
    deepSeekVisionEnabled: capability.compatibility.deepSeekVision,
    openCodeSessionEnabled: capability.compatibility.openCodeSession,
    pdfAttachmentEnabled: capability.compatibility.nativePdf,
    // 桌面与 Web 版默认启用多模态工具：渠道设置不再提供该开关，工具图片与文档随结果发送。
    multimodalToolsEnabled: true,
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

/** 返回去掉字段后的副本；字段不存在或不是对象时保持原引用，与原地 delete 的可见效果一致。 */
function withoutField(value: any, field: string): any {
  if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, field)) return value;
  const copy = Array.isArray(value) ? [...value] : { ...value };
  delete copy[field];
  return copy;
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
  // 写时复制：格式器正文可能与历史、工具声明或渠道选项共享嵌套对象，只复制实际修改的路径；
  // 未修改的消息与图片继续共享引用。替换已有字段时用展开覆盖，键顺序与原先深复制后原地修改一致，
  // 序列化结果逐字节不变。后续步骤只在这里新建的顶层正文上增删字段。
  const body = { ...options.body } as Record<string, any>;
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
    if (body.reasoning) body.reasoning = withoutField(body.reasoning, "effort");
    if (body.output_config) body.output_config = withoutField(body.output_config, "effort");
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
    const strict = capabilities.strictTools === "enabled";
    body.tools = body.tools.map((tool: any) => {
      if (tool.type !== "function") return tool;
      const source = tool.function ?? tool;
      const definition = { ...source, strict };
      if (strict && definition.parameters)
        definition.parameters = ensureStrictSchema(definition.parameters, true);
      return tool.function != null ? { ...tool, function: definition } : definition;
    });
  }
  const headers = { ...options.headers, ...profile.customHeaders };
  return applyOpenCodeSessionHeader(
    { ...options, body: { ...body, ...profile.customBody }, headers },
    request,
    { openCodeSessionEnabled: capabilities.compatibility.openCodeSession },
  );
}
