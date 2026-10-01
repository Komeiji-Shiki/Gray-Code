import { t } from "../../../../backend/i18n";
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
import { repairDuplicateFunctionResponses } from "../../../../backend/modules/conversation/manager/historyRepair";
import { extractUpstreamErrorMessage } from "../../../../backend/modules/channel/channelManager/channelResponseHelpers";
import type { Content } from "../../../../backend/modules/conversation/types";
import type { GenerateRequest } from "../../../../backend/modules/channel/types";
import type { ToolDeclaration } from "../../../../backend/tools/types";
import type { ChannelConfig } from "../../../../backend/modules/config/types";
import { modelRequestMetrics } from './requestMetrics';
import { ResponsesWebSocket } from './responsesWebSocket';
import { CHATGPT_API_BASE_URL, chatgptHeaders, normalizeChatGPTBody } from '../../../../backend/modules/channel/chatgpt';
import {
  applyProviderCapabilities,
  buildChannelConfig,
  resolveCapabilities,
  overrideChannelReasoning,
} from "./capabilities";

export interface ModelAdapterServices {
  profile: (id: string) => Promise<ProviderDefinition | null>;
  credential: (reference: string) => Promise<string | null>;
  chatgpt?: (providerId: string, signal: AbortSignal) => Promise<{ token: string; identity: string }>;
  channel?: (id: string) => Promise<ChannelConfig | null>;
  proxyUrl?: () => string | undefined;
  prepareVision?: (messages: Content[], model: string, signal?: AbortSignal) => Promise<Content[]>;
}

