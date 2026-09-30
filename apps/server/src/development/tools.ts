import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from 'node:fs/promises';
import type { RuntimeTool, ToolContext } from '@graycode/core';
import type { DocumentSymbol, SymbolInformation, Location, LocationLink } from 'vscode-languageserver-protocol';
import { createGetSymbolsToolDeclaration, createGotoDefinitionToolDeclaration, createFindReferencesToolDeclaration } from '../../../../backend/tools/lsp/declarations';
import { findBlockEnd } from '../../../../backend/tools/lsp/definitionRange';
import { createSymbolOutline, parseSymbolOutlineOptions, MAX_SYMBOL_PATHS, type SymbolOutline } from '../../../../backend/tools/lsp/symbolOutline';
import { createReferencePage, parseReferencePageOptions, referenceSnippet } from '../../../../backend/tools/lsp/referencePage';
import { createDefinitionPage, definitionSnippet, parseDefinitionPageOptions } from '../../../../backend/tools/lsp/definitionPage';
import { FileReadAccess } from '../workspace/readAccess';
import type { PlatformApplication } from '../application';
/** 保留原声明、批量限制、定义代码范围和按文件分组的引用结果。 */
export function languageTools(app: PlatformApplication): RuntimeTool[] {
  return [createGetSymbolsToolDeclaration(), createGotoDefinitionToolDeclaration(), createFindReferencesToolDeclaration()].map(declaration => ({
    declaration: { name: declaration.name, description: declaration.description, parameters: declaration.parameters },
    // 语言服务可能需要启动受管进程；原生异步只提前等待请求，授权与审批仍走完整执行入口。
    nativeAsync: true,
    effects: () => ['workspace_read', 'process_execute'],
    execute: (args, context) => executeNavigation(app, declaration.name, args, context),
  }));
}
async function executeNavigation(app: PlatformApplication, name: string, args: Record<string, unknown>, context: ToolContext) {
  if (!context.workspace) throw new Error('代码导航需要选择工作区。');
  const access = new FileReadAccess(app, context);
  const cache = new Map<string, Promise<{ absolute: string; text: string; lines: string[] }>>();
  const read = async (file: string) => {
    context.signal.throwIfAborted();
    const absolute = await access.resolve(file);
    const cached = cache.get(absolute); if (cached) return cached;
    // 并发批量中的同一实际文件共享读取，缓存 Promise 避免在读取完成前重复打开。
    const task = (async () => {
      const handle = await open(absolute, 'r');
      try {
        if ((await handle.stat()).size > 2 * 1024 * 1024) throw new Error('代码导航文件不能超过 2 MiB。');
        const text = await handle.readFile({ encoding: 'utf8', signal: context.signal });
        // 符号提纲只传全文给语言服务，跳转和引用真正访问行内容时再创建行数组。
        let lines: string[] | undefined;
        return { absolute, text, get lines() { return lines ??= text.split(/\r?\n/); } };
      } finally { await handle.close(); }
    })();
    cache.set(absolute, task);
    try { return await task; }
    catch (error) { if (cache.get(absolute) === task) cache.delete(absolute); throw error; }
  };
  const relative = (absolute: string) => {
    const value = path.relative(context.workspace!.directory, absolute);
    return value === '..' || value.startsWith(`..${path.sep}`) || path.isAbsolute(value) ? absolute : value.replaceAll('\\', '/');
  };
  if (name === 'get_symbols') {
    if (!Array.isArray(args.paths) || !args.paths.length || args.paths.some(file => typeof file !== 'string')) throw new Error('paths 必须包含文件路径。');
    const options = parseSymbolOutlineOptions(args);
    const results: Array<Record<string, any>> = new Array(Math.min(args.paths.length, MAX_SYMBOL_PATHS));
    const outlines = new Map<string, Promise<SymbolOutline>>();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, results.length) }, async () => {
      while (next < results.length) {
        context.signal.throwIfAborted();
        const index = next++; const file = (args.paths as string[])[index];
        try {
          const source = await read(file);
          let outline = outlines.get(source.absolute);
          if (!outline) {
            outline = app.languages.toolRequest(context, source.absolute, source.text, 'textDocument/documentSymbol')
              .then(raw => createSymbolOutline((raw ?? []) as Array<DocumentSymbol | SymbolInformation>, options, 1));
            outlines.set(source.absolute, outline);
          }
          results[index] = { path: file, success: true, ...await outline };
        } catch (error) { context.signal.throwIfAborted(); results[index] = { path: file, success: false, error: String(error) }; }
      }
    }));
    const failCount = results.filter(value => !value.success).length;
    return { success: failCount === 0, data: { results, ...options, successCount: results.length - failCount, failCount, totalCount: args.paths.length,
      totalSymbolCount: results.reduce((sum, value) => sum + (value.symbolCount ?? 0), 0), truncated: args.paths.length > MAX_SYMBOL_PATHS || results.some(value => value.truncated) },
      ...(failCount ? { error: results.filter(value => !value.success).map(value => `${value.path}: ${value.error}`).join('; ') } : {}) };
  }
  const file = String(args.path); const line = Number(args.line); const column = Number.isInteger(args.column) && Number(args.column) > 0 ? Number(args.column) : 1;
  // 先校验分页参数，避免非法 offset 触发无意义的语言服务请求。
  const referenceOptions = name === 'find_references' ? parseReferencePageOptions(args) : undefined;
  const definitionOptions = name === 'goto_definition' ? parseDefinitionPageOptions(args) : undefined;
  const source = await read(file);
  if (!Number.isInteger(line) || line < 1 || line > source.lines.length) throw new Error('行号超出文件范围。');
  const raw = await app.languages.toolRequest(context, source.absolute, source.text, name === 'goto_definition' ? 'textDocument/definition' : 'textDocument/references',
    { position: { line: line - 1, character: column - 1 }, ...(name === 'find_references' ? { context: { includeDeclaration: true } } : {}) });
  const locations = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<Location | LocationLink>;
  const base = { path: file, line, column, symbol: args.symbol };
  if (name === 'goto_definition') {
    const page = await createDefinitionPage(locations, definitionOptions!, async item => {
      context.signal.throwIfAborted();
      const uri = 'targetUri' in item ? item.targetUri : item.uri; const range = 'targetRange' in item ? item.targetRange : item.range;
      let targetPath = uri;
      try {
        const target = await read(fileURLToPath(uri)); targetPath = relative(target.absolute);
        const start = range.start.line; let end = range.end.line;
        if (end - start < 2) end = Math.max(end, findBlockEnd({ lineCount: target.lines.length, lineAt: index => ({ text: target.lines[index] }) }, start));
        end = Math.min(end, target.lines.length - 1);
        return { path: targetPath, line: start + 1, endLine: end + 1, ...definitionSnippet(index => target.lines[index], start, end) };
      } catch (error) { context.signal.throwIfAborted(); return { path: targetPath, line: range.start.line + 1, endLine: range.end.line + 1, content: `(Unable to read file content: ${String(error)})`, lineCount: 0 }; }
    });
    return { success: true, data: { ...base, ...page } };
  }
  const contextLines = typeof args.context === 'number' && Number.isFinite(args.context) ? Math.min(10, Math.max(0, Math.floor(args.context))) : 2;
  const referenceLocations = locations.filter((item): item is Location => 'uri' in item).map(item => {
    // 路径只做 URI 转换，不为统计/排序打开引用文件；真正的正文读取仍经过 FileReadAccess。
    let targetPath = item.uri;
    try { targetPath = relative(fileURLToPath(item.uri)); } catch { /* 非 file URI 保留 provider 标识供定位。 */ }
    return { path: targetPath, line: item.range.start.line + 1, column: item.range.start.character + 1, uri: item.uri };
  });
  const page = await createReferencePage(referenceLocations, referenceOptions!, async item => {
    context.signal.throwIfAborted();
    try {
      const target = await read(fileURLToPath(item.uri));
      return referenceSnippet(target.lines.length, index => target.lines[index], item.line - 1, contextLines);
    } catch (error) { context.signal.throwIfAborted(); return { content: `(Unable to read file content: ${String(error)})` }; }
  });
  return { success: true, data: { ...base, ...page } };
}
