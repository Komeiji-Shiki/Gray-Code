/**
 * 流式互斥守卫（TREE-13，第三批模块化重构：从 BranchHandlers 拆分为共享模块）。
 *
 * 供 BranchHandlers（全部变更类分支操作）与 ChatHandlers（rerollStream / editBranchStream）
 * 共用，消除 handler 文件间的横向依赖；BranchHandlers 继续 re-export 本模块的两个符号，
 * 保持既有 import（含测试）不破坏。
 */

import type { HandlerContext } from '../types';

/** TREE-13：流式生成期间变更类分支操作被拒时的固定文案 */
export const BRANCH_BUSY_STREAMING_MESSAGE = '会话正在流式生成中，请等待完成后再操作';

/**
 * TREE-13：判断会话是否处于流式生成中。
 *
 * HandlerContext 注入真实的 StreamAbortManager；isActive 只统计主流请求，
 * summary 请求不拦截分支操作。
 */
export function isConversationStreaming(ctx: HandlerContext, conversationId: string): boolean {
  return ctx.streamAbortControllers?.isActive(conversationId) ?? false;
}

/** 会话级分支/工作区事务闸：从取消旧流到切图完成期间禁止启动新流。 */
const conversationMutationGates = new Set<string>();

export function tryAcquireConversationMutationGate(conversationId: string): (() => void) | null {
  if (conversationMutationGates.has(conversationId)) return null;
  conversationMutationGates.add(conversationId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    conversationMutationGates.delete(conversationId);
  };
}

export function isConversationMutationGated(conversationId: string): boolean {
  return conversationMutationGates.has(conversationId);
}
