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

/** 合并消息只显示一次发言来源；原始历史和引用内部的来源保持独立。 */
export function formatBotSourceMessages<T extends { role: string; parts: Array<{ text?: unknown }> }>(messages: readonly T[]): T[] {
  return messages.map(message => {
    const bot = message as T & { source?: { platform?: string }; botMessageIds?: unknown };
    const source = bot.source;
    if (message.role !== 'user' || !['discord', 'onebot'].includes(source?.platform ?? '')) return message;
    const merged = Array.isArray(bot.botMessageIds) && bot.botMessageIds.length > 1;
    let changed = false;
    let speechShown = false;
    let referenceDepth = 0;
    const parts = message.parts.map(part => {
      if (typeof part.text !== 'string') return part;
      let text = part.text;
      const speech = /^\[([^\n\[]+ 发言) (\{[^\n]*\})\](?=\r?\n|$)/.exec(part.text);
      const reference = /^\[(引用消息|转发消息) (\{[^\n]*\})，以下是原来源内容\]/.exec(part.text);
      const match = speech ?? reference;
      if (match) try {
        const info = JSON.parse(match[2]);
        if (!info || typeof info.id !== 'string' || speech && typeof info.authorId !== 'string') return part;
        const header = formatBotSourceHeader(match[1], info);
        text = (reference ? header.slice(0, -1) + '，以下是原来源内容]' : header) + text.slice(match[0].length);
      } catch { /* 无法识别的旧消息保留原文。 */ }
      if (/^\[(引用消息|转发消息)[^\r\n]*，以下是原来源内容\]/.test(text)) referenceDepth++;
      const header = referenceDepth === 0 && /^\[[^\r\n\[]+ 发言(?: · [^\r\n]*)?\](?:\r?\n|$)/.exec(text);
      if (merged && header) {
        if (speechShown) text = '\n\n' + text.slice(header[0].length);
        speechShown = true;
      }
      if (text === '[原来源内容结束]') referenceDepth = Math.max(0, referenceDepth - 1);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { ...message, parts } : message;
  });
}
