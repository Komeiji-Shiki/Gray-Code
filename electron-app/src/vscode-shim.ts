/**
 * vscode-shim.ts
 *
 * A minimal, self-consistent reimplementation of the subset of the VS Code
 * extension API that GrayCode's backend actually uses at runtime.
 *
 * The GrayCode backend (backend/ + webview/) is bundled by esbuild with the
 * alias `vscode` -> this module, so the *entire* backend runs unmodified in
 * the Electron main process.
 *
 * Design goals:
 *  - Uri / fsPath round-tripping must be self-consistent (parse <-> toString).
 *  - workspace.fs is backed by Node's fs/promises.
 *  - workspace.getConfiguration('graycode') is backed by a JSON file.
 *  - window.* dialogs / toasts / quick-picks are bridged to the renderer
 *    (or to native Electron dialogs) via the host hook.
 *  - commands.executeCommand handles the vscode.* built-ins used by the
 *    backend (vscode.diff, vscode.open, ...executeDocumentSymbolProvider ...).
 */

import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Host bridge (injected by BackendHost/main process)
// ============================================================================

export interface HostBridge {
  /** Push a `command` message to the renderer, e.g. { command: 'host.toast', data } */
  postCommand(command: string, data?: any): void;
  /** Ask the main process for a native dialog / external open etc. */
  native<T = any>(op: string, payload?: any): Promise<T>;
  /** Resolve the workspace folders list (Electron main process owns it). */
  getWorkspaceFolders(): Array<{ uri: any; name: string; index: number }>;
  /** Called when the vscode.diff command fires. */
  onOpenDiffPreview?: (payload: any) => void;
  /** Called for window.showTextDocument on a file document. */
  onOpenTextDocument?: (uri: any) => void;
  /** Set by host: maps a preview id to the diff session (tool) id. May be async. */
  resolveDiffSessionId?: (previewId: string, filePath?: string) => string | undefined | Promise<string | undefined>;
  /** Resolve the original content of a pending diff (backend auto-open path). May be async. */
  resolveOriginalContent?: (previewId: string, filePath?: string) => string | undefined | Promise<string | undefined>;
}

let bridge: HostBridge | null = null;

export function __setHostBridge(b: HostBridge | null): void {
  bridge = b;
}

function host(): HostBridge | null {
  return bridge;
}

// ============================================================================
// Small helpers
// ============================================================================

export class EventEmitter<T = void> {
  private listeners = new Set<(e: T) => any>();
  // 监听器集合版本号：每次增删 +1。fire 复用它判断迭代期间集合是否变化，
  // 绝大多数 fire（无回调内增删）直接复用上次快照，零分配。
  private listenersVersion = 0;
  private listenersSnapshot: Array<(e: T) => any> | null = null;
  public event = (listener: (e: T) => any): Disposable => {
    this.listeners.add(listener);
    this.listenersVersion++;
    this.listenersSnapshot = null;
    return new Disposable(() => {
      this.listeners.delete(listener);
      this.listenersVersion++;
      this.listenersSnapshot = null;
    });
  };
  fire(e: T): void {
    if (this.listenersSnapshot === null) {
      this.listenersSnapshot = [...this.listeners];
    }
    const snapshot = this.listenersSnapshot;
    const version = this.listenersVersion;
    for (const fn of snapshot) {
      try {
        fn(e);
      } catch (err) {
        console.error('[vscode-shim] event listener error:', err);
      }
    }
    // 迭代期间有回调增删监听器：丢弃缓存，下次 fire 重新取快照
    if (this.listenersVersion !== version) {
      this.listenersSnapshot = null;
    }
  }
  dispose(): void {
    this.listeners.clear();
    this.listenersVersion++;
    this.listenersSnapshot = null;
  }
}

export class Disposable {
  constructor(private fn?: () => void) {}
  dispose(): void {
    if (this.fn) {
      const fn = this.fn;
      this.fn = undefined;
      fn();
    }
  }
}

// ============================================================================
// Uri
// ============================================================================

const WIN32 = process.platform === 'win32';

function encodePath(p: string): string {
  // VS Code encodes each path segment with encodeURIComponent, keeping '/'.
  if (!p) return p;
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

function decodePath(p: string): string {
  return p.split('/').map((seg) => safeDecodeURIComponent(seg)).join('/');
}

function safeDecodeURIComponent(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function pathToFsPath(p: string): string {
  // p is a posix-style path (decoded)
  if (WIN32) {
    if (/^\/[a-zA-Z]:(\/|$)/.test(p)) {
      // /c:/... -> c:\...
      return p.slice(1).replace(/\//g, '\\');
    }
    // UNC or other rooted paths: keep leading slashes as backslashes
    return p.replace(/\//g, '\\');
  }
  return p;
}

function fsPathToPath(fsPath: string): string {
  if (WIN32) {
    const normalized = fsPath.replace(/\\/g, '/');
    if (/^[a-zA-Z]:/.test(normalized)) {
      return '/' + normalized;
    }
    if (normalized.startsWith('//')) {
      return normalized; // UNC share
    }
    return '/' + normalized;
  }
  return fsPath;
}

export class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string; // decoded, posix-style
  readonly query: string;
  readonly fragment: string;
  readonly fsPath: string;

  private constructor(parts: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string; fsPath?: string }) {
    this.scheme = parts.scheme;
    this.authority = parts.authority || '';
    this.path = parts.path || '';
    this.query = parts.query || '';
    this.fragment = parts.fragment || '';
    this.fsPath = parts.fsPath ?? (this.scheme === 'file' ? pathToFsPath(this.path) : '');
  }

  static file(fsPath: string): Uri {
    const p = fsPathToPath(fsPath);
    return new Uri({ scheme: 'file', path: p, fsPath });
  }

  static parse(value: string): Uri {
    let rest = value;
    let fragment = '';
    const fragIdx = rest.indexOf('#');
    if (fragIdx >= 0) {
      fragment = rest.slice(fragIdx + 1);
      rest = rest.slice(0, fragIdx);
    }
    let query = '';
    const qIdx = rest.indexOf('?');
    if (qIdx >= 0) {
      query = rest.slice(qIdx + 1);
      rest = rest.slice(0, qIdx);
    }
    const colonIdx = rest.indexOf(':');
    let scheme = '';
    if (colonIdx > 0) {
      scheme = rest.slice(0, colonIdx);
      rest = rest.slice(colonIdx + 1);
    }
    let authority = '';
    if (rest.startsWith('//')) {
      const slashIdx = rest.indexOf('/', 2);
      if (slashIdx < 0) {
        authority = rest.slice(2);
        rest = '';
      } else {
        authority = rest.slice(2, slashIdx);
        rest = rest.slice(slashIdx);
      }
    }
    // Handle file URIs that are not encoded (e.g. file:///c:/Users/x)
    // path 保持解码态原样透传：pathToFsPath 会按 WIN32 规则把 /c:/... 或 c:/...
    // 统一转成盘符路径，这里无需特殊处理
    const decodedPath = decodePath(rest);
    return new Uri({ scheme, authority, path: decodedPath, query, fragment });
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const basePath = base.path;
    const joined = path.posix.normalize([basePath, ...segments].join('/'));
    return new Uri({
      scheme: base.scheme,
      authority: base.authority,
      path: joined,
      query: base.query,
      fragment: base.fragment,
      fsPath: base.scheme === 'file' ? pathToFsPath(joined) : undefined
    });
  }

  with(changes: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri({
      scheme: changes.scheme ?? this.scheme,
      authority: changes.authority ?? this.authority,
      path: changes.path ?? this.path,
      query: changes.query ?? this.query,
      fragment: changes.fragment ?? this.fragment
    });
  }

  toString(_skipEncoding?: boolean): string {
    let s = this.scheme + ':';
    // VS Code always renders file URIs with the authority part (file:///...),
    // even when the authority is empty. Frontend utils rely on `file://`.
    if (this.authority || this.scheme === 'file') {
      s += '//';
    }
    s += encodePath(this.path);
    if (this.query) {
      s += '?' + this.query;
    }
    if (this.fragment) {
      s += '#' + this.fragment;
    }
    return s;
  }

  toJSON(): string {
    return this.toString();
  }
}

// ============================================================================
// Enums / simple value types
// ============================================================================

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9
}

export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25
}

