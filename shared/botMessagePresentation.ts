/** 时间与来源用于阅读，平台消息和账号标识仍由后端元数据保存。 */
export function formatBotTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const pad = (number: number) => String(number).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** QQ 号在前、昵称在后：号码能稳定区分同名用户，昵称让模型知道在说谁。 */
export function formatBotMention(id: string, name?: string): string {
  if (id === 'all') return '@全体成员';
  return name ? `@${id}（${name}）` : `@${id}`;
}

export function formatBotSourceHeader(label: string | undefined, source: { displayName?: unknown; timestamp?: unknown }): string {
  const fields = label ? [label] : [];
  if (typeof source.displayName === 'string' && source.displayName.trim()) fields.push(JSON.stringify(source.displayName));
  const time = formatBotTimestamp(source.timestamp);
  if (time) fields.push(time);
  return `[${fields.join(' · ')}]`;
}

/** 当前发言头是 `["昵称" · 时间]`；`[Discord 发言 · …]` 是旧历史里已存的写法，两种都要识别。 */
const SPEECH_HEADER = /^\[(?:[^\r\n\[]+ 发言(?: · [^\r\n]*)?|"(?:[^"\\\r\n]|\\.)*"(?: · [^\r\n\]]*)?|\d{4}-[^\r\n\]]*)\](?:\r?\n|$)/;

/** 当前引用头是单独成段的 `[引用 · "昵称"]`，配对 `[引用结束]`；`以下是原来源内容` 与 `[原来源内容结束]` 是旧历史里已存的写法。 */
const REFERENCE_START = /^(?:\[(?:引用|转发)消息[^\r\n]*，以下是原来源内容\]|\[(?:引用|转发)(?: · "(?:[^"\\\r\n]|\\.)*")?\]$)/;
const REFERENCE_END = /^\[(?:原来源内容|引用|转发)结束\]$/;

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
      if (REFERENCE_START.test(text)) referenceDepth++;
      const header = referenceDepth === 0 && SPEECH_HEADER.exec(text);
      if (merged && header) {
        if (speechShown) text = '\n\n' + text.slice(header[0].length);
        speechShown = true;
      }
      if (REFERENCE_END.test(text)) referenceDepth = Math.max(0, referenceDepth - 1);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? { ...message, parts } : message;
  });
}
