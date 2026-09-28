import type { Tool } from '../../../../backend/tools/types';
import { getActualLanguage } from '../../../../backend/i18n';
import { resolveLocalizationLanguage } from '../../../../backend/tools/localization/types';
import { buildExcludePattern } from '../../../../backend/tools/shared/globUtils';
import { escapeRegExp } from '../../../../backend/tools/shared/textUtils';
import { splitTextLines } from '../../../../shared/textLines';
import type { NodeFileHost } from './fileHost';

/** 预览保留真实列号；裁剪围绕命中而不是固定取行首，并避免切开 UTF-16 代理对。 */
export function literalMatchPreview(value: string, index: number, length: number, limit = 1200) {
  let start = Math.max(0, Math.min(index - Math.floor(Math.max(0, limit - length) / 2), value.length - limit));
  let end = Math.min(value.length, start + limit);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(value[start]) && /[\uD800-\uDBFF]/.test(value[start - 1])) start--;
  if (end < value.length && /[\uDC00-\uDFFF]/.test(value[end]) && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return { text: value.slice(start, end), column: index + 1, matchLength: length,
    previewStartColumn: start + 1, contentTruncated: start > 0 || end < value.length };
}

/** 轻量搜索与高级搜索共用文件宿主及排除配置，保留每个匹配行只返回一次的语义。 */
export function createLiteralSearchTool(host: NodeFileHost): Tool {
  const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
  return {
    declaration: {
      name: 'search_files', readOnly: true, category: 'search',
      description: isZh
        ? '轻量、严格字面量搜索 UTF-8 文本，每个匹配行返回一次，不自动拆词。沿用 search_in_files 的排除配置及项目 .gitignore；includeIgnored=true 可显式搜索忽略文件，仍跳过 .git 元数据、符号链接、二进制和大文件。长行返回命中附近片段及 column/previewStartColumn/contentTruncated。需要正则、glob、上下文或替换时使用 search_in_files。用 nextOffset 续查并保持参数不变；文件或排除设置变化后从 0 重查。'
        : 'Lightweight strict literal UTF-8 search, one result per matching line without keyword fallback. Uses search_in_files exclusions and project .gitignore; includeIgnored=true explicitly searches ignored files, still skipping .git metadata, symlinks, binary and large files. Long lines return a match-centered preview with column/previewStartColumn/contentTruncated. Use search_in_files for regex, globs, context or replacement. Continue with nextOffset and unchanged parameters; restart at 0 after files or exclusions change.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        query: { type: 'string', minLength: 1 }, directory: { type: 'string' }, caseSensitive: { type: 'boolean' },
        includeIgnored: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        offset: { type: 'integer', minimum: 0, default: 0, description: isZh ? '跳过的匹配行数，续查用 nextOffset。' : 'Matching lines to skip; use nextOffset to continue.' },
      }, required: ['query'] },
    },
    handler: async (args, context) => {
      const limit = args.limit ?? 100, offset = args.offset ?? 0;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('offset must be a non-negative safe integer');
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 200) throw new Error('limit must be an integer between 1 and 200');
      if (typeof args.query !== 'string' || !args.query.length) throw new Error('query must be nonempty text');
      if (args.includeIgnored !== undefined && typeof args.includeIgnored !== 'boolean') throw new Error('includeIgnored must be a boolean');
      if (args.directory !== undefined && typeof args.directory !== 'string') throw new Error('directory must be a string');
      const includeIgnored = args.includeIgnored === true;
      const exclude = includeIgnored ? '**/.git/**' : buildExcludePattern(host.searchConfig().excludePatterns);
      const roots = host.getAllWorkspaces();
      if (!roots.length) throw new Error('Select a workspace before using local tools.');
      const directory = args.directory || '.';
      const parsed = directory === '.' ? undefined : host.parseWorkspacePath(directory as string);
      if (parsed && !parsed.workspace) throw new Error(parsed.error || 'Invalid search directory.');
      const targets = parsed?.workspace ? [{ ...parsed.workspace, uri: host.joinPath(parsed.workspace.uri, parsed.relativePath) }] : roots;
      const expression = new RegExp(escapeRegExp(args.query), args.caseSensitive ? '' : 'i');
      const matches: Array<{ path: string; line: number } & ReturnType<typeof literalMatchPreview>> = [];
      const skippedFiles: Array<{ file: string; reason: string }> = [];
      let remaining = Number(offset), scanned = 0, filesTruncated = false, skippedCount = 0;
      const skip = (file: string, reason: string) => { skippedCount++; if (skippedFiles.length < 50) skippedFiles.push({ file, reason }); };
      search: for (const root of targets) {
        for await (const file of host.iterateFiles(root.uri, '**/*', exclude, 20_001, { includeIgnored })) {
          context?.abortSignal?.throwIfAborted();
          if (scanned >= 20_000) { filesTruncated = true; break search; }
          scanned++;
          const relative = host.toRelativePath(file);
          let text: string;
          try {
            if ((await host.stat(file)).size > 2 * 1024 * 1024) { skip(relative, 'File exceeds the 2 MiB literal search limit.'); continue; }
            const bytes = await host.readFile(file);
            if (bytes.length > 2 * 1024 * 1024) { skip(relative, 'File grew beyond the 2 MiB literal search limit.'); continue; }
            if (bytes.includes(0)) { skip(relative, 'Binary file.'); continue; }
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch (error) {
            context?.abortSignal?.throwIfAborted();
            skip(relative, error instanceof Error ? error.message : String(error));
            continue;
          }
          context?.abortSignal?.throwIfAborted();
          for (const [line, value] of splitTextLines(text).entries()) {
            const match = expression.exec(value);
            if (!match) continue;
            if (remaining > 0) { remaining--; continue; }
            matches.push({ path: relative, line: line + 1, ...literalMatchPreview(value, match.index, match[0].length) });
            if (matches.length > Number(limit)) break search;
          }
        }
      }
      const matchesTruncated = matches.length > Number(limit);
      if (matchesTruncated) matches.length = Number(limit);
      const nextOffset = matchesTruncated ? Number(offset) + matches.length : undefined;
      return { success: true, data: { matches, scanned, offset, nextOffset, includeIgnored, effectiveExclude: exclude,
        respectsGitIgnore: !includeIgnored, skippedCount, skippedFiles: skippedFiles.length ? skippedFiles : undefined,
        skippedFilesTruncated: skippedCount > skippedFiles.length,
        truncated: matchesTruncated || filesTruncated,
        truncationReasons: matchesTruncated ? ['limit'] : filesTruncated ? ['scanLimit'] : undefined,
        continuationHint: nextOffset !== undefined
          ? `Continue with offset=${nextOffset} and unchanged query/directory/caseSensitive/includeIgnored; restart at 0 if files or exclusions changed.`
          : filesTruncated ? 'File scan limit reached; narrow directory. Offset cannot reach unscanned files.' : undefined } };
    },
  };
}
