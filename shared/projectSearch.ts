import type { ProjectSearchMatch, ProjectSearchQuery } from '../packages/contracts/src/search';
import { validateRegexPattern } from './regexGuard';

/** 查询和替换共用同一个表达式，保留 JavaScript 的捕获组替换语义。 */
export function projectSearchExpression(options: ProjectSearchQuery): RegExp {
  if (typeof options.query !== 'string' || !options.query) throw new Error('请输入搜索内容。');
  if (options.regex) {
    const validation = validateRegexPattern(options.query);
    if (!validation.ok) throw new Error(`正则表达式无效：${validation.error}`);
  }
  let source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try { return new RegExp(source, options.caseSensitive ? 'gmu' : 'gimu'); }
  catch (error) { throw new Error(`正则表达式无效：${error instanceof Error ? error.message : String(error)}`); }
}

export function searchProjectText(text: string, options: ProjectSearchQuery | RegExp, limit: number): { matches: ProjectSearchMatch[]; truncated: boolean } {
  // 匹配按位置递增，只计算实际命中之前的行号；无匹配文件无需建立整份行索引。
  let line = 0, lineStart = 0, scannedOffset = 0;
  const position = (offset: number) => {
    for (; scannedOffset < offset; scannedOffset++) if (text[scannedOffset] === '\n') { line++; lineStart = scannedOffset + 1; }
    return { line, character: offset - lineStart };
  };
  const matches: ProjectSearchMatch[] = [];
  for (const match of text.matchAll(options instanceof RegExp ? options : projectSearchExpression(options))) {
    if (matches.length >= limit) return { matches, truncated: true };
    const start = position(match.index), startOffset = lineStart;
    const end = position(match.index + match[0].length);
    const lineEnd = text.indexOf('\n', match.index);
    const previewStart = Math.max(startOffset, match.index - 100);
    const previewEnd = Math.min(lineEnd < 0 ? text.length : lineEnd, previewStart + 300);
    matches.push({ range: { start, end }, text: match[0].slice(0, 300),
      preview: `${previewStart > startOffset ? '…' : ''}${text.slice(previewStart, previewEnd).replace(/\r$/, '')}${previewEnd < (lineEnd < 0 ? text.length : lineEnd) ? '…' : ''}` });
  }
  return { matches, truncated: false };
}

export function replaceProjectText(text: string, options: ProjectSearchQuery, replacement: string): string {
  const expression = projectSearchExpression(options);
  return options.regex ? text.replace(expression, replacement) : text.replace(expression, () => replacement);
}