/** Composition adapter reuses the existing provider codecs and HTTP stream parser. */
export class ProviderModelAdapter implements ModelProvider {
  private readonly http: ChannelHttpExecutor;
  private readonly sockets = new Map<string, { socket: ResponsesWebSocket; formatInput: (messages: PlatformMessage[]) => any[] }>();
  private readonly runIdentities = new Map<string, string>();
  hasContinuation(runId: string): boolean { return this.sockets.get(runId)?.socket.hasContinuation() ?? false; }
  endRun(runId: string): void { this.sockets.get(runId)?.socket.close(); this.sockets.delete(runId); this.runIdentities.delete(runId); }
  async steer(runId: string, message: PlatformMessage): Promise<boolean> {
    const session = this.sockets.get(runId);
    return session && message.id ? session.socket.steer(message.id, session.formatInput([message])) : false;
  }
  constructor(private readonly services: ModelAdapterServices) {
    this.http = new ChannelHttpExecutor(services.proxyUrl ?? (() => undefined));
  }
  async supportsAsyncTools(input: ModelInput): Promise<boolean> {
    if (!input.runId || input.purpose) return false;
    const profile = await this.services.profile(input.providerId);
    if (!profile || profile.protocol !== 'openai-responses') return false;
    const channel = await this.services.channel?.(input.providerId);
    const capabilities = resolveCapabilities(profile, input.modelOverride ?? profile.model);
    const enabled = channel ? (channel as any).responsesAsyncToolsEnabled === true : capabilities.responsesAsyncTools === true;
    const websocket = channel ? (channel as any).responsesWebSocketEnabled === true : capabilities.responsesWebSocket === true;
    return enabled && (profile.stream || profile.authMode === 'chatgpt' || websocket);
  }
  private async prepare(input: ModelInput, authenticate: boolean) {
    input.signal.throwIfAborted();
    let profile = await this.services.profile(input.providerId);
    if (!profile) throw new Error("Provider is not configured.");
    if(input.maxOutputTokens!==undefined){
      if(!Number.isSafeInteger(input.maxOutputTokens)||input.maxOutputTokens<1)throw new Error('请求输出预算无效。');
      profile={...profile,generation:{...profile.generation,maxOutputTokens:input.maxOutputTokens}};
    }
    const subscription = profile.authMode === 'chatgpt';
    if (subscription) profile = { ...profile, stream: true, endpoint: CHATGPT_API_BASE_URL };
    if (authenticate && subscription && !this.services.chatgpt) throw new Error(t('modules.chatgpt.unsupportedHost'));
    const subscriptionCredential = authenticate && subscription ? await this.services.chatgpt!(profile.id, input.signal) : undefined;
    const secret = subscriptionCredential ? subscriptionCredential.token : authenticate && profile.credentialRef
      ? await this.services.credential(profile.credentialRef)
      : "";
    if (secret === null)
      throw new Error("The provider credential is unavailable.");
    const channel = await this.services.channel?.(input.providerId);
    const overrides = buildChannelConfig(profile, input, secret);
    const config = channel ? { ...channel, apiKey: secret, model: input.modelOverride ?? channel.model,
      systemInstruction: input.systemPrompt,
      ...(input.reasoningEffort ? overrideChannelReasoning(channel, input.reasoningEffort) : {}),
      ...(input.maxOutputTokens!==undefined?{options:{...channel.options,max_tokens:input.maxOutputTokens,max_output_tokens:input.maxOutputTokens,maxOutputTokens:input.maxOutputTokens},
        optionsEnabled:{...channel.optionsEnabled,max_tokens:true,max_output_tokens:true,maxOutputTokens:true}}:{}),
    } as ChannelConfig : overrides;
    if (config.type === 'openai-responses' && subscription) config.authMode = 'chatgpt';
    if (!config.model?.trim()) throw new Error(`渠道「${profile.name || profile.id}」尚未选择模型，请在输入栏选择模型后发送。`);
    const capabilities = resolveCapabilities(profile, config.model);
    const formatter = new FormatterRegistry().get(profile.protocol);
    if (!formatter)
      throw new Error(`Unsupported model protocol: ${profile.protocol}`);
    let history = (structuredClone(input.messages) as Content[]).flatMap(message => {
      if (message.role !== 'model' || !message.incompleteReason) return [message];
      // 部分思考保存在历史中供用户查看，但没有完整供应方签名，不能作为下一次请求的有效思考块。
      const parts = message.parts.flatMap(part => part.functionCall && part.functionCall.async === true
        ? [part] : !part.thought && typeof part.text === 'string' ? [{ text: part.text }] : []);
      return parts.length ? [{ ...message, parts }] : [];
    });
    if (capabilities.compatibility.deepSeekVision) {
      if (!this.services.prepareVision)
        throw new Error(
          "DeepSeek Vision preprocessing is enabled but its media processor is not installed.",
        );
      history = await this.services.prepareVision(history, config.model, input.signal);
    }
    // 发送前自愈：历史里同一工具调用的重复响应（读取补齐占位与迟到的真实结果并存）会让请求
    // 被完整性校验拒绝。这里在只影响本次请求的副本上清理，保证请求可用；存储由对话读取路径修复。
    const repairedHistory = repairDuplicateFunctionResponses(history);
    if (repairedHistory.changed) history = repairedHistory.history;
    const nativeAsync = profile.protocol === 'openai-responses' && (config as any).responsesAsyncToolsEnabled === true
      && (profile.stream || (config as any).responsesWebSocketEnabled === true && !!input.runId && !input.purpose);
    if (input.pendingToolCallIds?.length && !nativeAsync) throw new Error('当前渠道不支持待完成的原生异步调用，请等待原任务结算后再切换渠道。');
    const integrity = validateHistoryIntegrity(history, {
      detectOrphanFunctionCall: true,
      ...(nativeAsync ? { pendingAsyncCallIds: new Set(input.pendingToolCallIds ?? []) } : {}),
    });
    if (!integrity.valid)
      throw new Error(`Unpaired tool history: ${integrity.issues[0].kind}`);
    const request: GenerateRequest = {
      configId: profile.id,
      conversationId: input.conversationId,
      history,
      abortSignal: input.signal,
      dynamicContextStrategy: 'preserve',
      // 身份数据留在服务端运行上下文中；请求只携带提示词服务明确组装的消息。
      promptContext: input.promptContext as GenerateRequest['promptContext'],
    };
    // The registry validates full JSON Schema; the older formatter type describes a narrower subset.
    const options = applyProviderCapabilities(
      formatter.buildRequest(
        request,
        config,
        input.tools.map(tool => ({ ...tool, async: profile.protocol === 'openai-responses'
          && (config as any).responsesAsyncToolsEnabled === true && !!input.onToolCallReady && tool.async === true
          && (profile.stream || (config as any).responsesWebSocketEnabled === true && !!input.runId && !input.purpose)
          ? true : undefined })) as unknown as ToolDeclaration[],
      ),
      profile,
      input,
      request,
    );
    // 内部整理的预算最后应用，不能被渠道中的自定义正文悄悄放大。
    if(input.maxOutputTokens!==undefined){
      const body=options.body as Record<string,any>,limit=input.maxOutputTokens;
      if(profile.protocol==='gemini')body.generationConfig={...body.generationConfig,maxOutputTokens:limit};
      else if(profile.protocol==='gemini-interactions')body.generation_config={...body.generation_config,max_output_tokens:limit};
      else{
        const field=capabilities.outputTokenParameter!=='protocol_default'?capabilities.outputTokenParameter:profile.protocol==='openai-responses'?'max_output_tokens':'max_tokens';
        for(const name of ['max_tokens','max_completion_tokens','max_output_tokens'])delete body[name];
        body[field]=limit;
      }
    }
    // 能力覆盖和内部输出预算晚于格式器；订阅参数在最终请求边界统一收敛。
    if (subscription) {
      options.body = normalizeChatGPTBody(options.body);
      options.headers = chatgptHeaders(options.headers ?? {}, secret ?? '', options.body?.prompt_cache_key, input.conversationId);
      options.url = `${CHATGPT_API_BASE_URL}/responses`;
      options.stream = true;
    }
    return { profile, config, formatter, options, credentialIdentity: subscriptionCredential?.identity };
  }
  /** 使用真实协议格式器生成正文；预览不读取凭据，也不执行 HTTP 请求。 */
  async preview(input: ModelInput) {
    const { profile, config, options } = await this.prepare(input, false);
    return { protocol: profile.protocol, model: config.model, body: options.body };
  }
  async generate(input: ModelInput): Promise<PlatformMessage> {
    const { profile, config, formatter, options, credentialIdentity } = await this.prepare(input, true);
    input.signal.throwIfAborted();
    // 密文与原生调用会跨多次请求回放。两种传输都固定本任务的认证身份，订阅只比较账号，允许同账号令牌刷新。
    const identity = credentialIdentity ? JSON.stringify([options.url, options.body?.model, credentialIdentity,
      Object.fromEntries(Object.entries(options.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'))])
      : ResponsesWebSocket.identity(options);
    if (profile.protocol === 'openai-responses' && input.runId && !input.purpose) {
      const previous = this.runIdentities.get(input.runId);
      if (previous !== undefined && previous !== identity) throw new Error('当前任务的账户、端点或模型已经变化，请结束当前任务后使用新设置继续，避免混用原生调用与旧推理状态。');
      this.runIdentities.set(input.runId, identity);
    }
    const native = profile.protocol === 'openai-responses' && (config as any).responsesWebSocketEnabled === true && input.runId && !input.purpose;
    let socket: ResponsesWebSocket | undefined;
    let source: AsyncIterable<any> | undefined;
    const capture = async (body: any) => { await input.onRequest?.({ protocol: profile.protocol, model: config.model, body, metrics: modelRequestMetrics(body) }); };
    if (native) {
      socket = this.sockets.get(input.runId!)?.socket ?? await ResponsesWebSocket.connect(options, this.services.proxyUrl?.(), input.signal);
      const formatInput = (messages: PlatformMessage[]) => formatter.buildRequest({ configId: config.id, conversationId: input.conversationId,
        history: messages as Content[], dynamicContextStrategy: 'preserve', skipTools: true }, config).body.input;
      this.sockets.set(input.runId!, { socket, formatInput });
      const context = socket.context(input.messages, input.promptContext);
      source = socket.response((messages, full) => ({ ...options.body, input: full ? options.body.input : formatInput(messages) }), input.messages, context.full, capture);
    } else {
      await capture(options.body);
    }
    input.signal.throwIfAborted();
    if (!profile.stream && !native) {
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
    source ??= this.http.executeStreamRequest(options, input.signal);
    const issued = new Set<string>();
    let blocked = false;
    const asyncNames = new Set((options.body.tools ?? []).flatMap((tool: any) => tool.type === 'namespace' ? tool.tools ?? [] : [tool])
      .filter((tool: any) => tool.async === true).map((tool: any) => tool.name));
    const dispatch = (item: any) => {
      if (item?.type !== 'function_call' || issued.has(item.call_id)) return;
      if (blocked || item.async !== true || !asyncNames.has(item.name)) { blocked = true; return; }
      const call = formatter.parseResponse({ output: [item] }).content.parts[0]?.functionCall;
      if (call?.id && input.onToolCallReady?.({ id: call.id, name: call.name, args: call.args, async: true,
        ...(typeof call.namespace === 'string' ? { namespace: call.namespace } : {}) })) issued.add(call.id);
      else blocked = true;
    };
    for await (const raw of source) {
      input.signal.throwIfAborted();
      if (profile.protocol === 'openai-responses') {
        if (raw.type === 'response.output_item.added' && raw.item?.type === 'function_call'
          && (raw.item.async !== true || !asyncNames.has(raw.item.name))) blocked = true;
        if (raw.type === 'response.output_item.done') dispatch(raw.item);
        if (['response.completed', 'response.incomplete'].includes(raw.type)) for (const item of raw.response?.output ?? []) dispatch(item);
      }
      const chunk = formatter.parseStreamChunk(raw);
      const delta = accumulator.add(chunk);
      if (delta.length) input.onDelta?.(delta as Record<string, unknown>[]);
    }
    input.signal.throwIfAborted();
    if (!accumulator.isComplete())
      throw new Error("The model stream ended before a completion event.");
    const content = accumulator.getFinalContent();
    if (!content.parts.length && !socket?.hasContinuation())
      throw new Error("The model returned no content.");
    return { ...content, ...(socket ? { nativeResponse: socket.reference() } : {}) } as PlatformMessage;
  }
}
