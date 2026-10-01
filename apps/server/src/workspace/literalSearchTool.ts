import type { Tool } from '../../../../backend/tools/types';
import { getActualLanguage } from '../../../../backend/i18n';
import { resolveLocalizationLanguage } from '../../../../backend/tools/localization/types';
import { buildExcludePattern } from '../../../../backend/tools/shared/globUtils';
import { escapeRegExp } from '../../../../backend/tools/shared/textUtils';
import { splitTextLines } from '../../../../shared/textLines';
import { decodeTextBytes, detectTextEncoding, normalizeTextEncodingName } from '../../../../backend/tools/search/textEncodingRuntime';
import type { NodeFileHost } from './fileHost';

/**
 * 预览保留真实列号；裁剪围绕命中而不是固定取行首，并避免切开 UTF-16 代理对。
 * 300 字符足够看清一行代码的上下文；更长的行用 read_file 按行号读取，不在搜索结果里整行返回。
 */
export function literalMatchPreview(value: string, index: number, length: number, limit = 300) {
  let start = Math.max(0, Math.min(index - Math.floor(Math.max(0, limit - length) / 2), value.length - limit));
  let end = Math.min(value.length, start + limit);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(value[start]) && /[\uD800-\uDBFF]/.test(value[start - 1])) start--;
  if (end < value.length && /[\uDC00-\uDFFF]/.test(value[end]) && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return { text: value.slice(start, end), column: index + 1, matchLength: length,
    previewStartColumn: start + 1, contentTruncated: start > 0 || end < value.length,
    ...(end < value.length ? { previewEndTruncated: true } : {}) };
}

