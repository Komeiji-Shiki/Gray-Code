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

/** 行内代码原样保留；转义字符先换成占位，避免被当作强调标记。 */
function plainInline(line: string): string {
  return line.split(/(`+[^`]*?`+)/).map((piece, index) => {
    if (index % 2) return piece.replace(/^`+ ?|(?: ?)`+$/g, '');
    const escaped: string[] = [];
    return piece
      .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, char: string) => `${escaped.push(char) - 1}`)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt: string, url: string) => `${alt || '图片'}（${url}）`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label: string, url: string) => label === url ? url : `${label}（${url}）`)
      .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/(\*{1,3}|_{2,3})(?=\S)(.*?\S)\1/g, '$2')
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?![\w])/g, '$1$2')
      .replace(/~~(?=\S)(.*?\S)~~/g, '$1')
      .replace(/(\d+)/g, (_, index: string) => escaped[Number(index)]);
  }).join('');
}
/** OneBot 的文字消息段不渲染 Markdown：去掉标记符号，保留代码原文、链接地址和列表层次。 */
export function plainBotText(markdown: string): string {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = undefined;
      else lines.push(line);
      continue;
    }
    if (marker) { fence = marker; continue; }
    // 表格分隔行没有内容；数据行只去掉首尾竖线。
    if (line.includes('|') && line.includes('-') && /^[\s|:-]+$/.test(line)) continue;
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { lines.push('——————'); continue; }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { lines.push(`【${plainInline(heading[1])}】`); continue; }
    lines.push(plainInline(line
      .replace(/^\s*\|(.*)\|\s*$/, (_, cells: string) => cells.split('|').map(cell => cell.trim()).join(' | '))
      .replace(/^(\s{0,3}>\s?)+/, '｜')
      .replace(/^(\s*)[-*+]\s+\[([ xX])\]\s+/, (_, indent: string, done: string) => `${indent}${done === ' ' ? '☐' : '☑'} `)
      .replace(/^(\s*)[-*+]\s+/, '$1• ')));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd();
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
