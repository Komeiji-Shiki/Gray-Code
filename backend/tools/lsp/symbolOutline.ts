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
    /** Depth is applied before kinds, so these omission counts do not overlap. */
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

interface OutlineNode {
    name: string;
    kind: string;
    range: Range;
    detail?: string;
    children: OutlineNode[];
}

const comparePosition = (left: Position, right: Position) => left.line - right.line || left.character - right.character;
const compareNode = (left: OutlineNode, right: OutlineNode) => comparePosition(left.range.start, right.range.start)
    || comparePosition(right.range.end, left.range.end);
function normalizeSymbols(symbols: readonly ProviderSymbol[], kindBase: 0 | 1) {
    const roots: OutlineNode[] = [];
    let hierarchyAvailable = true;
    const pending = [{ symbols, output: roots }];
    while (pending.length) {
        const { symbols: siblings, output } = pending.pop()!;
        for (const symbol of siblings) {
            const document = 'range' in symbol;
            const node: OutlineNode = {
                name: symbol.name,
                kind: SYMBOL_KIND_NAMES[symbol.kind - kindBase] ?? 'unknown',
                range: document ? symbol.range : symbol.location.range,
                ...(document && symbol.detail ? { detail: symbol.detail } : {}),
                children: []
            };
            output.push(node);
            if (document) {
                if (symbol.children?.length) pending.push({ symbols: symbol.children, output: node.children });
            } else {
                // Neither location.range nor containerName in SymbolInformation guarantees
                // AST containment. Keep the flat list instead of hiding symbols by guessing.
                hierarchyAvailable = false;
            }
        }
        output.sort(compareNode);
    }
    return { roots, hierarchyAvailable };
}

export function createSymbolOutline(
    symbols: readonly ProviderSymbol[], options: SymbolOutlineOptions, kindBase: 0 | 1
): SymbolOutline {
    const { roots, hierarchyAvailable } = normalizeSymbols(symbols, kindBase);
    const result: SymbolOutline = {
        symbols: [], symbolCount: 0, availableSymbolCount: 0, hierarchyAvailable,
        collapsedSymbolCount: 0, filteredSymbolCount: 0, truncated: false
    };
    const kinds = options.kinds?.length ? new Set(options.kinds) : undefined;
    const returned: SymbolInfo[] = [];
    const pending = roots.slice().reverse().map(node => ({ node, depth: 1, output: result.symbols }));
    // Iterative traversal also handles deeply nested providers without making maxDepth a way
    // to bypass the shared output budget or overflow the JS call stack.
    while (pending.length) {
        const { node, depth, output } = pending.pop()!;
        result.availableSymbolCount++;
        let childOutput = output;
        if (depth > options.maxDepth) result.collapsedSymbolCount++;
        else if (kinds && !kinds.has(node.kind)) result.filteredSymbolCount++;
        else if (result.symbolCount >= MAX_SYMBOLS_PER_FILE) result.truncated = true;
        else {
            const info: SymbolInfo = {
                name: node.name, kind: node.kind, line: node.range.start.line + 1,
                column: node.range.start.character + 1, endLine: node.range.end.line + 1, depth,
                ...(node.detail ? { detail: node.detail } : {})
            };
            if (node.children.length) {
                info.childCount = node.children.length;
                if (depth >= options.maxDepth) info.childrenCollapsed = true;
                else info.children = childOutput = [];
            }
            output.push(info);
            returned.push(info);
            result.symbolCount++;
        }
        for (let index = node.children.length - 1; index >= 0; index--) {
            pending.push({ node: node.children[index], depth: depth + 1, output: childOutput });
        }
    }
    for (const info of returned) if (info.children?.length === 0) delete info.children;
    return result;
}