/** 轻量搜索与高级搜索共用文件宿主及排除配置，保留每个匹配行只返回一次的语义。 */
export function createLiteralSearchTool(host: NodeFileHost): Tool {
  const isZh = resolveLocalizationLanguage(getActualLanguage()) === 'zh-CN';
  return {
    declaration: {
      name: 'search_files', readOnly: true, category: 'search',
      description: isZh
        ? '在文本文件中做轻量的严格字面量搜索，不自动拆词，每个匹配行只返回一次。GBK、Shift-JIS、Big5、UTF-16 等非 UTF-8 文件会自动识别编码后搜索，命中文件的编码列在 encodings 里。沿用 search_in_files 的排除配置和项目 .gitignore；includeIgnored=true 时也搜索被忽略的文件，但仍跳过 .git 元数据、符号链接、二进制文件和大文件；跳过的文件默认只给数量。结果按文件分组，命中行格式为 "行:列: 内容"；长行只返回命中附近的片段，被截断的一端用 … 标出，列号按原行计算。需要正则、上下文或替换时改用 search_in_files。返回 nextOffset 时，保持其他参数不变、把它作为 offset 传入即可读取下一页；文件或排除设置变化后从 offset=0 重新查询。'
        : 'Lightweight, strict literal search over text files. Queries are not split into keywords, and each matching line is returned once. Non-UTF-8 files such as GBK, Shift-JIS, Big5 and UTF-16 are decoded automatically before searching, and the encodings of matching files are listed in encodings. It uses the search_in_files exclusions and the project .gitignore; with includeIgnored=true it also searches ignored files but still skips .git metadata, symlinks, binary files and large files; skipped files are reported as a count by default. Results are grouped by file as "line:col: text". Long lines return a snippet around the match with … marking trimmed ends, and columns refer to the original line. Use search_in_files for regex, context or replacement. When nextOffset is returned, pass it as offset with the other parameters unchanged to read the next page; restart from offset 0 if files or exclusions change.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        query: { type: 'string', minLength: 1 }, directory: { type: 'string' },
        pattern: { type: 'string', minLength: 1, description: isZh
          ? '可选的文件 glob，相对于 directory（默认为工作区根目录），例如 "**/*.ts"；省略时搜索全部文件。'
          : 'Optional file glob relative to directory (the workspace root by default), such as "**/*.ts". Omit it to search all files.' },
        caseSensitive: { type: 'boolean' },
        includeIgnored: { type: 'boolean', default: false },
        encoding: { type: 'string', description: isZh
          ? '可选，所有文件都按这个编码解码，例如 gbk、shift_jis、big5、euc-kr。省略时逐个文件自动识别。'
          : 'Optional encoding used to decode every file, such as gbk, shift_jis, big5 or euc-kr. Omit it to detect each file automatically.' },
        includeSkipped: { type: 'boolean', default: false, description: isZh
          ? '为 true 时列出跳过的文件及原因（最多 50 个）；默认只返回 skippedCount。'
          : 'When true, list skipped files with reasons (up to 50); by default only skippedCount is returned.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        offset: { type: 'integer', minimum: 0, default: 0, description: isZh ? '要跳过的匹配行数，用于分页。' : 'Number of matching lines to skip, for paging.' },
        scanOffset: { type: 'integer', minimum: 0, default: 0, description: isZh ? '候选文件的扫描起点。扫描达到上限时会返回 nextScanOffset，把它作为 scanOffset 传入，并将 offset 重置为 0。' : 'Scan position among candidate files. When the scan limit is reached, nextScanOffset is returned; pass it as scanOffset and reset offset to 0.' },
      }, required: ['query'] },
    },
    handler: async (args, context) => {
      const limit = args.limit ?? 100, offset = args.offset ?? 0;
      const scanOffset = args.scanOffset ?? 0;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error('offset must be a non-negative safe integer');
      if (!Number.isSafeInteger(scanOffset) || Number(scanOffset) < 0) throw new Error('scanOffset must be a non-negative safe integer');
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 200) throw new Error('limit must be an integer between 1 and 200');
      if (typeof args.query !== 'string' || !args.query.length) throw new Error('query must be nonempty text');
      if (args.includeIgnored !== undefined && typeof args.includeIgnored !== 'boolean') throw new Error('includeIgnored must be a boolean');
      if (args.directory !== undefined && typeof args.directory !== 'string') throw new Error('directory must be a string');
      if (args.pattern !== undefined && (typeof args.pattern !== 'string' || !args.pattern.trim())) throw new Error('pattern must be a nonempty glob');
      if (args.encoding !== undefined && typeof args.encoding !== 'string') throw new Error('encoding must be a string');
      const encoding = typeof args.encoding === 'string' && args.encoding.trim() ? normalizeTextEncodingName(args.encoding) : undefined;
      const includeSkipped = args.includeSkipped === true;
      const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '**/*';
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
      const encodings: Record<string, string> = {};
      let remaining = Number(offset), scanned = 0, discovered = 0, filesTruncated = false, skippedCount = 0, skippedBinaryCount = 0;
      const skip = (file: string, reason: string) => { skippedCount++; if (skippedFiles.length < 50) skippedFiles.push({ file, reason }); };
      search: for (const root of targets) {
        // 扫描游标跳过的是发现顺序中的文件，不能在游标以前先截断发现结果，否则下一页仍到不了后续文件。
        for await (const file of host.iterateFiles(root.uri, pattern, exclude, Number.MAX_SAFE_INTEGER, { includeIgnored })) {
          context?.abortSignal?.throwIfAborted();
          if (discovered++ < Number(scanOffset)) continue;
          if (scanned >= 20_000) { filesTruncated = true; break search; }
          scanned++;
          const relative = host.toRelativePath(file);
          let text: string, fileEncoding: string | undefined;
          try {
            if ((await host.stat(file)).size > 2 * 1024 * 1024) { skip(relative, 'File exceeds the 2 MiB literal search limit.'); continue; }
            const bytes = await host.readFile(file);
            if (bytes.length > 2 * 1024 * 1024) { skip(relative, 'File grew beyond the 2 MiB literal search limit.'); continue; }
            // 二进制属于正常排除，只返回数量；UTF-16 虽含 NUL 也按文本搜索。
            const detection = detectTextEncoding(bytes, encoding);
            if (!detection.isText) { skippedCount++; skippedBinaryCount++; continue; }
            text = decodeTextBytes(bytes, detection);
            if (detection.encoding !== 'utf-8') fileEncoding = detection.encoding;
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
            if (fileEncoding) encodings[relative] = fileEncoding;
            matches.push({ path: relative, line: line + 1, ...literalMatchPreview(value, match.index, match[0].length) });
            if (matches.length > Number(limit)) break search;
          }
        }
      }
      const matchesTruncated = matches.length > Number(limit);
      if (matchesTruncated) matches.length = Number(limit);
      const nextOffset = matchesTruncated ? Number(offset) + matches.length : undefined;
      const nextScanOffset = filesTruncated ? Number(scanOffset) + scanned : undefined;
      const nextPage = nextOffset !== undefined ? { scanOffset, offset: nextOffset }
        : nextScanOffset !== undefined ? { scanOffset: nextScanOffset, offset: 0 } : undefined;
      return { success: true, data: { matches, scanned, scanOffset, offset, nextOffset, nextScanOffset, nextPage,
        scanComplete: !matchesTruncated && !filesTruncated, includeIgnored, effectiveExclude: exclude,
        respectsGitIgnore: !includeIgnored, skippedCount, skippedBinaryCount,
        ...(Object.keys(encodings).length ? { encodings } : {}),
        // 明细只在要求时返回；默认给出非二进制跳过数以提示可以查看原因。
        ...(includeSkipped
          ? { skippedFiles: skippedFiles.length ? skippedFiles : undefined, skippedFilesTruncated: skippedCount - skippedBinaryCount > skippedFiles.length }
          : skippedCount - skippedBinaryCount > 0 ? { skippedOtherCount: skippedCount - skippedBinaryCount } : {}),
        truncated: matchesTruncated || filesTruncated,
        truncationReasons: matchesTruncated ? ['limit'] : filesTruncated ? ['scanLimit'] : undefined,
        continuationHint: nextOffset !== undefined
          ? `Continue with offset=${nextOffset}, scanOffset=${scanOffset} and unchanged search parameters; restart both at 0 if files or exclusions changed.`
          : filesTruncated ? `Search is not complete. Continue with scanOffset=${nextScanOffset}, offset=0 and unchanged search parameters; restart both at 0 if files or exclusions changed.` : undefined,
        nextActions: nextPage ? [{ tool: 'search_files', args: { ...args, ...nextPage } }] : undefined } };
    },
  };
}
