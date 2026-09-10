/** 时间与来源用于阅读，平台消息和账号标识仍由后端元数据保存。 */
export function formatBotTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const pad = (number: number) => String(number).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function formatBotSourceHeader(label: string, source: { displayName?: unknown; timestamp?: unknown }): string {
  const fields = [label];
  if (typeof source.displayName === 'string' && source.displayName.trim()) fields.push(JSON.stringify(source.displayName));
  const time = formatBotTimestamp(source.timestamp);
  if (time) fields.push(time);
  return `[${fields.join(' · ')}]`;
}

/** 只转换带平台来源标记的旧消息头，不修改历史原文或用户自己输入的 JSON。 */
export function formatBotSourceMessages<T extends { role: string; parts: Array<{ text?: unknown }> }>(messages: readonly T[]): T[] {
  return messages.map(message => {
    const source = (message as T & { source?: { platform?: string } }).source;
    if (message.role !== 'user' || !['discord', 'onebot'].includes(source?.platform ?? '')) return message;
    let changed = false;
    const parts = message.parts.map(part => {
      if (typeof part.text !== 'string') return part;
      const speech = /^\[([^\n\[]+ 发言) (\{[^\n]*\})\](?=\r?\n|$)/.exec(part.text);
      const reference = /^\[(引用消息|转发消息) (\{[^\n]*\})，以下是原来源内容\]/.exec(part.text);
      const match = speech ?? reference;
      if (!match) return part;
      try {
        const info = JSON.parse(match[2]);
        if (!info || typeof info.id !== 'string' || speech && typeof info.authorId !== 'string') return part;
        const header = formatBotSourceHeader(match[1], info);
        changed = true;
        return { ...part, text: (reference ? header.slice(0, -1) + '，以下是原来源内容]' : header) + part.text.slice(match[0].length) };
      } catch { return part; }
    });
    return changed ? { ...message, parts } : message;
  });
}
