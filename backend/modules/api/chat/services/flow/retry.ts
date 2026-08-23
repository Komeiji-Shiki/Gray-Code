/**
 * Retry 流程编排（flow 拆分）。
 *
 * 迁移自 ChatFlowService：非流式 handleRetry / 流式 handleRetryStream 以及
 * retry 截断索引解析纯函数 resolveRetryTruncateIndex。方法体与拆分前完全一致，
 * 通过共享的 ChatFlowContext 访问依赖与公共辅助逻辑。
 */

import { t } from '../../../../../i18n';
import type { RetryRequestData, ChatSuccessData, ChatErrorData } from '../../types';
import type { Content } from '../../../../conversation/types';
import { isFunctionResponseMessage } from '../../../../conversation/branch';
import { ChatStreamOutput, ChatFlowContext, ChatFlowDeps, isFirstMessageHistory } from './context';

/**
 * 解析 retry 主历史截断起始索引（最后一段 AI 回复的起点）。
 *
 * retry 语义是“重新生成最后一段 AI 回复”：只删除最后一个非 model 消息（user /
 * functionResponse）之后的 model 尾巴。若历史末尾本来就不是 model（例如失败流从未
 * 写出内容，最后一条仍是 user），则返回 -1 不截断——此时重试 = 继续生成，绝不能
 * 误删更早已经正常完成的 AI 回复。
 *
 * 若末尾 model 保留，请求 messages 的最后一条会是 assistant——
 * - 带 tool_calls 时，DeepSeek 等 API 会把最后一条 assistant 当作 prefill 前缀，
 *   直接 400 "Function call should not be used with prefix"（被重试的消息原样被预填）；
 * - 纯文本时也会被当作 prefill 续写，重试变成接龙，语义错误。
 */
export function resolveRetryTruncateIndex(history: ReadonlyArray<Content>): number {
  // 从末尾往前找最后一个「非 model 消息」（user / functionResponse / system 等）。
  // 它之后的所有 model 消息就是需要重试的 AI 回复尾巴。
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message.role !== 'model' || isFunctionResponseMessage(message)) {
      return i + 1 < history.length ? i + 1 : -1;
    }
  }
  // 历史全部是 model（异常状态）：从 0 开始删，保证请求不再以 assistant 结尾。
  return history.length > 0 ? 0 : -1;
}

export class ChatFlowRetry extends ChatFlowContext {
  constructor(deps: ChatFlowDeps) {
    super(deps);
  }

  /**
   * 非流式 Retry 流程
   */
  async handleRetry(request: RetryRequestData): Promise<ChatSuccessData | ChatErrorData> {
    const { conversationId, configId, modelOverride } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      return {
        success: false,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
    }

    if (!config.enabled) {
      return {
        success: false,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    await this.clearPendingApprovalGateIfPresent(conversationId, 'retry');

    // 2.5 请求前置清理：中断上一轮未完成的 diff 等待、拒绝所有未响应的工具调用
    //（与流式 handleRetryStream 对齐，避免悬空 functionCall/pending diff 跨回合残留）
    // H1：先等旧流完全退出，再执行清理与截断（避免旧流结算落在重试截断之后）
    await this.waitForOldStreamExit(conversationId);
    await this.prepareConversationForRequest(conversationId);

    // 2.6 重试截断：删除主历史末尾的 model 消息（重新生成最后一条 AI 回复）。
    // 不删的话请求 messages 最后一条是 assistant——带 tool_calls 时 DeepSeek 等 API
    // 会把它当作 prefill 前缀直接 400（"Function call should not be used with prefix"），
    // 纯文本时也会被 prefill 续写（重试变接龙）。放在 prepareConversationForRequest 之后：
    // 拒绝悬空工具调用补充的 functionResponse 一并落在删除范围内，避免残留孤儿 tool 消息。
    const retryHistory = await this.conversationManager.getMessagesRaw(conversationId);
    const retryTruncateIndex = resolveRetryTruncateIndex(retryHistory);
    if (retryTruncateIndex >= 0) {
      await this.checkpointService.deleteCheckpointsFromIndex(conversationId, retryTruncateIndex);
      await this.conversationManager.deleteMessagesInRange(conversationId, retryTruncateIndex, retryHistory.length - 1);
      // 与 edit 路径（handleEditAndRetry 1229）对齐：截断后重建 todoList 元数据
      await this.rebuildTodoListMetadataFromHistory(conversationId);
    }
    // 与 edit 路径（handleEditAndRetry 1233）对齐：截断后清除裁剪状态，重新计算裁剪起点
    await this.toolIterationLoopService.clearTrimState(conversationId);

    // 3. 工具调用循环（委托给 ToolIterationLoopService，非流式）
    const maxToolIterations = this.getMaxToolIterations();
    const loopResult = await this.toolIterationLoopService.runNonStreamLoop(
      conversationId,
      configId,
      config,
      maxToolIterations,
      modelOverride,
      promptModeSnapshot,
      dynamicContextStrategy,
      false,
      // H5：透传取消信号（自动总结调用使用 merged signal）
      request.abortSignal,
      request.summarizeAbortSignal,
      request.deepSeekVisionTileSplit,
    );

    if (loopResult.exceededMaxIterations) {
      return {
        success: false,
        error: {
          code: 'MAX_TOOL_ITERATIONS',
          message: t('modules.api.chat.errors.maxToolIterations', { maxIterations: maxToolIterations }),
        },
      };
    }

    // C-1：非流式路径透传取消语义（与 handleChat 一致）
    if (loopResult.cancelled) {
      return {
        success: false,
        error: {
          code: 'CANCELLED',
          message: t('modules.channel.errors.requestCancelled'),
        },
      };
    }

    // content 为空或 parts 为空时显式返回错误，不再用非空断言透传 success:true + content:undefined
    // EMPTY_RESPONSE 使用独立文案（模型返回了空内容），不复用 requestCancelled 的
    // 「请求已取消」——正常空输出与取消语义不同，避免误导用户。
    if (!loopResult.content?.parts?.length) {
      return {
        success: false,
        error: {
          code: 'EMPTY_RESPONSE',
          message: t('modules.channel.errors.emptyResponse'),
        },
      };
    }

    return {
      success: true,
      content: loopResult.content,
    };
  }

  /**
   * 流式 Retry 流程
   */
  async *handleRetryStream(
    request: RetryRequestData,
  ): AsyncGenerator<ChatStreamOutput> {
    const { conversationId, configId, modelOverride } = request;

    // 1. 确保对话存在
    await this.ensureConversation(conversationId);

    // 2. 验证配置
    const config = await this.configManager.getConfig(configId);
    if (!config) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_NOT_FOUND',
          message: t('modules.api.chat.errors.configNotFound', { configId }),
        },
      };
      return;
    }

