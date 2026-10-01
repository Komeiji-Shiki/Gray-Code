/** Pure outline conversion shared by the LSP (1-based kinds) and VS Code (0-based kinds) hosts. */
export const SYMBOL_KIND_NAMES = [
    'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field',
    'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string',
    'number', 'boolean', 'array', 'object', 'key', 'null', 'enum_member', 'struct',
    'event', 'operator', 'type_parameter', 'unknown'
] as const;

export const MAX_SYMBOLS_PER_FILE = 500;
export const MAX_SYMBOL_PATHS = 20;

interface Position { line: number; character: number }
interface Range { start: Position; end: Position }
type ProviderSymbol = {
    name: string;
    kind: number;
} & ({ range: Range; detail?: string; children?: ProviderSymbol[] } | {
    location: { range: Range; uri?: string | { toString(): string } };
    containerName?: string;
});

export interface SymbolOutlineOptions {
    maxDepth: number;
    kinds?: string[];
}

export interface SymbolInfo {
    name: string;
    kind: string;
    line: number;
    column: number;
    endLine: number;
    /** Original provider depth, even when a kinds filter omits an ancestor. */
    depth: number;
    detail?: string;
    childCount?: number;
    childrenCollapsed?: boolean;
    children?: SymbolInfo[];
}

export interface SymbolOutline {
    symbols: SymbolInfo[];
    /** Returned count, kept compatible with the original get_symbols result. */
    symbolCount: number;
    availableSymbolCount: number;
    /** False for flat SymbolInformation, whose ranges do not establish a syntax hierarchy. */
    hierarchyAvailable: boolean;
    /** 深度折叠优先计数；类型筛选与局部变量省略都计入 filteredSymbolCount。 */
    collapsedSymbolCount: number;
    filteredSymbolCount: number;
    truncated: boolean;
}

export function parseSymbolOutlineOptions(args: { maxDepth?: unknown; kinds?: unknown }): SymbolOutlineOptions {
    const maxDepth = args.maxDepth === undefined ? 1 : args.maxDepth;
    if (typeof maxDepth !== 'number' || !Number.isSafeInteger(maxDepth) || maxDepth < 1) {
        throw new Error('maxDepth must be a positive integer (1 = top-level symbols only).');
    }
    if (args.kinds !== undefined && (!Array.isArray(args.kinds)
        || args.kinds.some(kind => typeof kind !== 'string' || !SYMBOL_KIND_NAMES.includes(kind as typeof SYMBOL_KIND_NAMES[number])))) {
        throw new Error(`kinds must be an array of symbol kinds: ${SYMBOL_KIND_NAMES.join(', ')}.`);
    }
    return { maxDepth, ...(args.kinds !== undefined ? { kinds: [...new Set(args.kinds as string[])] } : {}) };
}

const comparePosition = (left: Position, right: Position) => left.line - right.line || left.character - right.character;
const symbolRange = (symbol: ProviderSymbol) => 'range' in symbol ? symbol.range : symbol.location.range;
const compareSymbol = (left: ProviderSymbol, right: ProviderSymbol) => comparePosition(symbolRange(left).start, symbolRange(right).start)
    || comparePosition(symbolRange(right).end, symbolRange(left).end);

export function createSymbolOutline(
    symbols: readonly ProviderSymbol[], options: SymbolOutlineOptions, kindBase: 0 | 1
): SymbolOutline {
    const result: SymbolOutline = {
        symbols: [], symbolCount: 0, availableSymbolCount: 0, hierarchyAvailable: true,
        collapsedSymbolCount: 0, filteredSymbolCount: 0, truncated: false
    };
    const kinds = options.kinds?.length ? new Set(options.kinds) : undefined;
    const returned: SymbolInfo[] = [];
    const pending: Array<{ symbols: readonly ProviderSymbol[]; index: number; depth: number; output: SymbolInfo[]; callableScope: boolean; hidden: boolean }> = [
        { symbols: [...symbols].sort(compareSymbol), index: 0, depth: 1, output: result.symbols, callableScope: false, hidden: false }
    ];
    // 直接遍历 provider 的树，不再复制所有隐藏节点；帧只保存当前层的位置，深层结构不会溢出调用栈。
    // 折叠或已超过输出预算的子树只需计数，排序仅用于仍有机会展示的层级。
    while (pending.length) {
        const frame = pending[pending.length - 1];
        if (frame.index >= frame.symbols.length) { pending.pop(); continue; }
        const symbol = frame.symbols[frame.index++];
        const { depth, output } = frame;
        const document = 'range' in symbol;
        const children = document ? symbol.children : undefined;
        if (!document) result.hierarchyAvailable = false;
        result.availableSymbolCount++;
        let childOutput = output;
        const kind = SYMBOL_KIND_NAMES[symbol.kind - kindBase] ?? 'unknown';
        // 只依据提供器的真实层级识别局部数据，平面列表和顶层变量保持原有语义。
        const hidden = frame.hidden || frame.callableScope && (kind === 'variable' || kind === 'constant');
        const callableScope = ['function', 'method', 'constructor'].includes(kind)
            || frame.callableScope && !['class', 'interface', 'struct', 'enum', 'module', 'namespace', 'package'].includes(kind);
        if (depth > options.maxDepth) result.collapsedSymbolCount++;
        else if (hidden || kinds && !kinds.has(kind)) result.filteredSymbolCount++;
        else if (result.symbolCount >= MAX_SYMBOLS_PER_FILE) result.truncated = true;
        else {
            const range = symbolRange(symbol);
            const childCount = children?.reduce((count, child) => count + Number(!callableScope
                || !['variable', 'constant'].includes(SYMBOL_KIND_NAMES[child.kind - kindBase] ?? 'unknown')), 0) ?? 0;
            const info: SymbolInfo = {
                name: symbol.name, kind, line: range.start.line + 1,
                column: range.start.character + 1, endLine: range.end.line + 1, depth,
                ...(document && symbol.detail ? { detail: symbol.detail } : {})
            };
            if (childCount) {
                info.childCount = childCount;
                if (depth >= options.maxDepth) info.childrenCollapsed = true;
                else info.children = childOutput = [];
            }
            output.push(info);
            returned.push(info);
            result.symbolCount++;
        }
        if (children?.length) {
            pending.push({ symbols: depth < options.maxDepth && result.symbolCount < MAX_SYMBOLS_PER_FILE
                ? [...children].sort(compareSymbol) : children, index: 0, depth: depth + 1, output: childOutput, callableScope, hidden });
        }
    }
    for (const info of returned) if (info.children?.length === 0) delete info.children;
    return result;
}
