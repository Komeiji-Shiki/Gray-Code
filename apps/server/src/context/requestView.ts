import type { ConversationState, ModelInput, PlatformMessage } from '@graycode/contracts';
import type { ModelRequestContext } from '@graycode/core';
import type { ChannelConfig } from '../../../../backend/modules/config/types';
import type { PlatformApplication } from '../application';
import type { CharacterTurn } from '../characters/pipeline';
import { applyBotContextPrefixes, type CapturedBotEnvironment } from '../bots/prompt';
import { activeContextHistory, type ModelPrefix } from './compaction';

/** 历史删除过滤、角色变换与 Bot 前缀在预算和总结之前完成。 */
export async function captureRequestView(app: PlatformApplication,
  context: Pick<ModelRequestContext, 'run' | 'input' | 'history'>, config: ChannelConfig, preview = false) {
  const { input, run } = context;
  const pending = input.pendingToolCallIds?.length ? new Set(input.pendingToolCallIds) : undefined;
  const view = await app.longMemory.history.prepare(run.actorId, run.conversationId, context.history.history.messages,
    preview ? context.history.metadata : undefined);
  const initialActive = activeContextHistory(view.messages, config, pending);
  let firstAssembly = true;
  return async (state: ConversationState): Promise<PlatformMessage[]> => {
    input.signal.throwIfAborted();
    const original = view.filter(state.history.messages);
    let messages = firstAssembly ? initialActive : activeContextHistory(original, config, pending);
    firstAssembly = false;
    messages = await app.characterPipeline.modelHistory(messages, input.turnContext?.characterTurn as CharacterTurn | undefined, input.signal);
    return applyBotContextPrefixes(view.filter(messages),
      (state.metadata.custom as { botEnvironment?: CapturedBotEnvironment } | undefined)?.botEnvironment, input.taskContext?.actor);
  };
}

/** 手动与定时总结复用最近运行的身份及保存前缀，不重新生成历史回合提示词。 */
export async function captureSummaryView(app: PlatformApplication, state: ConversationState, prefix: ModelPrefix,
  config: ChannelConfig, signal: AbortSignal) {
  const lastRunId = state.history.messages.findLast(message => typeof message.runId === 'string')?.runId;
  const run = typeof lastRunId === 'string' ? await app.storage.getRun(lastRunId) : null;
  const input: ModelInput = { ...prefix, messages: state.history.messages, signal };
  if (run) return captureRequestView(app, { run, input, history: state }, config, true);
  const view = await app.longMemory.history.prepare(String(state.metadata.actorId), state.metadata.id,
    state.history.messages, state.metadata);
  return async (candidate: ConversationState) => {
    const messages = await app.characterPipeline.modelHistory(activeContextHistory(view.filter(candidate.history.messages), config),
      input.turnContext?.characterTurn as CharacterTurn | undefined, signal);
    return applyBotContextPrefixes(messages,
      (candidate.metadata.custom as { botEnvironment?: CapturedBotEnvironment } | undefined)?.botEnvironment, input.taskContext?.actor);
  };
}
