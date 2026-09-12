export function clipBotText(value: string, length: number): string {
  let end = Math.min(value.length, length);
  if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return value.slice(0, end);
}

/** 参数只作简短展示；根据内容选择反引号长度，避免参数中的代码打断行内格式。 */
export function inlineBotArguments(args: unknown): string {
  if (args === undefined || args === null || typeof args === 'object' && !Object.keys(args).length) return '';
  const json = JSON.stringify(args, (key, value) => /^(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|token|secret|password|authorization|cookie)$/i.test(key) ? '[隐藏]' : value);
  if (!json) return '';
  const compact = json.replace(/\s+/g, ' ');
  const text = compact.length > 160 ? clipBotText(compact, 159) + '…' : compact;
  const marker = '`'.repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)));
  return `${marker}${text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text}${marker}`;
}

/** 长回复按行优先分段，并在消息边界闭合、重开 Markdown 代码围栏。 */
export function splitBotText(text: string, limit = 1900): string[] {
  const result: string[] = [];
  let remaining = text; let fence: { marker: string; language: string } | undefined;
  while (remaining) {
    const prefix = fence ? `${fence.marker}${fence.language}\n` : '';
    const room = limit - prefix.length - 12;
    let body = clipBotText(remaining, room);
    if (body.length < remaining.length) {
      const newline = body.lastIndexOf('\n');
      if (newline > room / 2) body = body.slice(0, newline + 1);
    }
    for (const match of body.matchAll(/(?:^|\n)[ \t]*(`{3,}|~{3,})([^\n]*)/g)) {
      if (match[1].length > 32 || match[2].length > 80) {
        const plain: string[] = [];
        for (let offset = 0; offset < text.length;) { const part = clipBotText(text.slice(offset), limit); plain.push(part); offset += part.length; }
        return plain;
      }
      if (!fence) fence = { marker: match[1], language: match[2].trim() };
      else if (match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length && !match[2].trim()) fence = undefined;
    }
    result.push(prefix + body + (fence ? `\n${fence.marker}` : ''));
    remaining = remaining.slice(body.length);
  }
  return result.length ? result : ['任务已完成。'];
}