export enum ExtensionMode {
  Development = 1,
  Test = 2,
  Production = 3
}

export enum CodeActionKind {
  Empty = '',
  QuickFix = 'quickfix',
  Refactor = 'refactor',
  RefactorExtract = 'refactor.extract',
  RefactorInline = 'refactor.inline',
  RefactorMove = 'refactor.move',
  RefactorRewrite = 'refactor.rewrite',
  Source = 'source',
  SourceOrganizeImports = 'source.organizeImports',
  SourceFixAll = 'source.fixAll'
}

export enum TextDocumentSaveReason {
  Manual = 1,
  AfterDelay = 2,
  FocusOut = 3
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
  isBefore(other: Position): boolean {
    return other.line > this.line || (other.line === this.line && other.character > this.character);
  }
  isBeforeOrEqual(other: Position): boolean {
    return this.isBefore(other) || (this.line === other.line && this.character === other.character);
  }
  isAfter(other: Position): boolean {
    return !this.isBeforeOrEqual(other);
  }
  isAfterOrEqual(other: Position): boolean {
    return !this.isBefore(other);
  }
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(start: Position | number, end: Position | number, endLine?: number, endCharacter?: number) {
    if (typeof start === 'number') {
      this.start = new Position(start, end as number);
      this.end = new Position(endLine as number, endCharacter as number);
    } else {
      this.start = start;
      this.end = end as Position;
    }
  }
  get isEmpty(): boolean {
    return this.start.isEqual(this.end);
  }
  get isSingleLine(): boolean {
    return this.start.line === this.end.line;
  }
  contains(positionOrRange: Position | Range): boolean {
    if (positionOrRange instanceof Range) {
      return this.start.isBeforeOrEqual(positionOrRange.start) && this.end.isAfterOrEqual(positionOrRange.end);
    }
    return this.start.isBeforeOrEqual(positionOrRange) && this.end.isAfterOrEqual(positionOrRange);
  }
  static isRange(thing: any): thing is Range {
    return !!thing && thing.start instanceof Position && thing.end instanceof Position;
  }
}

export class Selection extends Range {
  constructor(
    readonly anchor: Position,
    readonly active: Position
  ) {
    super(anchor, active);
  }
  get isReversed(): boolean {
    // 选区反向：anchor 位于 active 之后。原实现比较 anchor === end 恒不成立
    // （anchor/active 是构造时传入的独立对象），按 vscode 语义改为 isAfter 判断。
    return this.anchor.isAfter(this.active);
  }
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  value = '';
  constructor(value?: string) {
    if (value) this.value = value;
  }
  appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }
  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }
}

export class TabInputText {
  constructor(readonly uri: Uri) {}
}

export class TabInputTextDiff {
  constructor(
    readonly original: TabInputText,
    readonly modified: TabInputText
  ) {}
}

export class Location {
  constructor(
    readonly uri: Uri,
    readonly range: Range
  ) {}
}

export class LocationLink {
  originSelectionRange?: Range;
  constructor(
    readonly targetUri: Uri,
    readonly targetRange: Range,
    readonly targetSelectionRange?: Range
  ) {}
}

export class DocumentSymbol {
  constructor(
    readonly name: string,
    readonly detail: string,
    readonly kind: SymbolKind,
    readonly range: Range,
    readonly selectionRange: Range,
    readonly children: DocumentSymbol[] = []
  ) {}
}

export class CodeLens {
  constructor(readonly range: Range, readonly command?: any) {}
}

export class WorkspaceEdit {
  private entries: Map<string, { version?: number; edits: Array<{ range: Range; newText: string }> }> = new Map();
  insert(uri: Uri, position: Position, newText: string): void {
    this.replace(uri, new Range(position, position), newText);
  }
  replace(uri: Uri, range: Range, newText: string): void {
    const key = uri.toString();
    const entry = this.entries.get(key) || { edits: [] };
    entry.edits.push({ range, newText });
    this.entries.set(key, entry);
  }
  delete(uri: Uri, range: Range): void {
    this.replace(uri, range, '');
  }
  has(uri: Uri): boolean {
    return this.entries.has(uri.toString());
  }
  get(uri: Uri): Array<{ range: Range; newText: string }> {
    return this.entries.get(uri.toString())?.edits || [];
  }
  entriesIterator(): IterableIterator<[Uri, { version?: number; edits: Array<{ range: Range; newText: string }> }]> {
    const out: Array<[Uri, { version?: number; edits: Array<{ range: Range; newText: string }> }]> = [];
    for (const [key, value] of this.entries) {
      out.push([Uri.parse(key), value]);
    }
    return out[Symbol.iterator]();
  }
}

export class CancellationToken {
  private emitter = new EventEmitter<void>();
  private _isCancellationRequested = false;
  public isCancellationRequested = false;
  public onCancellationRequested = this.emitter.event;
  constructor(public token?: AbortSignal) {
    if (token) {
      if (token.aborted) this.cancel();
      else token.addEventListener('abort', () => this.cancel(), { once: true });
    }
  }
  cancel(): void {
    if (this._isCancellationRequested) return;
    this._isCancellationRequested = true;
    this.isCancellationRequested = true;
    this.emitter.fire(undefined);
  }
}

export class RelativePattern {
  readonly baseUri: Uri;
  readonly base: string;
  readonly pattern: string;
  constructor(base: Uri | string, pattern: string) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base;
    this.base = this.baseUri.fsPath;
    this.pattern = pattern;
  }
}

// ============================================================================
// Configuration (JSON-file backed)
// ============================================================================

class JsonConfigStore {
  private filePath: string;
  private cache: Record<string, any> = {};
  private writeQueue: Promise<void> = Promise.resolve();
  private loaded = false;
  readonly onDidChange = new EventEmitter<void>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Synchronous load (the vscode `WorkspaceConfiguration.get()` API is sync). */
  private loadSync(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      this.cache = JSON.parse(raw);
    } catch {
      this.cache = {};
    }
  }

  async preload(): Promise<void> {
    this.loadSync();
  }

  private save(): void {
    const content = JSON.stringify(this.cache, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = this.filePath + '.tmp';
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsp.writeFile(tmp, content, 'utf-8');
      await fsp.rename(tmp, this.filePath);
    }).catch((err) => {
      console.error('[vscode-shim] failed to persist config:', err);
    });
  }

  getRawSync(): Record<string, any> {
    this.loadSync();
    return this.cache;
  }

  getSync(section: string, key: string, fallback?: any): any {
    this.loadSync();
    const sectionData = this.cache[section];
    if (sectionData && key in sectionData) return sectionData[key];
    return fallback;
  }

  async set(section: string, key: string, value: any): Promise<void> {
    this.loadSync();
    const sectionData = this.cache[section] ?? {};
    if (value === undefined) {
      delete sectionData[key];
    } else {
      sectionData[key] = value;
    }
    this.cache[section] = sectionData;
    this.save();
    await this.writeQueue;
    this.onDidChange.fire(undefined);
  }
}

