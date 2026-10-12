import type { ModelInput, PlatformConversation } from '@graycode/contracts';
import type { PlatformApplication } from '../application';

export type ModelPrefix = Pick<ModelInput, 'conversationId' | 'providerId' | 'modelOverride' | 'reasoningEffort' | 'systemPrompt' |
  'tools' | 'promptContext' | 'taskContext' | 'turnContext'>;

const recentPrefixes = new WeakMap<PlatformApplication, Map<string, { requestRef: string; prefix: ModelPrefix }>>();

/** 请求中的前缀快照只读复用，避免每次工具迭代复制相同工具目录和附件。 */
export function captureModelPrefix(input: ModelInput): ModelPrefix {
  return { conversationId: input.conversationId, providerId: input.providerId, modelOverride: input.modelOverride,
    reasoningEffort: input.reasoningEffort, systemPrompt: input.systemPrompt, tools: input.tools, promptContext: input.promptContext,
    taskContext: input.taskContext, turnContext: input.turnContext };
}

export function rememberModelPrefix(app: PlatformApplication, requestRef: string, prefix: ModelPrefix): void {
  let conversations = recentPrefixes.get(app);
  if (!conversations) recentPrefixes.set(app, conversations = new Map());
  conversations.set(prefix.conversationId, { requestRef, prefix });
}

/** 新会话仅保存请求记录引用；仍能读取旧版写在会话元数据里的完整前缀。 */
export async function readModelPrefix(app: PlatformApplication, metadata: PlatformConversation): Promise<ModelPrefix | undefined> {
  const custom = metadata.custom as Record<string, unknown> | undefined;
  const requestRef = custom?.contextRequestPrefixRef;
  if (typeof requestRef === 'string') {
    const cached = recentPrefixes.get(app)?.get(metadata.id);
    if (cached?.requestRef === requestRef) return cached.prefix;
    const saved = await app.storage.getRecord('model-requests', requestRef) as { prefix?: ModelPrefix } | null;
    if (saved?.prefix) {
      rememberModelPrefix(app, requestRef, saved.prefix);
      return saved.prefix;
    }
  }
  return custom?.contextRequestPrefix as ModelPrefix | undefined;
}
