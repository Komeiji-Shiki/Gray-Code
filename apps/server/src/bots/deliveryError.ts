/** 只有发送边界能确认未投递时才允许自动重试；普通网络异常仍视为结果未知。 */
export class BotDeliveryError extends Error {
  constructor(message: string, readonly kind: 'retryable' | 'rejected' | 'unknown', readonly retryAfterMs?: number) {
    super(message);
    this.name = 'BotDeliveryError';
  }
}

export function botDeliveryError(error: unknown): BotDeliveryError {
  if (error instanceof BotDeliveryError) return error;
  const status = Number((error as { status?: number } | null)?.status);
  if (status === 429) return new BotDeliveryError('平台暂时限制了发送频率，稍后重试。', 'retryable');
  if ([400, 401, 403, 404, 405, 413].includes(status)) return new BotDeliveryError(`平台拒绝发送，HTTP ${status}。请检查消息格式和频道权限。`, 'rejected');
  return new BotDeliveryError('发送结果未确认，请检查平台消息后决定是否重试。', 'unknown');
}