// ============================================================================
// TextDocument
// ============================================================================

interface TextDocumentLike {
  uri: Uri;
  getText(range?: Range): string;
  lineCount: number;
  lineAt(line: number): { text: string; range: Range };
  isUntitled: boolean;
  languageId: string;
  fileName: string;
  isClosed: boolean;
  save(): Promise<boolean>;
}

class TextDocumentImpl implements TextDocumentLike {
  readonly uri: Uri;
  readonly isUntitled = false;
  readonly isClosed = false;
  private content: string;
  private lineStarts: number[];

  constructor(uri: Uri, content: string) {
    this.uri = uri;
    this.__setContent(content);
  }

  __setContent(content: string): void {
    this.content = content;
    this.lineStarts = [0];
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  get isDirty(): boolean {
    return false;
  }

  get fileName(): string {
    return this.uri.fsPath || this.uri.path;
  }

  get languageId(): string {
    const ext = path.extname(this.fileName).toLowerCase();
    const map: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact',
      '.mjs': 'javascript', '.cjs': 'javascript', '.json': 'json', '.md': 'markdown', '.vue': 'vue',
      '.py': 'python', '.html': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less', '.yaml': 'yaml',
      '.yml': 'yaml', '.xml': 'xml', '.rs': 'rust', '.go': 'go', '.java': 'java', '.c': 'c', '.h': 'c',
      '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
      '.kt': 'kotlin', '.kts': 'kotlin', '.sh': 'shellscript', '.bash': 'shellscript', '.ps1': 'powershell',
      '.sql': 'sql', '.toml': 'toml', '.ini': 'ini', '.cfg': 'ini', '.txt': 'plaintext', '.gitignore': 'plaintext'
    };
    return map[ext] || 'plaintext';
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  lineAt(line: number): { text: string; range: Range } {
    if (line < 0 || line >= this.lineStarts.length) {
      throw new Error(`Line index out of range: ${line}`);
    }
    const start = this.lineStarts[line];
    const end = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] - 1 : this.content.length;
    let text = this.content.slice(start, end);
    if (text.endsWith('\r')) text = text.slice(0, -1);
    return {
      text,
      range: new Range(new Position(line, 0), new Position(line, text.length))
    };
  }

  getText(range?: Range): string {
    if (!range) return this.content;
    const startOffset = this.lineStarts[range.start.line] + range.start.character;
    const endOffset = this.lineStarts[range.end.line] + range.end.character;
    return this.content.slice(startOffset, endOffset);
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(offset, this.content.length));
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid] <= clamped) low = mid;
      else high = mid - 1;
    }
    return new Position(low, clamped - this.lineStarts[low]);
  }

  offsetAt(position: Position): number {
    const line = Math.max(0, Math.min(position.line, this.lineStarts.length - 1));
    return this.lineStarts[line] + Math.max(0, position.character);
  }

  async save(): Promise<boolean> {
    if (this.uri.scheme === 'file' && this.uri.fsPath) {
      await fsp.writeFile(this.uri.fsPath, this.content, 'utf-8');
      return true;
    }
    return false;
  }
}

// ============================================================================
// workspace
// ============================================================================

const textDocumentProviderSchemes = new Map<string, any>();

function fileStatToVSCode(stat: fs.Stats): { type: FileType; size: number; mtime: number; ctime: number } {
  let type = FileType.Unknown;
  if (stat.isFile()) type = FileType.File;
  else if (stat.isDirectory()) type = FileType.Directory;
  else if (stat.isSymbolicLink()) type = FileType.SymbolicLink;
  return { type, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
}

async function uriToFsPath(uri: Uri): Promise<string> {
  if (uri.scheme === 'file') return uri.fsPath;
  if (textDocumentProviderSchemes.has(uri.scheme)) {
    // virtual documents have no fsPath - callers must not use fs ops on them
    throw new Error(`Cannot use file-system API on virtual scheme "${uri.scheme}"`);
  }
  throw new Error(`Unsupported URI scheme: ${uri.scheme}`);
}

export interface WorkspaceFolder {
  uri: Uri;
  name: string;
  index: number;
  fsPath: string;
}

let workspaceFolderUris: string[] = [];
// 缓存构建好的 WorkspaceFolder 数组（含 Uri 对象）：getter 每次访问都重新
// Uri.file + 编码会反复分配；调用方只读（find/map/[0]/length），可直接复用。
let cachedWorkspaceFolders: WorkspaceFolder[] = [];

export function __setWorkspaceFolders(fsPaths: string[]): void {
  const next = [...fsPaths];
  const prev = workspaceFolderUris;
  // 按新旧列表差集生成 added/removed：避免把保留的文件夹重复报为 added（技能重复扫描），
  // 也让被移除的文件夹触发 removed 清理（此前 removed 恒为空）。
  // Windows 路径大小写不敏感：C:\Foo 与 c:\foo 是同一文件夹，
  // 收藏/恢复链路中路径大小写可能漂移，若按大小写敏感比较会误报 added+removed。
  const norm = (p: string) => (WIN32 ? p.replace(/\\/g, '/').toLowerCase() : p);
  const prevSet = new Set(prev.map(norm));
  const nextSet = new Set(next.map(norm));
  const addedPaths = next.filter(p => !prevSet.has(norm(p)));
  const removedPaths = prev.filter(p => !nextSet.has(norm(p)));
  workspaceFolderUris = next;
  cachedWorkspaceFolders = next.map((fsPath, index) => buildWorkspaceFolder(fsPath, index));
  workspaceOnDidChangeFolders.fire({
    added: addedPaths.map(p => buildWorkspaceFolder(p, next.indexOf(p))),
    removed: removedPaths.map(p => buildWorkspaceFolder(p, prev.indexOf(p)))
  });
}

function buildWorkspaceFolder(fsPath: string, index: number): WorkspaceFolder {
  return {
    uri: Uri.file(fsPath),
    name: path.basename(fsPath) || fsPath,
    index,
    // VS Code's WorkspaceFolder has no `fsPath`, but GrayCode's backend reads
    // folder.fsPath directly in several places (CheckpointManager, tool path
    // resolution, uri containment checks). Provide it so those paths work.
    fsPath
  };
}

function getWorkspaceFolders(): WorkspaceFolder[] {
  return cachedWorkspaceFolders;
}

const workspaceOnDidChangeFolders = new EventEmitter<{ added: WorkspaceFolder[]; removed: WorkspaceFolder[] }>();
const workspaceOnDidChangeConfiguration = new EventEmitter<void>();
const workspaceOnDidOpenTextDocument = new EventEmitter<TextDocumentLike>();
const workspaceOnDidCloseTextDocument = new EventEmitter<TextDocumentLike>();
const workspaceOnDidChangeTextDocument = new EventEmitter<any>();
const workspaceOnDidSaveTextDocument = new EventEmitter<TextDocumentLike>();

let configStore: JsonConfigStore | null = null;

export function __initConfigStore(filePath: string): void {
  if (configStore) return;
  configStore = new JsonConfigStore(filePath);
}

function getConfigStore(): JsonConfigStore {
  if (!configStore) {
    // Fallback: in-memory only (should not happen in production flow)
    configStore = new JsonConfigStore(path.join(process.cwd(), '.graycode-config.json'));
  }
  return configStore;
}

/** Read a setting under the `graycode` section (sync, best-effort). */
function getConfigValue(key: string, defaultValue?: any): any {
  try {
    const val = getConfigStore().getSync('graycode', key);
    return val !== undefined ? val : defaultValue;
  } catch {
    return defaultValue;
  }
}

function makeWorkspaceConfiguration(section: string) {
  return {
    get: (key: string, defaultValue?: any) => {
      const store = getConfigStore();
      const val = store.getSync(section, key);
      if (val !== undefined) {
        if (key === 'toolsEnabled' && typeof val !== 'object') return {};
        return val;
      }
      return defaultValue;
    },
    has: (key: string) => {
      const store = getConfigStore();
      return store.getSync(section, key) !== undefined;
    },
    update: async (key: string, value: any, _target?: ConfigurationTarget): Promise<void> => {
      const store = getConfigStore();
      await store.set(section, key, value);
    },
    inspect: (key: string) => {
      const store = getConfigStore();
      const globalValue = store.getSync(section, key);
      return {
        key,
        defaultValue: undefined,
        globalValue,
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
        defaultLanguageValue: undefined,
        globalLanguageValue: undefined,
        workspaceLanguageValue: undefined,
        workspaceFolderLanguageValue: undefined,
        languageIds: undefined
      };
    }
  };
}

function findWorkspaceFolderForUri(uri: Uri): WorkspaceFolder | undefined {
  const fsPath = uri.scheme === 'file' ? uri.fsPath : undefined;
  if (!fsPath) return undefined;
  const norm = (p: string) => (WIN32 ? p.replace(/\\/g, '/').toLowerCase() : p);
  const target = norm(fsPath);
  return getWorkspaceFolders().find((f) => {
    const root = norm(f.fsPath);
    return target === root || target.startsWith(root.endsWith('/') ? root : root + '/');
  });
}

function asRelativePath(uri: Uri, includeWorkspace: boolean = false): string {
  const folder = findWorkspaceFolderForUri(uri);
  if (!folder || uri.scheme !== 'file') return uri.fsPath || uri.toString();
  let rel = path.relative(folder.fsPath, uri.fsPath).replace(/\\/g, '/');
  if (!rel) rel = '.';
  if (includeWorkspace && getWorkspaceFolders().length > 1) {
    rel = `${folder.name}/${rel}`;
  }
  return rel;
}

// ---- glob support for findFiles ----

function globToRegExpSource(pattern: string): string {
  let out = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // **  (with optional trailing /)
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end > i) {
        const inner = pattern
          .slice(i + 1, end)
          .split(',')
          .map((part) => globToRegExpSource(part))
          .join('|');
        out += '(?:' + inner + ')';
        i = end + 1;
      } else {
        out += '\\{';
        i += 1;
      }
    } else {
      out += c.replace(/[.+^$[\]\\()|/-]/g, '\\$&');
      i += 1;
    }
  }
  return out;
}

