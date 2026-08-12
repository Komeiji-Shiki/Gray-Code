/**
 * 统一 handler 错误边界（唯一实现）。
 *
 * 取代 ConversationHandlers.withConversationBoundary / ToolHandlers.withToolBoundary /
 * SettingsHandlers.settingsHandlerBoundary 三个逐字相同的包装器：统一「catch → 取
 * error.message（缺省回退文案）→ ctx.sendError(errorCode, message)」口径，新增 handler
 * 时直接复用，不再复制错误处理模板。
 *
 * 注意：数据参数形态校验（如 ConversationHandlers 的非对象 data 校验）属于各子域的
 * 业务校验，不在此包装器内做——由调用方在 handler 内部自行处理（错误码保持各子域语义）。
 */
import type { MessageHandler } from '../types';

export function withBoundary(errorCode: string, fallback: string, handler: MessageHandler): MessageHandler {
  return async (data, requestId, ctx) => {
    try {
      await handler(data || {}, requestId, ctx);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : fallback;
      ctx.sendError(requestId, errorCode, message);
    }
  };
}
