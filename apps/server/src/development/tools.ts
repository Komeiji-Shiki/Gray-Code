import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from 'node:fs/promises';
import type { RuntimeTool, ToolContext } from '@graycode/core';
import type { DocumentSymbol, SymbolInformation, Location, LocationLink } from 'vscode-languageserver-protocol';
import { createGetSymbolsToolDeclaration, createGotoDefinitionToolDeclaration, createFindReferencesToolDeclaration } from '../../../../backend/tools/lsp/declarations';
import { findBlockEnd } from '../../../../backend/tools/lsp/definitionRange';
import { FileReadAccess } from '../workspace/readAccess';
import type { PlatformApplication } from '../application';
const symbolKinds = ['unknown', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum_member', 'struct', 'event', 'operator', 'type_parameter'];
interface SymbolInfo { name: string; kind: string; line: number; endLine: number; detail?: string; children?: SymbolInfo[] }
/** 保留原声明、批量限制、定义代码范围和按文件分组的引用结果。 */
export function languageTools(app: PlatformApplication): RuntimeTool[] {
  return [createGetSymbolsToolDeclaration(), createGotoDefinitionToolDeclaration(), createFindReferencesToolDeclaration()].map(declaration => ({
    declaration: { name: declaration.name, description: declaration.description, parameters: declaration.parameters },
    effects: () => ['workspace_read', 'process_execute'],
    execute: (args, context) => executeNavigation(app, declaration.name, args, context),
  }));
}
async function executeNavigation(app: PlatformApplication, name: string, args: Record<string, unknown>, context: ToolContext) {
  if (!context.workspace) throw new Error('代码导航需要选择工作区。');
  const access = new FileReadAccess(app, context);
  const cache = new Map<string, { absolute: string; text: string; lines: string[] }>();
  const read = async (file: string) => {
    const absolute = await access.resolve(file);
    const cached = cache.get(absolute); if (cached) return cached;
    const handle = await open(absolute, 'r');
    try {
      if ((await handle.stat()).size > 2 * 1024 * 1024) throw new Error('代码导航文件不能超过 2 MiB。');
      const text = await handle.readFile({ encoding: 'utf8', signal: context.signal });
      const value = { absolute, text, lines: text.split(/\r?\n/) }; cache.set(absolute, value); return value;
    } finally { await handle.close(); }
  };
  const relative = (absolute: string) => {
    const value = path.relative(context.workspace!.directory, absolute);
    return value === '..' || value.startsWith(`..${path.sep}`) || path.isAbsolute(value) ? absolute : value.replaceAll('\\', '/');
  };
  if (name === 'get_symbols') {
    if (!Array.isArray(args.paths) || !args.paths.length || args.paths.some(file => typeof file !== 'string')) throw new Error('paths 必须包含文件路径。');
    const results: Array<Record<string, any>> = new Array(Math.min(args.paths.length, 20));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, results.length) }, async () => {
      while (next < results.length) {
        const index = next++; const file = (args.paths as string[])[index];
        try {
          const source = await read(file);
          const raw = await app.languages.toolRequest(context, source.absolute, source.text, 'textDocument/documentSymbol') as Array<DocumentSymbol | SymbolInformation> | null;
          let count = 0; let truncated = false;
          const convert = (symbol: DocumentSymbol | SymbolInformation): SymbolInfo | undefined => {
            if (count >= 500) { truncated = true; return; } count++;
            const range = 'range' in symbol ? symbol.range : symbol.location.range;
            return { name: symbol.name, kind: symbolKinds[symbol.kind] ?? 'unknown', line: range.start.line + 1, endLine: range.end.line + 1,
              ...('detail' in symbol && symbol.detail ? { detail: symbol.detail } : {}),
              ...('children' in symbol && symbol.children?.length ? { children: symbol.children.map(convert).filter((value): value is SymbolInfo => !!value) } : {}) };
          };
          const symbols = (raw ?? []).map(convert).filter((value): value is SymbolInfo => !!value);
          results[index] = { path: file, success: true, symbols, symbolCount: count, truncated };
        } catch (error) { context.signal.throwIfAborted(); results[index] = { path: file, success: false, error: String(error) }; }
      }
    }));
    const failCount = results.filter(value => !value.success).length;
    return { success: failCount === 0, data: { results, successCount: results.length - failCount, failCount, totalCount: args.paths.length,
      totalSymbolCount: results.reduce((sum, value) => sum + (value.symbolCount ?? 0), 0), truncated: args.paths.length > 20 || results.some(value => value.truncated) },
      ...(failCount ? { error: results.filter(value => !value.success).map(value => `${value.path}: ${value.error}`).join('; ') } : {}) };
  }
  const file = String(args.path); const line = Number(args.line); const column = Number.isInteger(args.column) && Number(args.column) > 0 ? Number(args.column) : 1;
  const source = await read(file);
  if (!Number.isInteger(line) || line < 1 || line > source.lines.length) throw new Error('行号超出文件范围。');
  const raw = await app.languages.toolRequest(context, source.absolute, source.text, name === 'goto_definition' ? 'textDocument/definition' : 'textDocument/references',
    { position: { line: line - 1, character: column - 1 }, ...(name === 'find_references' ? { context: { includeDeclaration: true } } : {}) });
  const locations = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<Location | LocationLink>;
  const base = { path: file, line, column, symbol: args.symbol };
  if (name === 'goto_definition') {
    const definitions: Array<{ path: string; line: number; endLine: number; content: string; lineCount: number }> = [];
    for (const item of locations) {
      context.signal.throwIfAborted();
      const uri = 'targetUri' in item ? item.targetUri : item.uri; const range = 'targetRange' in item ? item.targetRange : item.range;
      let targetPath = uri;
      try {
        const target = await read(fileURLToPath(uri)); targetPath = relative(target.absolute);
        const start = range.start.line; let end = range.end.line;
        if (end - start < 2) end = Math.max(end, findBlockEnd({ lineCount: target.lines.length, lineAt: index => ({ text: target.lines[index] }) }, start));
        end = Math.min(end, target.lines.length - 1);
        const lines = target.lines.slice(start, end + 1).map((text, index) => `${String(start + index + 1).padStart(4)} | ${text}`);
        definitions.push({ path: targetPath, line: start + 1, endLine: end + 1, content: lines.join('\n'), lineCount: lines.length });
      } catch (error) { context.signal.throwIfAborted(); definitions.push({ path: targetPath, line: range.start.line + 1, endLine: range.end.line + 1, content: `(Unable to read file content: ${String(error)})`, lineCount: 0 }); }
    }
    return { success: true, data: { ...base, definitionCount: definitions.length, definitions } };
  }
  const contextLines = typeof args.context === 'number' && Number.isFinite(args.context) ? Math.min(10, Math.max(0, Math.floor(args.context))) : 2;
  const groups = new Map<string, { line: number; column: number; content: string }[]>();
  for (const item of locations.slice(0, 500)) {
    if (!('uri' in item)) continue;
    let targetPath = item.uri; let content = '(Unable to read file content)';
    try {
      const target = await read(fileURLToPath(item.uri)); targetPath = relative(target.absolute);
      const start = Math.max(0, item.range.start.line - contextLines); const end = Math.min(target.lines.length - 1, item.range.start.line + contextLines);
      content = target.lines.slice(start, end + 1).map((text, index) => `${start + index === item.range.start.line ? '>' : ' '}${String(start + index + 1).padStart(4)} | ${text}`).join('\n');
    } catch (error) { context.signal.throwIfAborted(); content = `(Unable to read file content: ${String(error)})`; }
    const references = groups.get(targetPath) ?? []; references.push({ line: item.range.start.line + 1, column: item.range.start.character + 1, content }); groups.set(targetPath, references);
  }
  const references = [...groups].map(([path, values]) => ({ path, count: values.length, references: values.sort((left, right) => left.line - right.line) })).sort((left, right) => right.count - left.count);
  return { success: true, data: { ...base, totalCount: locations.length, fileCount: references.length, references, truncated: locations.length > 500 } };
}
