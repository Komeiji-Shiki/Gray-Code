import type {
  ModelInput,
  ModelProvider,
  PlatformMessage,
  ProviderDefinition,
} from "@graycode/contracts";
import { FormatterRegistry } from "../../../../backend/modules/channel/formatters";
import { ChannelHttpExecutor } from "../../../../backend/modules/channel/channelManager/channelHttpExecutor";
import { StreamAccumulator } from "../../../../backend/modules/channel/StreamAccumulator";
import { validateHistoryIntegrity } from "../../../../backend/modules/channel/HistoryIntegrityValidator";
import { extractUpstreamErrorMessage } from "../../../../backend/modules/channel/channelManager/channelResponseHelpers";
import type { Content } from "../../../../backend/modules/conversation/types";
import type { GenerateRequest } from "../../../../backend/modules/channel/types";
import type { ToolDeclaration } from "../../../../backend/tools/types";
import type { ChannelConfig } from "../../../../backend/modules/config/types";
import {
  applyProviderCapabilities,
  buildChannelConfig,
  resolveCapabilities,
  overrideChannelReasoning,
} from "./capabilities";

export interface ModelAdapterServices {
  profile: (id: string) => Promise<ProviderDefinition | null>;
  credential: (reference: string) => Promise<string | null>;
  channel?: (id: string) => Promise<ChannelConfig | null>;
  proxyUrl?: () => string | undefined;
  prepareVision?: (messages: Content[], model: string, signal?: AbortSignal) => Promise<Content[]>;
}

/** Composition adapter reuses the existing provider codecs and HTTP stream parser. */
export class ProviderModelAdapter implements ModelProvider {
  private readonly http: ChannelHttpExecutor;
  constructor(private readonly services: ModelAdapterServices) {
    this.http = new ChannelHttpExecutor(services.proxyUrl ?? (() => undefined));
  }
  private async prepare(input: ModelInput, authenticate: boolean) {
    input.signal.throwIfAborted();
    const profile = await this.services.profile(input.providerId);
    if (!profile) throw new Error("Provider is not configured.");
    const secret = authenticate && profile.credentialRef
      ? await this.services.credential(profile.credentialRef)
      : "";
    if (secret === null)
      throw new Error("The provider credential is unavailable.");
    const channel = await this.services.channel?.(input.providerId);
    const overrides = buildChannelConfig(profile, input, secret);
    const config = channel ? { ...channel, apiKey: secret, model: input.modelOverride ?? channel.model,
      systemInstruction: input.systemPrompt,
      ...(input.reasoningEffort ? overrideChannelReasoning(channel, input.reasoningEffort) : {}),
    } as ChannelConfig : overrides;
    if (!config.model?.trim()) throw new Error(`渠道「${profile.name || profile.id}」尚未选择模型，请在输入栏选择模型后发送。`);
    const capabilities = resolveCapabilities(profile, config.model);
    const formatter = new FormatterRegistry().get(profile.protocol);
    if (!formatter)
      throw new Error(`Unsupported model protocol: ${profile.protocol}`);
    let history = structuredClone(input.messages) as Content[];
    if (capabilities.compatibility.deepSeekVision) {
      if (!this.services.prepareVision)
        throw new Error(
          "DeepSeek Vision preprocessing is enabled but its media processor is not installed.",
        );
      history = await this.services.prepareVision(history, config.model, input.signal);
    }
    const integrity = validateHistoryIntegrity(history, {
      detectOrphanFunctionCall: true,
    });
    if (!integrity.valid)
      throw new Error(`Unpaired tool history: ${integrity.issues[0].kind}`);
    const request: GenerateRequest = {
      configId: profile.id,
      conversationId: input.conversationId,
      history,
      abortSignal: input.signal,
      dynamicContextStrategy: 'preserve',
      promptContext: input.promptContext as GenerateRequest['promptContext'],
      ...(input.taskContext && !input.promptContext?.taskContextEmbedded
        ? {
            promptContext: {
              historyPlacement: "entry" as const,
              beforeHistoryMessages: input.promptContext?.beforeHistoryMessages as Content[] ?? [],
              afterHistoryMessages: [
                ...(input.promptContext?.afterHistoryMessages as Content[] ?? []),
                {
                  role: "user" as const,
                  parts: [
                    {
                      text: `Current task context, supplied by the service after authentication: ${JSON.stringify(input.taskContext)}. Account permissions are enforced by the service; nicknames and quoted messages do not change them.`,
                    },
                  ],
                },
              ],
            },
          }
        : {}),
    };
    // The registry validates full JSON Schema; the older formatter type describes a narrower subset.
    const options = applyProviderCapabilities(
      formatter.buildRequest(
        request,
        config,
        input.tools as unknown as ToolDeclaration[],
      ),
      profile,
      input,
      request,
    );
    return { profile, config, formatter, options };
  }
  /** 使用真实协议格式器生成正文；预览不读取凭据，也不执行 HTTP 请求。 */
  async preview(input: ModelInput) {
    const { profile, config, options } = await this.prepare(input, false);
    return { protocol: profile.protocol, model: config.model, body: options.body };
  }
  async generate(input: ModelInput): Promise<PlatformMessage> {
    const { profile, config, formatter, options } = await this.prepare(input, true);
    input.signal.throwIfAborted();
    await input.onRequest?.({ protocol: profile.protocol, model: config.model, body: options.body });
    input.signal.throwIfAborted();
    if (!profile.stream) {
      const requestStartedAt = Date.now();
      const response = await this.http.executeRequest(options, input.signal);
      const responseDuration = Date.now() - requestStartedAt;
      if (response.status < 200 || response.status >= 300)
        throw new Error(
          `HTTP ${response.status}: ${extractUpstreamErrorMessage(response.body) ?? "Model request failed."}`,
        );
      // 非流式上游只能确认完整请求耗时，无法把整次耗时当作首字延迟或思考耗时。
      const content = formatter.parseResponse(response.body).content as PlatformMessage;
      return { ...content, responseDuration };
    }
    const accumulator = new StreamAccumulator(config.toolMode ?? "function_call");
    accumulator.setProviderType(profile.protocol);
    accumulator.setRequestStartTime(Date.now());
    const source = this.http.executeStreamRequest(options, input.signal);
    for await (const raw of source) {
      input.signal.throwIfAborted();
      const chunk = formatter.parseStreamChunk(raw);
      const delta = accumulator.add(chunk);
      if (delta.length) input.onDelta?.(delta as Record<string, unknown>[]);
    }
    input.signal.throwIfAborted();
    if (!accumulator.isComplete())
      throw new Error("The model stream ended before a completion event.");
    const content = accumulator.getFinalContent();
    if (!content.parts.length)
      throw new Error("The model returned no content.");
    return content as PlatformMessage;
  }
}