function globToRegExp(pattern: string): RegExp {
  // 注意：{a,b} 分支必须用未锚定的源码拼接，递归调用带 ^$ 的完整
  // RegExp 会得到 (?:^a$|^b$)，内嵌锚点在中间永远匹配不上。
  return new RegExp('^' + globToRegExpSource(pattern) + '$');
}

async function findFilesImpl(include: string | RelativePattern, exclude: string | undefined, maxResults: number): Promise<Uri[]> {
  const folders = getWorkspaceFolders();
  if (maxResults <= 0) return [];
  const includeRe = include instanceof RelativePattern ? globToRegExp(include.pattern) : globToRegExp(include);
  const excludeList = exclude ? exclude.replace(/^\{|\}$/g, '').split(',').filter(Boolean).map((p) => globToRegExp(p.trim())) : [];
  // 默认跳过列表可通过设置 graycode.findFilesSkipDirs 覆盖（与 VS Code 中受 files.exclude/search.exclude
  // 控制的语义对齐）。默认不跳 dist/build/.next/out——AI 常需要检查构建产物。
  const configured = getConfigValue('findFilesSkipDirs', []);
  const skipDirNames = new Set(
    Array.isArray(configured) && configured.length > 0
      ? configured.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : ['node_modules', '.git', '__pycache__', '.cache', 'coverage', '.svn', '.hg', '.vscode', '.idea', '.next', '.nuxt', '.turbo']
  );
  const results: Uri[] = [];
  const seen = new Set<string>();

  const walkRoot = async (root: string) => {
    const queue: string[] = [root];
    let head = 0;
    const walkOne = async (): Promise<void> => {
      for (;;) {
        if (results.length >= maxResults) return;
        // 先判空再消费：空队列时不得推进 head，否则并发 worker 会烧掉
        // 后续由其他 worker 压入的目录索引，导致深层目录永远不被访问。
        const idx = head;
        if (idx >= queue.length) return;
        head = idx + 1;
        const dir = queue[idx];
        let entries: fs.Dirent[];
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (results.length >= maxResults) return;
          const full = path.join(dir, entry.name);
          const rel = path.relative(root, full).replace(/\\/g, '/');
          if (entry.isDirectory()) {
            if (skipDirNames.has(entry.name)) continue;
            queue.push(full);
          } else if (entry.isFile()) {
            if (excludeList.some((re) => re.test(rel))) continue;
            if (includeRe.test(rel)) {
              // 用绝对路径做去重键：多根工作区下不同根的相同相对路径不应互相吞掉
              const key = WIN32 ? full.toLowerCase() : full;
              if (!seen.has(key)) {
                seen.add(key);
                results.push(Uri.file(full));
              }
            }
          }
        }
      }
    };
    // 受控并发遍历：readdir 是异步 IO，逐目录串行在大仓库上等价于 目录数×单次 readdir 延迟；
    // 8 路并发把总延迟压到 ~深度×单次延迟，结果顺序对调用方无要求（后端会再排序）。
    await Promise.all(Array.from({ length: 8 }, () => walkOne()));
  };

  if (include instanceof RelativePattern) {
    if (include.base) await walkRoot(include.base);
  } else {
    for (const folder of folders) {
      await walkRoot(folder.fsPath);
      if (results.length >= maxResults) break;
    }
  }
  return results.slice(0, maxResults);
}

// ---- workspace.fs ----