    if (!config.enabled) {
      yield {
        conversationId,
        error: {
          code: 'CONFIG_DISABLED',
          message: t('modules.api.chat.errors.configDisabled', { configId }),
        },
      };
      return;
    }

    const promptModeSnapshot = await this.resolvePromptModeSnapshot(conversationId, request.promptModeId);
    const dynamicContextStrategy = this.resolveDynamicContextStrategy(promptModeSnapshot);

    await this.clearPendingApprovalGateIfPresent(conversationId, 'retry_stream');

    // 3. 请求前置清理：中断上一轮未完成的 diff 等待并关闭编辑器、
    //    拒绝所有未响应的工具调用（悬空 functionCall 会被标记 rejected 并补 functionResponse，
    //    历史里不会残留带 functionCall 但没有 functionResponse 的消息）
    // H1：先等旧流完全退出（webview 层已等待过一遍，这里对直接调用入口兜底）
    await this.waitForOldStreamExit(conversationId);
    await this.prepareConversationForRequest(conversationId);

    // 3.5 重试截断：删除主历史末尾的 model 消息（重新生成最后一条 AI 回复）。
    // 不删的话请求 messages 最后一条是 assistant——带 tool_calls 时 DeepSeek 等 API
    // 会把它当作 prefill 前缀直接 400（"Function call should not be used with prefix"），
    // 纯文本时也会被 prefill 续写（重试变接龙）。放在 prepareConversationForRequest 之后：
    // 拒绝悬空工具调用补充的 functionResponse 一并落在删除范围内，避免残留孤儿 tool 消息。
    // 注意：截断必须先于下方 isFirstMessageHistory 判断——截断后历史可能回到"仅首条用户消息"。
    const retryHistory = await this.conversationManager.getMessagesRaw(conversationId);
    const retryTruncateIndex = resolveRetryTruncateIndex(retryHistory);
    if (retryTruncateIndex >= 0) {
      await this.checkpointService.deleteCheckpointsFromIndex(conversationId, retryTruncateIndex);
      await this.conversationManager.deleteMessagesInRange(conversationId, retryTruncateIndex, retryHistory.length - 1);
      // 与 edit 路径（handleEditAndRetryStream 2180）对齐：截断后重建 todoList 元数据
      await this.rebuildTodoListMetadataFromHistory(conversationId);
    }
    // 与 edit 路径（handleEditAndRetryStream 2184）对齐：截断后清除裁剪状态，重新计算裁剪起点
    await this.toolIterationLoopService.clearTrimState(conversationId);

    // 6. 判断是否需要刷新动态系统提示词
    const retryHistoryCheck = await this.conversationManager.getHistoryRef(conversationId);
    const isRetryFirstMessage = isFirstMessageHistory(retryHistoryCheck);

    // 7. 工具调用循环（委托给 ToolIterationLoopService）
    const maxToolIterations = this.getMaxToolIterations();

    for await (const output of this.toolIterationLoopService.runToolLoop({
      conversationId,
      configId,
      config,
      modelOverride,
      abortSignal: request.abortSignal,
      summarizeAbortSignal: request.summarizeAbortSignal,
      isFirstMessage: isRetryFirstMessage,
      maxIterations: maxToolIterations,
      // 重试场景原本没有模型消息前检查点，这里显式关闭以保持行为一致
      createBeforeModelCheckpoint: false,
      // 重试的是 AI 回复，回合起始用户消息不变，复用其上缓存的动态上下文
      isNewTurn: false,
      promptModeSnapshot,
      dynamicContextStrategy,
      // 重发历史图片时沿用前端最近一次拆分/压缩选择（省略 = 后端默认拆分）
      deepSeekVisionTileSplit: request.deepSeekVisionTileSplit,
    })) {
      yield output as ChatStreamOutput;
    }
  }
}
