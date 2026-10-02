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
import { extractUpstreamErrorMessage, partHasContent } from "../../../../backend/modules/channel/channelManager/channelResponseHelpers";
import { ChannelError, ErrorType } from "../../../../backend/modules/channel/types";
import { isRetryableError } from "../../../../backend/core/errors";
import { isPermanentModelFailure, isTransientRateLimit, modelRetryInterval, retryAfterMilliseconds } from '../../../../backend/core/modelRetry';
import { createHash } from 'node:crypto';
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

/** 正文、工具调用或附件才算可用输出；只有思考的回复不能推进任务。 */
const visiblePart = (part: Record<string, unknown>) => !part.thought && partHasContent(part);
/** 单次请求已经产生的外部可见状态，决定失败后能否安全地重新请求。 */
interface AttemptState { visible: boolean; issued: number }

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

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
  private readonly rateLimits = new Map<string, number>();
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
    // 不再深复制完整历史：视觉预处理、重复响应修复与格式器都按写时复制产生新对象（Responses WebSocket
    // 的增量输入一直直接格式化原消息），这里的 flatMap 也只为中断消息新建对象。冻结输入的请求稳定性测试
    // 守护这一前提；若以后有步骤需要原地修改历史，应在该步骤内部复制，而不是恢复整份深复制。
    let history = (input.messages as Content[]).flatMap(message => {
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
    const rateLimitKey = createHash('sha256').update(JSON.stringify([new URL(options.url).origin, subscriptionCredential?.identity ?? Object.entries(options.headers ?? {})
      .filter(([key]) => ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'chatgpt-account-id'].includes(key.toLowerCase()))
      .sort(([left], [right]) => left.localeCompare(right)), new URL(options.url).searchParams.get('key')])).digest('hex');
    return { profile, config, formatter, options, rateLimitKey, credentialIdentity: subscriptionCredential?.identity };
  }
  /** 使用真实协议格式器生成正文；预览不读取凭据，也不执行 HTTP 请求。 */
  async preview(input: ModelInput) {
    const { profile, config, options } = await this.prepare(input, false);
    return { protocol: profile.protocol, model: config.model, body: options.body };
  }
  async generate(input: ModelInput): Promise<PlatformMessage> {
    const prepared = await this.prepare(input, true);
    const { profile, config, formatter, options, credentialIdentity } = prepared;
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
    let captured: Promise<void> | undefined;
    if (native) {
      await this.waitRateLimit(prepared.rateLimitKey, input.signal);
      try { socket = this.sockets.get(input.runId!)?.socket ?? await ResponsesWebSocket.connect(options, this.services.proxyUrl?.(), input.signal); }
      catch (error) {
        if (isTransientRateLimit(error) && error instanceof Error) {
          const retry = config as ChannelConfig & { retryEnabled?: boolean; retryCount?: number; retryInterval?: number };
          const delayMs = modelRetryInterval(error, 0, retry.retryInterval ?? 3000);
          this.rateLimits.set(prepared.rateLimitKey, Math.max(this.rateLimits.get(prepared.rateLimitKey) ?? 0, Date.now() + delayMs));
          Object.assign(error, { modelRetry: { kind: 'rate_limit', resumeSafe: true,
            remainingRetries: this.services.channel && retry.retryEnabled !== false ? Math.min(retry.retryCount ?? 3, input.retryCount ?? Infinity) : 0,
            delayMs } });
        }
        throw error;
      }
      const formatInput = (messages: PlatformMessage[]) => formatter.buildRequest({ configId: config.id, conversationId: input.conversationId,
        history: messages as Content[], dynamicContextStrategy: 'preserve', skipTools: true }, config).body.input;
      this.sockets.set(input.runId!, { socket, formatInput });
      const context = socket.context(input.messages, input.promptContext);
      source = socket.response((messages, full) => ({ ...options.body, input: full ? options.body.input : formatInput(messages) }), input.messages, context.full, capture);
    } else {
      // 长会话的请求快照很大，写入与上游请求并行；返回前仍等待它完成，写入失败照常让本次生成失败。
      captured = capture(options.body);
      void captured.catch(() => undefined);
    }
    try {
      const content = await this.receiveWithRetry(input, prepared, !!native, socket, source);
      await captured;
      return content;
    } catch (error) {
      await captured?.catch(() => undefined);
      throw error;
    }
  }
  /**
   * 按渠道的自动重试设置重新请求。已经显示正文或工具调用、已经交出原生异步调用、使用原生连接或用户取消时
   * 不重试：重新请求会重复已显示的内容或重复执行工具。只显示了思考的空回复可以重试，并通过 onRetry
   * 通知运行器丢弃这次思考。请求快照只在第一次尝试时记录。
   */
  private async waitRateLimit(key: string, signal: AbortSignal): Promise<void> {
    // 同一账户的 HTTP 与原生连接共用冷却期限；期间延长的期限也要继续等待。
    for (;;) {
      const until = this.rateLimits.get(key);
      if (!until) return;
      if (until > Date.now()) await retryDelay(until - Date.now(), signal);
      if (this.rateLimits.get(key) === until) { this.rateLimits.delete(key); return; }
    }
  }
  private async receiveWithRetry(input: ModelInput, prepared: Awaited<ReturnType<ProviderModelAdapter['prepare']>>,
    native: boolean, socket: ResponsesWebSocket | undefined, source: AsyncIterable<any> | undefined): Promise<PlatformMessage> {
    const config = prepared.config as ChannelConfig & { retryEnabled?: boolean; retryCount?: number; retryInterval?: number };
    // 没有渠道配置的调用（内部快捷配置）不启用重试。
    const configured = !!this.services.channel && config.retryEnabled !== false;
    const configuredRetries = configured ? Math.max(0, Math.floor(Number(config.retryCount ?? 3)) || 0) : 0;
    const retryBudget = Math.min(configuredRetries, input.retryCount ?? configuredRetries);
    const maxRetries = native ? 0 : retryBudget;
    const interval = Math.max(0, Number(config.retryInterval ?? 3000) || 0);
    const limitKey = prepared.rateLimitKey;
    for (let attempt = 0; ; attempt++) {
      const state: AttemptState = { visible: false, issued: 0 };
      try {
        await this.waitRateLimit(limitKey, input.signal);
        return await this.receive(input, prepared, native, socket, attempt === 0 ? source : undefined, state);
      } catch (error) {
        const limited = isTransientRateLimit(error);
        const delay = modelRetryInterval(error, attempt, interval);
        if (limited) this.rateLimits.set(limitKey, Math.max(this.rateLimits.get(limitKey) ?? 0, Date.now() + delay));
        if (limited && error instanceof Error) Object.assign(error, { modelRetry: { kind: 'rate_limit',
          remainingRetries: retryBudget - attempt, resumeSafe: state.issued === 0, delayMs: delay } });
        const retryable = error instanceof ChannelError && isRetryableError(error.type) && !isPermanentModelFailure(error);
        if (!retryable || attempt >= maxRetries || input.signal.aborted || state.visible || state.issued > 0) throw error;
        input.onRetry?.({ attempt: attempt + 1, maxAttempts: maxRetries, error: error.message, nextRetryIn: delay });
        if (!limited) await retryDelay(delay, input.signal);
      }
    }
  }
  private async receive(input: ModelInput, { profile, config, formatter, options }: Awaited<ReturnType<ProviderModelAdapter['prepare']>>,
    native: boolean, socket: ResponsesWebSocket | undefined, source: AsyncIterable<any> | undefined,
    state: AttemptState = { visible: false, issued: 0 }): Promise<PlatformMessage> {
    input.signal.throwIfAborted();
    if (!profile.stream && !native) {
      const requestStartedAt = Date.now();
      const response = await this.http.executeRequest(options, input.signal);
      const responseDuration = Date.now() - requestStartedAt;
      if (response.status < 200 || response.status >= 300) {
        const error = new ChannelError(ErrorType.API_ERROR,
          `HTTP ${response.status}: ${extractUpstreamErrorMessage(response.body) ?? "Model request failed."}`, response.body);
        error.httpStatus = response.status; error.retryAfterMs = retryAfterMilliseconds(response.headers['retry-after']);
        throw error;
      }
      // 非流式上游只能确认完整请求耗时，无法把整次耗时当作首字延迟或思考耗时。
      const content = formatter.parseResponse(response.body).content as PlatformMessage;
      if (!content.parts.some(part => visiblePart(part)))
        throw new ChannelError(ErrorType.EMPTY_RESPONSE_ERROR, t('modules.channel.errors.emptyResponse'));
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
        ...(typeof call.namespace === 'string' ? { namespace: call.namespace } : {}) })) { issued.add(call.id); state.issued = issued.size; }
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
      if (delta.length) {
        if (delta.some(part => visiblePart(part as Record<string, unknown>))) state.visible = true;
        input.onDelta?.(delta as Record<string, unknown>[]);
      }
    }
    input.signal.throwIfAborted();
    const content = accumulator.getFinalContent();
    const visible = content.parts.some(part => visiblePart(part as Record<string, unknown>));
    if (!accumulator.isComplete()) {
      // 没有任何可用输出就断开，等同于空回复，可以重试；已经显示正文或工具调用时只报告截断。
      if (!visible && !state.issued) throw new ChannelError(ErrorType.EMPTY_RESPONSE_ERROR, "The model stream ended before a completion event.");
      throw new ChannelError(ErrorType.API_ERROR, "The model stream ended before a completion event.");
    }
    // 只有思考、没有正文和工具调用的回复无法推进任务，按空回复处理。
    if (!visible && !state.issued && !socket?.hasContinuation())
      throw new ChannelError(ErrorType.EMPTY_RESPONSE_ERROR, t('modules.channel.errors.emptyResponse'));
    return { ...content, ...(socket ? { nativeResponse: socket.reference() } : {}) } as PlatformMessage;
  }
}
