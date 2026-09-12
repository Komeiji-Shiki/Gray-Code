interface ImageLimitConfig {
  type?: string;
  maxInputImages?: number;
  options?: unknown;
  optionsEnabled?: unknown;
}

/** 新的通用上限优先；尚未迁移的 Gemini 配置沿用原来的图片设置。 */
export function inputImageLimit(config: ImageLimitConfig): number | undefined {
  const legacy = (config.type === 'gemini' || config.type === 'gemini-interactions')
    && (config.optionsEnabled as { maxImages?: boolean } | undefined)?.maxImages !== false
    ? (config.options as { maxImages?: number } | undefined)?.maxImages : undefined;
  const value = config.maxInputImages ?? legacy;
  return Number.isSafeInteger(value) && Number(value) > 0 ? value : undefined;
}

interface ImagePart { text?: unknown; inlineData?: { mimeType?: unknown }; fileData?: { mimeType?: unknown } }
const isImage = (data: { mimeType?: unknown } | undefined) => typeof data?.mimeType === 'string' && data.mimeType.startsWith('image/');

/** 只修改请求副本中的图片载荷，保留文字、消息次序与工具调用配对。 */
export function limitInputImages<T extends { parts: ImagePart[] }>(history: T[], maximum?: number): T[] {
  if (maximum === undefined) return history;
  let remaining = maximum;
  return [...history].reverse().map(message => ({ ...message, parts: [...message.parts].reverse().map(part => {
    if (!isImage(part.inlineData) && !isImage(part.fileData)) return part;
    if (remaining-- > 0) return part;
    const next = { ...part };
    if (isImage(next.inlineData)) delete next.inlineData;
    if (isImage(next.fileData)) delete next.fileData;
    if (typeof next.text !== 'string') next.text = '[较早的图片未随本次请求发送]';
    return next;
  }).reverse() })).reverse();
}
