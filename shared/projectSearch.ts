import type { ProjectSearchMatch, ProjectSearchQuery } from '../packages/contracts/src/search';

/** 查询和替换共用同一个表达式，保留 JavaScript 的捕获组替换语义。 */
export function projectSearchExpression(options: ProjectSearchQuery): RegExp {
  if (typeof options.query !== 'string' || !options.query) throw new Error('请输入搜索内容。');
  let source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try { return new RegExp(source, options.caseSensitive ? 'gmu' : 'gimu'); }
  catch (error) { throw new Error(`正则表达式无效：${error instanceof Error ? error.message : String(error)}`); }
}

export function searchProjectText(text: string, options: ProjectSearchQuery, limit: number): { matches: ProjectSearchMatch[]; truncated: boolean } {
  const lines = [0];
  for (let offset = 0; offset < text.length; offset++) if (text[offset] === '\n') lines.push(offset + 1);
  const position = (offset: number) => {
    let low = 0, high = lines.length;
    while (low + 1 < high) { const middle = (low + high) >>> 1; if (lines[middle] <= offset) low = middle; else high = middle; }
    return { line: low, character: offset - lines[low] };
  };
  const matches: ProjectSearchMatch[] = [];
  for (const match of text.matchAll(projectSearchExpression(options))) {
    if (matches.length >= limit) return { matches, truncated: true };
    const start = position(match.index), end = position(match.index + match[0].length);
    const lineEnd = text.indexOf('\n', match.index);
    const previewStart = Math.max(lines[start.line], match.index - 100);
    const previewEnd = Math.min(lineEnd < 0 ? text.length : lineEnd, previewStart + 300);
    matches.push({ range: { start, end }, text: match[0].slice(0, 300),
      preview: `${previewStart > lines[start.line] ? '…' : ''}${text.slice(previewStart, previewEnd).replace(/\r$/, '')}${previewEnd < (lineEnd < 0 ? text.length : lineEnd) ? '…' : ''}` });
  }
  return { matches, truncated: false };
}

export function replaceProjectText(text: string, options: ProjectSearchQuery, replacement: string): string {
  const expression = projectSearchExpression(options);
  return options.regex ? text.replace(expression, replacement) : text.replace(expression, () => replacement);
}
