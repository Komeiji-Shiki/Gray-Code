/**
 * builtinLsp.ts
 *
 * Lightweight stand-in for VS Code's LSP providers.
 *
 * GrayCode's lsp tools (get_symbols / goto_definition / find_references) call
 * `vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider' |
 * 'vscode.executeDefinitionProvider' | 'vscode.executeReferenceProvider')`.
 * In the standalone app there is no LSP server, so we provide a fast,
 * regex-based extractor that covers the most common languages. It returns
 * VS Code-shaped DocumentSymbol / Location structures so the backend tools
 * work unchanged.
 */

import * as fsp from 'fs/promises';
import * as path from 'path';
import { Uri, Position, Range, SymbolKind, DocumentSymbol, Location } from './vscode-shim';

interface RawSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  detail?: string;
  children?: RawSymbol[];
}

const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip parsing huge files

const LANG_PATTERNS: Array<{
  exts: string[];
  patterns: Array<{
    kind: SymbolKind;
    regex: RegExp;
    nameGroup: number;
    detailGroup?: number;
  }>;
}> = [
  {
    exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    patterns: [
      { kind: SymbolKind.Interface, regex: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
      { kind: SymbolKind.Class, regex: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
      { kind: SymbolKind.Enum, regex: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
      { kind: SymbolKind.Function, regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
      { kind: SymbolKind.Function, regex: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|[\w$]+\s*=>)/, nameGroup: 1 },
      { kind: SymbolKind.Method, regex: /^\s*(?:(?:public|private|protected|static|async|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/ , nameGroup: 1 },
      { kind: SymbolKind.Variable, regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, nameGroup: 1 },
      { kind: SymbolKind.Namespace, regex: /^\s*(?:export\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$.\-]*)/, nameGroup: 1 },
      { kind: SymbolKind.TypeParameter, regex: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, nameGroup: 1 }
    ]
  },
  {
    exts: ['.py'],
    patterns: [
      { kind: SymbolKind.Function, regex: /^\s*def\s+([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
      { kind: SymbolKind.Class, regex: /^\s*class\s+([A-Za-z_]\w*)/, nameGroup: 1 },
      { kind: SymbolKind.Variable, regex: /^\s*([A-Za-z_]\w*)\s*=\s*(?!=)/, nameGroup: 1 }
    ]
  },
  {
    exts: ['.java', '.kt', '.kts'],
    patterns: [
      { kind: SymbolKind.Class, regex: /^\s*(?:public|private|protected|abstract|final|static)?\s*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, nameGroup: 1 },
      { kind: SymbolKind.Method, regex: /^\s*(?:(?:public|private|protected|static|final|synchronized|abstract)\s+)*(?:[\w<>?,.\[\]]+\s+)*([A-Za-z_]\w*)\s*\([^)]*\)\s*[{]/, nameGroup: 1 },
      { kind: SymbolKind.Function, regex: /^\s*fun\s+([A-Za-z_]\w*)\s*\(/, nameGroup: 1 }
    ]
  },
  {
    exts: ['.go'],
    patterns: [
      { kind: SymbolKind.Function, regex: /^\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*\(/, nameGroup: 1 },
      { kind: SymbolKind.Class, regex: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, nameGroup: 1 }
    ]
  },
  {
    exts: ['.rs'],
    patterns: [
      { kind: SymbolKind.Function, regex: /^\s*(?:pub\s+(?:async\s+)?)?fn\s+([A-Za-z_]\w*)/, nameGroup: 1 },
      { kind: SymbolKind.Class, regex: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, nameGroup: 1 },
      { kind: SymbolKind.Module, regex: /^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)/, nameGroup: 1 }
    ]
  },
  {
    exts: ['.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.swift'],
    patterns: [
      { kind: SymbolKind.Function, regex: /^[A-Za-z_][\w:*&<>,\s]*\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{?$/, nameGroup: 1 },
      { kind: SymbolKind.Class, regex: /^\s*(?:public|private|protected|internal|sealed|abstract|static|final|partial)?\s*(?:class|interface|struct|enum)\s+([A-Za-z_]\w*)/, nameGroup: 1 }
    ]
  },
  {
    exts: ['.rb', '.php', '.sh', '.bash', '.ps1', '.vue', '.sql', '.yml', '.yaml', '.json', '.md', '.txt', '.css', '.scss', '.html', '.xml'],
    patterns: []
  }
];

function getPatterns(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  for (const lang of LANG_PATTERNS) {
    if (lang.exts.includes(ext)) return lang.patterns;
  }
  return LANG_PATTERNS[0].patterns; // default: TS-like
}

export async function getDocumentSymbols(uri: Uri): Promise<DocumentSymbol[]> {
  if (uri.scheme !== 'file') return [];
  let content: string;
  try {
    const stat = await fsp.stat(uri.fsPath);
    if (stat.size > MAX_FILE_BYTES) return [];
    content = await fsp.readFile(uri.fsPath, 'utf-8');
  } catch {
    return [];
  }

  const patterns = getPatterns(uri.fsPath);
  if (patterns.length === 0) return [];

  const lines = content.split('\n');
  const root: RawSymbol[] = [];
  const stack: Array<{ symbol: RawSymbol; indent: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    let matched: { kind: SymbolKind; name: string; detail?: string } | undefined;
    for (const p of patterns) {
      const m = p.regex.exec(line.trimEnd());
      if (m && m[p.nameGroup]) {
        matched = { kind: p.kind, name: m[p.nameGroup], detail: p.detailGroup ? m[p.detailGroup] : undefined };
        break;
      }
    }
    if (!matched) continue;

    // end previous siblings at this depth
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const symbol: RawSymbol = {
      name: matched.name,
      kind: matched.kind,
      line: i,
      endLine: i,
      detail: matched.detail
    };
    if (stack.length > 0) {
      const parent = stack[stack.length - 1].symbol;
      parent.children = parent.children || [];
      parent.children.push(symbol);
      // extend parent end line
      parent.endLine = i;
    } else {
      root.push(symbol);
    }
    // functions/classes may span many lines - track end lazily
    if (matched.kind === SymbolKind.Function || matched.kind === SymbolKind.Class || matched.kind === SymbolKind.Method || matched.kind === SymbolKind.Interface || matched.kind === SymbolKind.Enum) {
      stack.push({ symbol, indent });
    }
  }

  // extend endLine of open containers to the last line
  const lastLine = lines.length - 1;
  const extend = (sym: RawSymbol) => {
    if (sym.endLine === sym.line && sym.kind !== SymbolKind.Variable) sym.endLine = lastLine;
    if (sym.children) sym.children.forEach(extend);
  };
  root.forEach(extend);

  const convert = (sym: RawSymbol): DocumentSymbol => {
    const range = new Range(new Position(sym.line, 0), new Position(sym.endLine, 0));
    const children = (sym.children || []).map(convert);
    return new DocumentSymbol(sym.name, sym.detail || '', sym.kind, range, range, children);
  };

  return root.map(convert);
}

function positionToOffset(content: string, line: number, character: number): number {
  const lines = content.split('\n');
  let offset = 0;
  const target = Math.max(0, Math.min(line, lines.length - 1));
  for (let i = 0; i < target; i++) offset += lines[i].length + 1;
  return offset + Math.max(0, Math.min(character, lines[target]?.length ?? 0));
}

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

export async function getDefinitions(uri: Uri, position: Position): Promise<Location[]> {
  if (uri.scheme !== 'file') return [];
  let content: string;
  try {
    content = await fsp.readFile(uri.fsPath, 'utf-8');
  } catch {
    return [];
  }
  const offset = positionToOffset(content, position.line, position.character);
  const before = content.slice(0, offset);
  IDENT_RE.lastIndex = before.length;
  const m = IDENT_RE.exec(content);
  if (!m) return [];
  const word = m[0];
  return findIdentifierLocations(uri, word);
}

export async function getReferences(uri: Uri, position: Position): Promise<Location[]> {
  if (uri.scheme !== 'file') return [];
  let content: string;
  try {
    content = await fsp.readFile(uri.fsPath, 'utf-8');
  } catch {
    return [];
  }
  const offset = positionToOffset(content, position.line, position.character);
  IDENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let word: string | null = null;
  while ((m = IDENT_RE.exec(content)) !== null) {
    if (m.index <= offset && offset <= m.index + m[0].length) {
      word = m[0];
      break;
    }
  }
  if (!word) return [];
  return findIdentifierLocations(uri, word);
}

async function findIdentifierLocations(uri: Uri, word: string): Promise<Location[]> {
  // 1) current file occurrences
  const locations: Location[] = [];
  try {
    const content = await fsp.readFile(uri.fsPath, 'utf-8');
    IDENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IDENT_RE.exec(content)) !== null && locations.length < 50) {
      if (m[0] === word) {
        const line = content.slice(0, m.index).split('\n').length - 1;
        const lineStart = content.lastIndexOf('\n', m.index - 1) + 1;
        const character = m.index - lineStart;
        locations.push(new Location(uri, new Range(new Position(line, character), new Position(line, character + word.length))));
      }
    }
  } catch {
    // ignore
  }
  return locations;
}
