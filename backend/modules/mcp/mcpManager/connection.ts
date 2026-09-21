import type { McpServerInfo, McpServerStatus, McpEvent } from '../types';
import { McpClient } from '../McpClient';

export interface McpConnectionDeps {
    readonly clients: Map<string, McpClient>;
    readonly refreshChains: Map<string, { promise: Promise<void>; generation: number }>;
    readonly refreshPending: Map<string, boolean>;
    isCurrentGeneration(serverId: string, generation: number): boolean;
    updateServerStatus(serverId: string, status: McpServerStatus): void;
    emitEvent(event: McpEvent): void;
    handleServerNotification(info: McpServerInfo, client: McpClient, generation: number, method: string, params?: unknown): Promise<void>;
}

/** 所有传输共用代际与连接状态，旧连接的异步结果不能覆盖新连接。 */
export async function runConnect(deps: McpConnectionDeps, serverId: string, info: McpServerInfo, generation: number): Promise<void> {
    let client: McpClient | undefined;
    try {
        await deps.clients.get(serverId)?.disconnect();
        if (!deps.isCurrentGeneration(serverId, generation)) return;
        client = new McpClient(info.config.transport, info.config.timeout);
        const activeClient = client;
        const current = () => deps.isCurrentGeneration(serverId, generation) && deps.clients.get(serverId) === activeClient;
        client.on('error', (error: Error) => {
            if (!current() || info.status === 'connecting') return;
            info.lastError = error.message;
            deps.updateServerStatus(serverId, 'error');
            deps.emitEvent({ type: 'server:error', serverId, data: { error: error.message }, timestamp: Date.now() });
            deps.clients.delete(serverId);
            void activeClient.disconnect().catch(error => console.error('[MCP] 关闭失败的连接：', error));
        });
        client.on('exit', () => {
            if (!current() || info.status === 'connecting') return;
            deps.clients.delete(serverId);
            deps.updateServerStatus(serverId, 'disconnected');
            deps.emitEvent({ type: 'server:disconnected', serverId, timestamp: Date.now() });
        });
        deps.clients.set(serverId, client);
        await client.connect();
        if (!current()) { await client.disconnect(); return; }
        info.capabilities = { tools: client.getTools(), resources: client.getResources(), prompts: client.getPrompts() };
        info.protocolVersion = client.getProtocolVersion();
        info.serverVersion = client.getServerInfo()?.version;
        info.serverDescription = client.getServerInfo()?.name;
        info.lastError = undefined;
        info.connectedAt = Date.now();
        client.on('notification', (method: string, params?: unknown) => {
            if (current()) void deps.handleServerNotification(info, activeClient, generation, method, params);
        });
        deps.updateServerStatus(serverId, 'connected');
        deps.emitEvent({ type: 'server:connected', serverId, timestamp: Date.now() });
    } catch (error) {
        if (client) {
            if (deps.clients.get(serverId) === client) deps.clients.delete(serverId);
            await client.disconnect().catch(closeError => console.error('[MCP] 关闭失败的连接：', closeError));
        }
        if (deps.isCurrentGeneration(serverId, generation)) {
            info.lastError = error instanceof Error ? error.message : String(error);
            deps.updateServerStatus(serverId, 'error');
            deps.emitEvent({ type: 'server:error', serverId, data: { error: info.lastError }, timestamp: Date.now() });
        }
        throw error;
    }
}

export async function performDisconnect(deps: McpConnectionDeps, info: McpServerInfo): Promise<void> {
    const client = deps.clients.get(info.config.id);
    if (client) {
        await client.disconnect();
        if (deps.clients.get(info.config.id) === client) deps.clients.delete(info.config.id);
    }
    deps.refreshChains.delete(info.config.id);
    deps.refreshPending.delete(info.config.id);
}