const workspaceFs = {
  async stat(uri: Uri): Promise<{ type: FileType; size: number; mtime: number; ctime: number }> {
    const fsPath = await uriToFsPath(uri);
    return fileStatToVSCode(await fsp.stat(fsPath));
  },
  async readFile(uri: Uri): Promise<Uint8Array> {
    const fsPath = await uriToFsPath(uri);
    const buffer = await fsp.readFile(fsPath);
    // 零拷贝视图：避免大文件（搜索/分段历史可达数 MB）整份复制。
    // Node 的 Buffer 是 Uint8Array 子类，返回 view 后调用方 Buffer.from()/subarray 语义不变。
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  },
  async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
    const fsPath = await uriToFsPath(uri);
    const data = content instanceof Uint8Array && !(content instanceof Buffer) ? Buffer.from(content.buffer, content.byteOffset, content.byteLength) : content;
    await fsp.mkdir(path.dirname(fsPath), { recursive: true });
    await fsp.writeFile(fsPath, data);
  },
  async createDirectory(uri: Uri): Promise<void> {
    const fsPath = await uriToFsPath(uri);
    await fsp.mkdir(fsPath, { recursive: true });
  },
  async readDirectory(uri: Uri): Promise<Array<[string, FileType]>> {
    const fsPath = await uriToFsPath(uri);
    const entries = await fsp.readdir(fsPath, { withFileTypes: true });
    return entries
      .map((e): [string, FileType] => {
        let type = FileType.Unknown;
        if (e.isFile()) type = FileType.File;
        else if (e.isDirectory()) type = FileType.Directory;
        else if (e.isSymbolicLink()) type = FileType.SymbolicLink;
        return [e.name, type];
      })
      .sort((a, b) => a[0].localeCompare(b[0]));
  },
  async delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    const fsPath = await uriToFsPath(uri);
    if (options?.useTrash === true) {
      // 与 VS Code 语义一致：useTrash 时进回收站，避免删除工具永久删除文件（M-3）
      const { shell } = await import('electron');
      await shell.trashItem(fsPath);
      return;
    }
    await fsp.rm(fsPath, { recursive: options?.recursive === true, force: true });
  },
  async rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
    const src = await uriToFsPath(source);
    const dst = await uriToFsPath(target);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    if (options?.overwrite) {
      try {
        await fsp.rm(dst, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    await fsp.rename(src, dst);
  },
  async copy(source: Uri, target: Uri, options?: { overwrite?: boolean }): Promise<void> {
    const src = await uriToFsPath(source);
    const dst = await uriToFsPath(target);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    // 与 VS Code 契约一致：overwrite=false（缺省）时目标已存在应报错，绝不静默覆盖；
    // Node 的 fsp.cp 在 force:false 且目标存在时抛 ERR_FS_CP_EEXIST，符合该语义
    if (options?.overwrite) {
      try {
        await fsp.rm(dst, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    await fsp.cp(src, dst, { recursive: true, force: options?.overwrite === true });
  },
  async isWritableFileSystem(_scheme: string): Promise<boolean> {
    return true;
  }
};

async function openTextDocument(uriOrPath: Uri | string): Promise<TextDocumentLike> {
  const uri = typeof uriOrPath === 'string' ? Uri.file(uriOrPath) : uriOrPath;
  let doc: TextDocumentImpl;
  if (textDocumentProviderSchemes.has(uri.scheme)) {
    const provider = textDocumentProviderSchemes.get(uri.scheme);
    const content = provider.provideTextDocumentContent(uri) || '';
    doc = new TextDocumentImpl(uri, content);
  } else if (uri.scheme === 'file') {
    const content = await fsp.readFile(uri.fsPath, 'utf-8');
    doc = new TextDocumentImpl(uri, content);
  } else {
    throw new Error(`Cannot open document with scheme "${uri.scheme}"`);
  }
  documentCache.set(uri.toString(), doc);
  // LRU 上限：长会话中 AI 反复读取文件会持续累积文档缓存，无上限会膨胀到 GB 级（M-7）
  const MAX_DOCUMENT_CACHE = 100;
  while (documentCache.size > MAX_DOCUMENT_CACHE) {
    const oldest = documentCache.keys().next().value;
    if (oldest === undefined) break;
    documentCache.delete(oldest);
  }
  return doc;
}

const documentCache = new Map<string, TextDocumentImpl>();

function getTextDocuments(): TextDocumentLike[] {
  return [...documentCache.values()];
}

async function applyEditImpl(edit: WorkspaceEdit): Promise<boolean> {
  const changed = new Map<Uri, string>();
  for (const [uri, entry] of edit.entriesIterator()) {
    if (uri.scheme !== 'file' || !uri.fsPath) continue;
    let content: string;
    try {
      content = await fsp.readFile(uri.fsPath, 'utf-8');
    } catch (error: any) {
      // ENOENT 不再静默按空文件重建：对已删除文件的编辑会悄悄写出残缺文件（M-4）
      if (error?.code === 'ENOENT') {
        throw new Error(`Cannot apply edits: file does not exist: ${uri.fsPath}`);
      }
      throw error;
    }
    const tempDoc = new TextDocumentImpl(uri, content);
    const edits = [...entry.edits].sort((a, b) => {
      const aStart = tempDoc.offsetAt(a.range.start);
      const bStart = tempDoc.offsetAt(b.range.start);
      return bStart - aStart;
    });
    for (const e of edits) {
      const start = tempDoc.offsetAt(e.range.start);
      const end = tempDoc.offsetAt(e.range.end);
      content = content.slice(0, start) + e.newText + content.slice(end);
    }
    await fsp.writeFile(uri.fsPath, content, 'utf-8');
    changed.set(uri, content);
  }
  if (changed.size > 0) {
    for (const [uri, content] of changed) {
      const cached = documentCache.get(uri.toString());
      if (cached) {
        cached.__setContent(content);
        workspaceOnDidChangeTextDocument.fire({ document: cached });
      }
    }
  }
  return true;
}

export const workspace = {
  get workspaceFolders(): WorkspaceFolder[] {
    return getWorkspaceFolders();
  },
  get workspaceFile(): null {
    return null;
  },
  get textDocuments(): TextDocumentLike[] {
    return getTextDocuments();
  },
  fs: workspaceFs,
  getConfiguration: (section?: string) => makeWorkspaceConfiguration(section || ''),
  getWorkspaceFolder: (uri: Uri): WorkspaceFolder | undefined => findWorkspaceFolderForUri(uri),
  asRelativePath: (uri: Uri, includeWorkspace?: boolean): string => asRelativePath(uri, includeWorkspace),
  async openTextDocument(uriOrPath: Uri | string): Promise<TextDocumentLike> {
    const doc = await openTextDocument(uriOrPath);
    workspaceOnDidOpenTextDocument.fire(doc);
    return doc;
  },
  registerTextDocumentContentProvider(scheme: string, provider: any): Disposable {
    textDocumentProviderSchemes.set(scheme, provider);
    return new Disposable(() => textDocumentProviderSchemes.delete(scheme));
  },
  async findFiles(include: string | RelativePattern, exclude?: string, maxResults?: number, _token?: any): Promise<Uri[]> {
    return findFilesImpl(include, exclude, maxResults ?? 200);
  },
  onDidChangeWorkspaceFolders: workspaceOnDidChangeFolders.event,
  onDidChangeConfiguration: workspaceOnDidChangeConfiguration.event,
  onDidOpenTextDocument: workspaceOnDidOpenTextDocument.event,
  onDidCloseTextDocument: workspaceOnDidCloseTextDocument.event,
  onDidChangeTextDocument: workspaceOnDidChangeTextDocument.event,
  onDidSaveTextDocument: workspaceOnDidSaveTextDocument.event,
  onWillSaveTextDocument: () => new Disposable(),
  getWorkspaceFolderByName(name: string): WorkspaceFolder | undefined {
    return getWorkspaceFolders().find((f) => f.name.toLowerCase() === name.toLowerCase());
  },
  applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    return applyEditImpl(edit);
  }
};

// ============================================================================
// window
// ============================================================================

const windowOnDidChangeActiveTextEditor = new EventEmitter<any>();
const windowOnDidCloseTerminal = new EventEmitter<any>();
const windowOnDidWriteTerminalData = new EventEmitter<any>();
const windowOnDidOpenTerminal = new EventEmitter<any>();
const windowOnDidChangeActiveTerminal = new EventEmitter<any>();
const windowOnDidChangeVisibleTextEditors = new EventEmitter<any>();
const windowOnDidChangeTextEditorSelection = new EventEmitter<any>();
const windowOnDidChangeTextEditorVisibleRanges = new EventEmitter<any>();
const windowOnDidChangeWindowState = new EventEmitter<{ focused: boolean }>();

let windowFocused = true;

export function __setWindowFocused(focused: boolean): void {
  if (windowFocused === focused) return;
  windowFocused = focused;
  windowOnDidChangeWindowState.fire({ focused: windowFocused });
}

interface PendingToast {
  resolve: (value: any) => void;
  clearTtl: () => void;
}

// Bridge: renderer replies on these ids (via host.native)
let toastCounter = 0;
const pendingToasts = new Map<number, PendingToast>();
// 等待 toast 回复的超时：渲染层（或整个渲染进程）挂掉后 pendingToasts 只增不删，
// 对应等待的 Promise 永远不 resolve，调用方（工具调用等）会永久挂起。
// TTL 过期后按“未选择/取消”处理（resolve(undefined)），与渲染层返回 undefined 语义一致。
const TOAST_TTL_MS = 5 * 60 * 1000;
// pendingToasts 硬上限：渲染层异常或大量并发 toast 会让 Map 无界增长，
// 超出后淘汰最旧条目（按“未选择/取消”处理），与 TTL 过期语义一致
const PENDING_TOASTS_MAX = 100;

function setToastTtl(id: number, pending: PendingToast): void {
  const ttl = setTimeout(() => {
    const p = pendingToasts.get(id);
    if (p) {
      pendingToasts.delete(id);
      p.resolve(undefined);
    }
  }, TOAST_TTL_MS);
  pending.clearTtl = () => clearTimeout(ttl);
}

function evictOldestToastIfFull(): void {
  if (pendingToasts.size < PENDING_TOASTS_MAX) return;
  const oldest = pendingToasts.keys().next().value;
  if (oldest === undefined) return;
  const p = pendingToasts.get(oldest);
  pendingToasts.delete(oldest);
  p?.clearTtl();
  p?.resolve(undefined);
}

function showMessage(type: 'info' | 'warning' | 'error', message: string, options?: any, items: any[] = []): Promise<any> {
  return new Promise((resolve) => {
    const id = ++toastCounter;
    const pending: PendingToast = { resolve, clearTtl: () => undefined };
    evictOldestToastIfFull();
    pendingToasts.set(id, pending);
    setToastTtl(id, pending);
    const h = host();
    if (h) {
      h.postCommand('host.toast', { id, type, message, detail: options?.detail, items });
    } else {
      console[type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'log'](`[GrayCode] ${message}`);
      pendingToasts.delete(id);
      pending.clearTtl();
      resolve(undefined);
    }
  });
}

export function __resolveToast(id: number, selected: any): void {
  const pending = pendingToasts.get(id);
  if (pending) {
    pendingToasts.delete(id);
    pending.clearTtl();
    pending.resolve(selected);
  }
}

function showQuickPick(items: any[], options?: any): Promise<any> {
  return new Promise((resolve) => {
    const normalized = (items || []).map((item) =>
      typeof item === 'string' ? { label: item, value: item } : { ...item }
    );
    const id = ++toastCounter;
    const pending: PendingToast = {
      resolve: (selected: any) => {
        if (options?.canPickMany === true) {
          // VS Code 契约：canPickMany=true 时返回数组（取消时 undefined）。
          // renderer 的 quick-pick 只支持单选，返回的单条结果也要包装成数组。
          resolve(selected === undefined ? undefined : Array.isArray(selected) ? selected : [selected]);
        } else {
          resolve(selected);
        }
      },
      clearTtl: () => undefined
    };
    evictOldestToastIfFull();
    pendingToasts.set(id, pending);
    setToastTtl(id, pending);
    const h = host();
    if (h) {
      h.postCommand('host.quickPick', { id, items: normalized, options: options || {} });
    } else {
      pendingToasts.delete(id);
      pending.clearTtl();
      resolve(undefined);
    }
  });
}

function showInputBox(_options?: any): Promise<string | undefined> {
  return new Promise((resolve) => {
    const id = ++toastCounter;
    const pending: PendingToast = { resolve, clearTtl: () => undefined };
    evictOldestToastIfFull();
    pendingToasts.set(id, pending);
    setToastTtl(id, pending);
    const h = host();
    if (h) {
      h.postCommand('host.inputBox', { id, options: _options || {} });
    } else {
      pendingToasts.delete(id);
      pending.clearTtl();
      resolve(undefined);
    }
  });
}

async function showOpenDialog(options: any): Promise<Uri[] | undefined> {
  const h = host();
  if (!h) return undefined;
  // native 层返回 Electron 形状 { filePaths, canceled }，此处转换为 VS Code 契约
  // （Uri[] | undefined）：全部调用方（工作区打开/存储路径选择/设置导入等）都按
  // result.length / result[i].fsPath 消费，直接透传 Electron 形状会导致对话框
  // 永远被视为“取消”、选中路径丢失。
  const result = await h.native<{ filePaths: string[]; canceled: boolean }>('dialog:open', options);
  if (!result || result.canceled || !Array.isArray(result.filePaths)) {
    return undefined;
  }
  return result.filePaths.map((p) => Uri.file(p));
}

async function showSaveDialog(options: any): Promise<Uri | undefined> {
  const h = host();
  if (!h) return undefined;
  // 同理转换为 VS Code 契约（Uri | undefined）：导出设置等调用方直接读 result.fsPath，
  // 原实现透传 { filePath, canceled } 会让 result.fsPath 为 undefined。
  const result = await h.native<{ filePath: string; canceled: boolean }>('dialog:save', options);
  if (!result || result.canceled || !result.filePath) {
    return undefined;
  }
  return Uri.file(result.filePath);
}

class OutputChannelImpl {
  constructor(private name: string) {}
  append(value: string): void {
    console.log(`[${this.name}] ${value}`);
  }
  appendLine(value: string): void {
    console.log(`[${this.name}] ${value}`);
  }
  show(_preserveFocus?: boolean): void {
    // no-op
  }
  hide(): void {
    // no-op
  }
  clear(): void {
    // no-op
  }
  dispose(): void {
    // no-op
  }
}

export const window = {
  get activeTextEditor(): undefined {
    return undefined;
  },
  get state(): { focused: boolean } {
    return { focused: windowFocused };
  },
  get visibleTextEditors(): never[] {
    return [];
  },
  get tabGroups(): { all: never[]; close(): Promise<boolean> } {
    return { all: [], close: async () => true };
  },
  get terminals(): never[] {
    return [];
  },
  activeTerminal: undefined,
  showInformationMessage: (message: string, options?: any, ...items: any[]): Promise<any> =>
    showMessage('info', message, options, items),
  showWarningMessage: (message: string, options?: any, ...items: any[]): Promise<any> =>
    showMessage('warning', message, options, items),
  showErrorMessage: (message: string, options?: any, ...items: any[]): Promise<any> =>
    showMessage('error', message, options, items),
  showQuickPick: (items: any[], options?: any): Promise<any> => showQuickPick(items, options),
  showInputBox: (options?: any): Promise<string | undefined> => showInputBox(options),
  showOpenDialog: (options: any): Promise<any> => showOpenDialog(options),
  showSaveDialog: (options: any): Promise<any> => showSaveDialog(options),
  createOutputChannel(name: string): any {
    return new OutputChannelImpl(name);
  },
  createStatusBarItem(): any {
    return { show() {}, hide() {}, dispose() {} };
  },
  setStatusBarMessage(): Disposable {
    return new Disposable();
  },
  createTextEditorDecorationType(_options: any): any {
    return { dispose() {} };
  },
  createWebviewPanel(viewType: string, title: string, _viewColumn: any, _options?: any): any {
    console.warn(`[vscode-shim] window.createWebviewPanel is not supported on desktop: ${viewType}`);
    return {
      viewType,
      title,
      visible: true,
      active: true,
      webview: {
        html: '',
        cspSource: '',
        asWebviewUri: (uri: Uri) => uri,
        onDidReceiveMessage: () => new Disposable(),
        postMessage: async () => true
      },
      onDidChangeViewState: () => new Disposable(),
      onDidDispose: () => new Disposable(),
      reveal() {},
      dispose() {}
    };
  },
  withProgress<T>(_options: any, task: (progress: any, token: any) => Promise<T>): Promise<T> {
    return task({ report() {} }, new CancellationToken());
  },
  async showTextDocument(document: TextDocumentLike, _options?: any): Promise<any> {
    const h = host();
    if (document.uri.scheme === 'file' && h) {
      try {
        h.onOpenTextDocument?.(document.uri);
      } catch (err) {
        console.error('[vscode-shim] onOpenTextDocument failed:', err);
      }
    }
    return {
      document,
      revealRange() {},
      setDecorations() {},
      options: { tabSize: 4, insertSpaces: true }
    };
  },
  onDidChangeActiveTextEditor: windowOnDidChangeActiveTextEditor.event,
  onDidChangeVisibleTextEditors: windowOnDidChangeVisibleTextEditors.event,
  onDidChangeTextEditorSelection: windowOnDidChangeTextEditorSelection.event,
  onDidChangeTextEditorVisibleRanges: windowOnDidChangeTextEditorVisibleRanges.event,
  onDidChangeWindowState: windowOnDidChangeWindowState.event,
  onDidOpenTerminal: windowOnDidOpenTerminal.event,
  onDidCloseTerminal: windowOnDidCloseTerminal.event,
  onDidWriteTerminalData: windowOnDidWriteTerminalData.event,
  onDidChangeActiveTerminal: windowOnDidChangeActiveTerminal.event,
  registerTreeDataProvider(): Disposable {
    return new Disposable();
  }
};

// ============================================================================
// commands
// ============================================================================

const registeredCommands = new Map<string, (...args: any[]) => any>();
let pendingDiffCounter = 0;

export function __resolveNotificationCommand(id: string, args: any[] = []): any {
  const fn = registeredCommands.get(id);
  if (fn) return fn(...args);
  console.warn(`[vscode-shim] unregistered command: ${id}`);
  return undefined;
}

export const commands = {
  registerCommand(id: string, handler: (...args: any[]) => any): Disposable {
    registeredCommands.set(id, handler);
    return new Disposable(() => registeredCommands.delete(id));
  },
  async executeCommand<T = any>(id: string, ...args: any[]): Promise<T> {
    switch (id) {
      case 'vscode.diff': {
        const [originalUri, newUri, title, options] = args;
        const h = host();
        if (h?.onOpenDiffPreview) {
          const provider = textDocumentProviderSchemes.get(originalUri?.scheme);
          let originalContent: string;
          let newContent: string;
          let previewId = '';
          let filePath: string;

          if (originalUri?.scheme === 'graycode-diff-preview') {
            // 前端 openDiffView 路径：两个 URI 都是虚拟文档（graycode-diff-preview:original|modified/<path>?id=...），
            // 内容由 BackendHost 注册的 diffPreviewProvider 提供；previewId 在 query 中。
            originalContent = provider?.provideTextDocumentContent(originalUri) ?? '';
            newContent = provider?.provideTextDocumentContent(newUri) ?? '';
            if (originalUri?.query) {
              const m = /(?:^|&)id=([^&]*)/.exec(originalUri.query);
              if (m) previewId = decodeURIComponent(m[1]);
            }
            // Uri.parse 已对 path 解码（DiffHandlers 构造时 encodeURIComponent 一次），
            // 这里不再二次 decodeURIComponent：文件路径含字面 %（如 report%final.md）时
            // 二次解码会抛 URIError 导致 diff 预览打开失败
            filePath = (originalUri?.path || '').replace(/^\/?original\//, '');
          } else {
            // 后端 auto-open 路径（gemini-diff-original:<diffId>/<basename>）：
            // originalUri 是虚拟文档，newUri 是真实 file: URI——diffManager 已通过 WorkspaceEdit
            // 把 newContent 写入磁盘。previewId 是 diff session id（path 第一段）。
            originalContent = provider?.provideTextDocumentContent(originalUri) ?? '';
            // previewId / filePath 必须在 resolveOriginalContent 之前计算：
            // 旧实现把它们放在 else 分支末尾，auto-open 路径下 resolveOriginalContent
            // 拿到的 previewId 恒为 ''，只能靠宿主的 filePath 兜底匹配。
            if (originalUri?.path) {
              const slashIdx = originalUri.path.indexOf('/');
              if (slashIdx > 0) {
                previewId = originalUri.path.slice(0, slashIdx);
              } else if (originalUri.path) {
                previewId = originalUri.path;
              }
            }
            if (!previewId && newUri?.query) {
              const m = /(?:^|&)id=([^&]*)/.exec(newUri.query);
              if (m) previewId = decodeURIComponent(m[1]);
            }
            filePath = newUri?.scheme === 'file' ? newUri.fsPath : (originalUri?.path || '').replace(/^\/?original\//, '');
            if (!originalContent && h?.resolveOriginalContent) {
              // 桌面版没有为 gemini-diff-original 注册内容提供者，原始内容需要
              // 从宿主侧 diffManager 的 pending diff 获取，否则 diff 预览左栏恒为空。
              originalContent = (await h.resolveOriginalContent(previewId, filePath)) ?? '';
            }
            if (newUri?.scheme === 'file') {
              const cached = documentCache.get(newUri.toString());
              if (cached) {
                newContent = cached.getText();
              } else {
                try {
                  newContent = await fsp.readFile(newUri.fsPath, 'utf-8');
                } catch {
                  newContent = '';
                }
              }
            } else {
              newContent = provider?.provideTextDocumentContent(newUri) ?? '';
            }
          }

          const sessionId = await h.resolveDiffSessionId?.(previewId, filePath);
          h.onOpenDiffPreview({
            id: ++pendingDiffCounter,
            previewId,
            sessionId,
            title,
            filePath,
            originalContent,
            newContent,
            // 语义与 VS Code 一致：仅当显式传 preview:true 才标记预览模式；
            // 旧实现 options?.preview !== true 会把「显式传 false」和「不传」都算成预览，语义相反。
            preview: options?.preview === true
          });
        }
        return undefined as T;
      }
      case 'vscode.open': {
        const h = host();
        const uri: Uri = args[0];
        if (h && uri) {
          try {
            await h.native('shell:openPath', { path: uri.fsPath || uri.path });
          } catch (err) {
            console.error('[vscode-shim] vscode.open failed:', err);
          }
        }
        return undefined as T;
      }
      case 'vscode.openFolder': {
        // 多工作区收藏：把指定文件夹作为当前工作区打开（替换现有工作区）。
        // 持久化与标题更新由主进程 workspace:openFolder 原生操作完成。
        const h = host();
        const arg: any = args[0];
        const fsPath =
          arg && typeof arg === 'object' && typeof arg.fsPath === 'string'
            ? arg.fsPath
            : typeof arg === 'string'
              ? arg
              : '';
        if (h && fsPath) {
          try {
            await h.native('workspace:openFolder', { fsPath });
          } catch (err) {
            console.error('[vscode-shim] vscode.openFolder failed:', err);
          }
        }
        return undefined as T;
      }
      case 'revealFileInOS': {
        const h = host();
        const uri: Uri = args[0];
        if (h && uri) {
          try {
            await h.native('shell:showInFolder', { path: uri.fsPath || uri.path });
          } catch (err) {
            console.error('[vscode-shim] revealFileInOS failed:', err);
          }
        }
        return undefined as T;
      }
      case 'workbench.action.reloadWindow': {
        const h = host();
        h?.native('window:reload');
        return undefined as T;
      }
      case 'vscode.executeDocumentSymbolProvider': {
        const { getDocumentSymbols } = await import('./builtinLsp');
        const uri: Uri = args[0];
        return getDocumentSymbols(uri) as unknown as T;
      }
      case 'vscode.executeDefinitionProvider': {
        const { getDefinitions } = await import('./builtinLsp');
        return getDefinitions(args[0], args[1]) as unknown as T;
      }
      case 'vscode.executeReferenceProvider': {
        const { getReferences } = await import('./builtinLsp');
        return getReferences(args[0], args[1]) as unknown as T;
      }
      default: {
        const fn = registeredCommands.get(id);
        if (fn) return fn(...args);
        console.warn(`[vscode-shim] unknown command: ${id}`);
        return undefined as T;
      }
    }
  },
  getCommands(): string[] {
    return [...registeredCommands.keys()];
  }
};

// ============================================================================
// languages / env / misc
// ============================================================================

export const languages = {
  getDiagnostics(): Array<[Uri, any[]]> {
    return [];
  },
  createDiagnosticCollection(): any {
    return {
      set() {},
      delete() {},
      clear() {},
      dispose() {}
    };
  },
  registerCodeLensProvider(_selector: any, _provider: any): Disposable {
    return new Disposable();
  },
  registerHoverProvider(_selector: any, _provider: any): Disposable {
    return new Disposable();
  },
  registerCodeActionsProvider(_selector: any, _provider: any, _metadata?: any): Disposable {
    return new Disposable();
  }
};

export const env = {
  language: 'zh-CN',
  appName: 'GrayCode Desktop',
  appRoot: process.cwd(),
  machineId: 'graycode-desktop',
  sessionId: 'graycode-desktop-session',
  uiKind: 2,
  shell: process.env.SHELL || (WIN32 ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'),
  isNewAppInstall: false,
  clipboard: {
    writeText(text: string): void {
      const h = host();
      h?.native('clipboard:write', { text }).catch(err => console.warn('[vscode-shim] clipboard.writeText failed:', err));
    },
    async readText(): Promise<string> {
      const h = host();
      if (!h) return '';
      try {
        return await h.native('clipboard:read');
      } catch {
        return '';
      }
    }
  },
  async openExternal(target: string | Uri): Promise<boolean> {
    const h = host();
    if (!h) return false;
    try {
      if (typeof target !== 'string') {
        // file: URI（如「打开 Skills 目录」）不能走 shell:openExternal 的
        // http/https/mailto 白名单，改走 shell:openPath（含目录/可执行扩展名校验），
        // 与 VS Code 中 openExternal(file URI) 打开系统资源管理器的语义一致。
        if (target.scheme === 'file' && target.fsPath) {
          await h.native('shell:openPath', { path: target.fsPath });
          return true;
        }
      }
      await h.native('shell:openExternal', { url: typeof target === 'string' ? target : target.toString() });
      return true;
    } catch {
      return false;
    }
  }
};

export const extensions = {
  getExtension(id: string) {
    // 独立版没有真正的扩展宿主，但公告/版本检查需要 extensionPath 与版本号，
    // 提供最小 stub 让 SettingsHandler 的公告逻辑在桌面版也能工作。
    if (id === 'czocelot.graycode') {
      return {
        id,
        extensionPath: resolveRepoRoot(),
        packageJSON: readRootPackageMetadata()
      };
    }
    return undefined;
  },
  all: []
};

function resolveRepoRoot(): string {
  return process.env.GRAYCODE_REPO_ROOT || path.resolve(__dirname, '..', '..');
}

// 打包后 package.json 永不变化：memoize 免每次 getExtension() 同步读盘（公告/版本检查多路径调用）
let cachedPackageMetadata: { version: string; name: string; displayName: string } | null = null;

function readRootPackageMetadata(): { version: string; name: string; displayName: string } {
  if (cachedPackageMetadata) {
    return cachedPackageMetadata;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(resolveRepoRoot(), 'package.json'), 'utf-8'));
    cachedPackageMetadata = {
      version: typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0',
      name: typeof pkg.name === 'string' && pkg.name ? pkg.name : 'graycode',
      displayName: typeof pkg.displayName === 'string' && pkg.displayName ? pkg.displayName : 'Gray Code'
    };
    return cachedPackageMetadata;
  } catch {
    return { version: '0.0.0', name: 'graycode', displayName: 'Gray Code' };
  }
}

// ============================================================================
// workspaceState / globalState（JSON 文件持久化 Memento）
// ============================================================================

class JsonFileMemento {
  private data: Record<string, any> = {};
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    } catch {
      this.data = {};
    }
  }
  keys(): string[] {
    return Object.keys(this.data);
  }
  get(key: string, defaultValue?: any): any {
    return key in this.data ? this.data[key] : defaultValue;
  }
  update(key: string, value: any): Thenable<void> {
    this.data[key] = value;
    // 与 JsonConfigStore.save 同一套原子写策略：串行写队列 + 临时文件 + rename，
    // 避免并发 update 交错覆盖内容，也避免写一半崩溃留下损坏的 JSON（同文件 560-570）。
    const content = JSON.stringify(this.data, null, 2);
    this.writeQueue = this.writeQueue
      .then(async () => {
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        await fsp.writeFile(tmp, content, 'utf-8');
        await fsp.rename(tmp, this.file);
      })
      .catch((err) => console.warn('[vscode-shim] memento persist failed:', err));
    return this.writeQueue;
  }
}

let workspaceStateMemento: JsonFileMemento | null = null;
let globalStateMemento: JsonFileMemento | null = null;

export function __initMementoPaths(userDataPath: string): void {
  if (!workspaceStateMemento) {
    workspaceStateMemento = new JsonFileMemento(path.join(userDataPath, 'workspace-state.json'));
  }
  if (!globalStateMemento) {
    globalStateMemento = new JsonFileMemento(path.join(userDataPath, 'global-state.json'));
  }
  workspaceState = workspaceStateMemento;
  globalState = globalStateMemento;
}

// 版本号从根 package.json 读取（与 ElectronContext.readRootPackageVersion 同一来源），
// 不再硬编码：扩展升级时公告/版本检查逻辑用的 vscode.version 才能与真实版本一致。
export const version: string = readRootPackageMetadata().version;
export const extensionMode = ExtensionMode.Production;
// 使用 let + 延迟赋值：__initMementoPaths 在 BackendHost 构造时调用，
// 而 ES module namespace 是 live binding，此后 vscode.workspaceState 访问到的是真实 Memento。
export let workspaceState: any = null;
export let globalState: any = null;

export const Disposable_ = Disposable;
export const EventEmitter_ = EventEmitter;

// ============================================================================
// default export used by `import * as vscode from 'vscode'`
// ============================================================================

export default {
  Uri,
  workspace,
  window,
  commands,
  languages,
  env,
  extensions,
  workspaceState,
  globalState,
  version,
  extensionMode,
  ConfigurationTarget,
  FileType,
  TextEditorRevealType,
  ViewColumn,
  OverviewRulerLane,
  ProgressLocation,
  DiagnosticSeverity,
  SymbolKind,
  ExtensionMode,
  CodeActionKind,
  TextDocumentSaveReason,
  Position,
  Range,
  Selection,
  ThemeColor,
  MarkdownString,
  TabInputText,
  TabInputTextDiff,
  Location,
  LocationLink,
  DocumentSymbol,
  CodeLens,
  WorkspaceEdit,
  CancellationToken,
  RelativePattern,
  Disposable,
  EventEmitter
};
