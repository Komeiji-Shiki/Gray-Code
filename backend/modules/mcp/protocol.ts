/** 当前客户端实现握手式 MCP；无状态协议需要另一套连接与取消流程。 */
export const MCP_HANDSHAKE_PROTOCOL_VERSION = '2025-11-25';

export function requireHandshakeProtocolVersion(version: unknown): string {
    if (typeof version !== 'string' || ![MCP_HANDSHAKE_PROTOCOL_VERSION, '2025-06-18', '2025-03-26', '2024-11-05'].includes(version)) {
        throw new Error(`当前 MCP 客户端尚不支持协议版本 ${String(version)}。`);
    }
    return version;
}

/** Shared JSON-RPC boundaries for both MCP transports. */
export interface JsonRpcReply {
    jsonrpc: '2.0';
    id: string | number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcReply {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (record.jsonrpc !== '2.0' || (typeof record.id !== 'string' && typeof record.id !== 'number')) return false;
    if ('method' in record) return false;
    return Object.prototype.hasOwnProperty.call(record, 'result') !== Object.prototype.hasOwnProperty.call(record, 'error');
}

export function createServerRequestReply(value: unknown): JsonRpcReply | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.jsonrpc !== '2.0' || typeof record.method !== 'string'
        || (typeof record.id !== 'string' && typeof record.id !== 'number')) return undefined;
    return record.method === 'ping'
        ? { jsonrpc: '2.0', id: record.id, result: {} }
        : { jsonrpc: '2.0', id: record.id, error: { code: -32601, message: `Method not found: ${record.method}` } };
}

/** Publish a new list only after all pages have arrived successfully. */
export async function collectMcpList<T>(
    request: (params: { cursor?: string }) => Promise<Record<string, unknown>>,
    key: 'tools' | 'resources' | 'prompts'
): Promise<T[]> {
    const items: T[] = [];
    const visitedCursors = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await request(cursor === undefined ? {} : { cursor });
        const entries = page[key];
        if (entries !== undefined && !Array.isArray(entries)) {
            throw new Error(`Invalid MCP ${key} list`);
        }
        if (Array.isArray(entries)) {
            for (const entry of entries) items.push(entry as T);
        }
        const nextCursor = page.nextCursor;
        if (nextCursor === undefined) break;
        if (typeof nextCursor !== 'string' || visitedCursors.has(nextCursor)) {
            throw new Error(`Invalid or repeated MCP ${key} pagination cursor`);
        }
        visitedCursors.add(nextCursor);
        cursor = nextCursor;
    } while (true);
    return items;
}
