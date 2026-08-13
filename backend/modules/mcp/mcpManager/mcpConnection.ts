/**
 * GrayCode MCP 连接生命周期执行层
 *
 * 从 McpManager 抽离：连接建立 / 断开 / 代际校验 / 能力拉取 / 运行期错误处理。
 * 通过 McpConnectionDeps 接收 McpManager 的状态与回调，自身不持有管理器实例。
 */

import type {
    McpServerInfo,
    McpServerStatus,
    McpEvent
} from '../types';
import { StdioMcpClient } from '../StdioClient';
import { HttpMcpClient } from '../HttpClient';

/**
 * 连接执行层依赖（由 McpManager 提供）
 *
 * - clients / refreshChains / refreshPending：与 McpManager 共享引用
 * - isCurrentGeneration / updateServerStatus / emitEvent：McpManager 私有方法的绑定
 * - handleServerNotification：列表变更通知处理入口（mcpListRefresh）
 */
export interface McpConnectionDeps {
    readonly clients: Map<string, StdioMcpClient | HttpMcpClient>;
    readonly refreshChains: Map<string, { promise: Promise<void>; generation: number }>;
    readonly refreshPending: Map<string, boolean>;
    isCurrentGeneration(serverId: string, generation: number): boolean;
    updateServerStatus(serverId: string, status: McpServerStatus): void;
    emitEvent(event: McpEvent): void;
    handleServerNotification(
        info: McpServerInfo,
        client: StdioMcpClient | HttpMcpClient,
        generation: number,
        method: string,
        params?: unknown
    ): Promise<void>;
}

/**
 * 执行连接并更新状态（带代际校验）
 *
 * 旧代际的连接完成/失败路径不会覆盖新连接的状态；
 * 但错误仍会传播给发起该次连接的调用方。
 */
export async function runConnect(
    deps: McpConnectionDeps,
    serverId: string,
    info: McpServerInfo,
    generation: number
): Promise<void> {
    try {
        await performConnect(deps, info, generation);

        // 旧代际的连接完成路径不得覆盖新连接的状态
        if (!deps.isCurrentGeneration(serverId, generation)) {
            return;
        }

        // 连接成功清除过期错误，避免 UI 一直展示上次失败的 lastError
        info.lastError = undefined;

        // MCP H-2：connect() 内部的能力列表（tools/resources/prompts）拉取失败会被 StdioClient
        // 吞掉（列表保持空），此时进程/协议可能不稳定——不能无脑置 connected（假连接）。
        // 区分「服务器真无工具」与「拉取失败」：拉取失败则置 error 并广播，等待用户重连/处理。
        const client = deps.clients.get(serverId);
        const listFailed = client ? client.isListFetchFailed() : false;
        if (listFailed) {
            const errorMessage = 'MCP server connected, but capability list fetch failed (tools/resources/prompts).';
            info.lastError = errorMessage;
            deps.updateServerStatus(serverId, 'error');
            deps.emitEvent({
                type: 'server:error',
                serverId,
                data: { error: errorMessage },
                timestamp: Date.now()
            });
            return;
        }

        deps.updateServerStatus(serverId, 'connected');
        info.connectedAt = Date.now();

        deps.emitEvent({
            type: 'server:connected',
            serverId,
            timestamp: Date.now()
        });
    } catch (error) {
        // 旧代际连接失败：不覆盖新连接的状态（错误仍传播给调用方）
        if (!deps.isCurrentGeneration(serverId, generation)) {
            throw error;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        info.lastError = errorMessage;
        deps.updateServerStatus(serverId, 'error');

        deps.emitEvent({
            type: 'server:error',
            serverId,
            data: { error: errorMessage },
            timestamp: Date.now()
        });

        throw error;
    }
}

/**
 * 执行连接
 *
 * @param generation 本次连接尝试的代际号；error/exit/catch/完成路径据此判断自己是否仍是"当前连接"
 */
async function performConnect(
    deps: McpConnectionDeps,
    info: McpServerInfo,
    generation: number
): Promise<void> {
    const { transport } = info.config;
    
    switch (transport.type) {
        case 'stdio': {
            // error 状态下旧 stdio 子进程可能仍存活：直接覆盖 clients 条目会把旧 client
            // 孤儿化（子进程存活到自然退出）。先断开旧 client（tree-kill）再建新连接；
            // 旧 client 的 exit 回调带代际 + 引用双重校验，不会误删随后注册的新 client。
            const previousClient = deps.clients.get(info.config.id);
            if (previousClient) {
                try {
                    await previousClient.disconnect();
                } catch {
                    // 旧进程可能已死；忽略，继续建新连接
                }
            }

            const client = new StdioMcpClient(
                transport.command,
                transport.args || [],
                transport.env,
                undefined, // cwd
                info.config.timeout
            );

            // 设置错误处理（带代际校验：旧 client 的回调不得影响新连接）
            client.on('error', (err) => {
                if (!deps.isCurrentGeneration(info.config.id, generation)) {
                    return;
                }
                // 连接中（connect 尚未返回）的错误统一由 runConnect catch 置状态并广播，
                // 此处只记 lastError，避免 server:error 双重广播；连接完成后的运行期
                // 错误才在此广播（与 runConnect catch 同口径）。
                const wasConnecting = info.status === 'connecting';
                info.lastError = err.message;
                deps.updateServerStatus(info.config.id, 'error');
                if (wasConnecting) {
                    return;
                }
                // 与 runConnect 失败路径对齐：广播 server:error，供 UI/能力缓存等下游感知
                deps.emitEvent({
                    type: 'server:error',
                    serverId: info.config.id,
                    data: { error: err.message },
                    timestamp: Date.now()
                });
                // 运行期错误后 client 已不可用（僵尸态，状态门禁已拦截后续调用）：
                // 从管理 map 摘除并断开底层连接，避免 deleteServer/setServerEnabled
                // 在 error 状态跳过 disconnect 后留下孤儿 client（stdio 子进程 /
                // HTTP session 悬挂）。引用比较防止误删随后 connect 注册的新 client。
                if (deps.clients.get(info.config.id) === client) {
                    deps.clients.delete(info.config.id);
                }
                void client.disconnect().catch(() => { /* 进程可能已死，忽略 */ });
            });

            client.on('exit', () => {
                if (!deps.isCurrentGeneration(info.config.id, generation)) {
                    return;
                }
                // 只删除自己注册的 client，避免误删随后 connect 注册的新客户端
                if (deps.clients.get(info.config.id) === client) {
                    deps.clients.delete(info.config.id);
                }
                deps.updateServerStatus(info.config.id, 'disconnected');
                // 进程意外退出（非用户显式 disconnect）：必须广播 disconnected 事件，
                // 下游（工具声明缓存等）依赖该事件失效已死服务器的能力列表；
                // 显式 disconnect() 路径会递增代际，此处代际校验已拦截，不会双发。
                deps.emitEvent({
                    type: 'server:disconnected',
                    serverId: info.config.id,
                    timestamp: Date.now()
                });
            });

            // 提前注册到管理 map，确保连接过程中的 delete/disable/disconnect 能找到它
            deps.clients.set(info.config.id, client);

            try {
                await client.connect();
            } catch (_e) {
                // 只清理自己注册的 client
                if (deps.clients.get(info.config.id) === client) {
                    deps.clients.delete(info.config.id);
                }
                await client.disconnect();
                throw _e;
            }

            // 连接期间若已被 disconnect/新 connect 取代，不再写入能力并关闭旧进程
            if (!deps.isCurrentGeneration(info.config.id, generation)) {
                await client.disconnect();
                return;
            }

            // 获取能力
            info.capabilities = {
                tools: client.getTools().map(t => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema
                })),
                resources: client.getResources().map(r => ({
                    uri: r.uri,
                    name: r.name,
                    description: r.description,
                    mimeType: r.mimeType
                })),
                prompts: client.getPrompts().map(p => ({
                    name: p.name,
                    description: p.description,
                    arguments: p.arguments
                }))
            };
            info.protocolVersion = client.getProtocolVersion();

            const serverInfo = client.getServerInfo();
            if (serverInfo) {
                info.serverVersion = serverInfo.version;
                info.serverDescription = serverInfo.name;
            }

            // 订阅服务器推送通知（notifications/tools|resources|prompts/list_changed），
            // 收到后刷新缓存列表，避免工具列表缓存永不刷新
            client.on('notification', (method: string, params?: any) => {
                // 旧代际 client 的通知不得触发新连接的刷新
                if (!deps.isCurrentGeneration(info.config.id, generation)) {
                    return;
                }
                // fire-and-forget：handleServerNotification 内部按 serverId 串行化、
                // 自带异常兜底，不会产生未处理的 rejection（async 监听器 rejection 兜底）
                void deps.handleServerNotification(info, client, generation, method, params);
            });
            break;
        }

        case 'sse': {
            // 与 stdio 分支对齐：error 状态下旧 HttpMcpClient 可能仍持有进行中的
            // fetch/读流，直接覆盖 clients 条目会把旧 client 孤儿化（activeControllers/
            // activeReaders 永不释放，session 悬挂）。先断开旧 client 再建新连接。
            const previousSseClient = deps.clients.get(info.config.id);
            if (previousSseClient) {
                try {
                    await previousSseClient.disconnect();
                } catch {
                    // 忽略，继续建新连接
                }
            }

            const sseClient = new HttpMcpClient(
                transport.url,
                'sse',
                transport.headers || {},
                info.config.timeout ?? 30000
            );

            // 设置错误处理（带代际校验）：HTTP 服务器死亡/网络错误/SSE 流意外结束时
            // 广播错误并置 error 状态——否则服务器死后状态永久 connected
            //（与 stdio 分支的 error 处理同口径）
            sseClient.on('error', (err: Error) => {
                if (!deps.isCurrentGeneration(info.config.id, generation)) {
                    return;
                }
                // 连接中（connect 尚未返回）的错误统一由 runConnect catch 置状态并广播，
                // 此处只记 lastError，避免 server:error 双重广播；连接完成后的运行期
                // 错误才在此广播（与 runConnect catch 同口径）。
                const wasConnecting = info.status === 'connecting';
                info.lastError = err.message;
                deps.updateServerStatus(info.config.id, 'error');
                if (wasConnecting) {
                    return;
                }
                deps.emitEvent({
                    type: 'server:error',
                    serverId: info.config.id,
                    data: { error: err.message },
                    timestamp: Date.now()
                });
                // 运行期错误后 client 已不可用（僵尸态，状态门禁已拦截后续调用）：
                // 从管理 map 摘除并断开底层连接，避免 deleteServer/setServerEnabled
                // 在 error 状态跳过 disconnect 后留下孤儿 client（stdio 子进程 /
                // HTTP session 悬挂）。引用比较防止误删随后 connect 注册的新 client。
                if (deps.clients.get(info.config.id) === sseClient) {
                    deps.clients.delete(info.config.id);
                }
                void sseClient.disconnect().catch(() => { /* 连接可能已死，忽略 */ });
            });

            // 提前注册到管理 map
            deps.clients.set(info.config.id, sseClient);

            try {
                await sseClient.connect();
            } catch (_e) {
                if (deps.clients.get(info.config.id) === sseClient) {
                    deps.clients.delete(info.config.id);
                }
                await sseClient.disconnect();
                throw _e;
            }

            if (!deps.isCurrentGeneration(info.config.id, generation)) {
                await sseClient.disconnect();
                return;
            }

            info.capabilities = {
                tools: sseClient.getTools().map(t => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema
                })),
                resources: sseClient.getResources().map(r => ({
                    uri: r.uri,
                    name: r.name,
                    description: r.description,
                    mimeType: r.mimeType
                })),
                prompts: sseClient.getPrompts().map(p => ({
                    name: p.name,
                    description: p.description,
                    arguments: p.arguments
                }))
            };
            info.protocolVersion = sseClient.getProtocolVersion();

            const sseServerInfo = sseClient.getServerInfo();
            if (sseServerInfo) {
                info.serverVersion = sseServerInfo.version;
                info.serverDescription = sseServerInfo.name;
            }
            sseClient.on('notification', (method: string, params?: unknown) => {
                if (!deps.isCurrentGeneration(info.config.id, generation)) {
                    return;
                }
                void deps.handleServerNotification(info, sseClient, generation, method, params);
            });
            break;
        }

        case 'streamable-http': {
            // 与 stdio 分支对齐：error 状态下旧 HttpMcpClient 可能仍持有进行中的
            // fetch/读流，直接覆盖 clients 条目会把旧 client 孤儿化（activeControllers/
            // activeReaders 永不释放，session 悬挂）。先断开旧 client 再建新连接。
            const previousHttpClient = deps.clients.get(info.config.id);
            if (previousHttpClient) {
                try {
                    await previousHttpClient.disconnect();
                } catch {
                    // 忽略，继续建新连接
                }
            }

            const httpClient = new HttpMcpClient(
                transport.url,
                'streamable-http',
                transport.headers || {},
                info.config.timeout ?? 30000
            );

            // 设置错误处理（带代际校验）：HTTP 服务器死亡/网络错误/SSE 流意外结束时
            // 广播错误并置 error 状态——否则服务器死后状态永久 connected
            //（与 stdio 分支的 error 处理同口径）
            httpClient.on('error', (err: Error) => {
                if (!deps.isCurrentGeneration(info.config.id, generation)) {
                    return;
                }
                // 连接中（connect 尚未返回）的错误统一由 runConnect catch 置状态并广播，
                // 此处只记 lastError，避免 server:error 双重广播；连接完成后的运行期
                // 错误才在此广播（与 runConnect catch 同口径）。
                const wasConnecting = info.status === 'connecting';
                info.lastError = err.message;
                deps.updateServerStatus(info.config.id, 'error');
                if (wasConnecting) {
                    return;
                }
                deps.emitEvent({
                    type: 'server:error',
                    serverId: info.config.id,
                    data: { error: err.message },
                    timestamp: Date.now()
                });
                // 运行期错误后 client 已不可用（僵尸态，状态门禁已拦截后续调用）：
                // 从管理 map 摘除并断开底层连接，避免 deleteServer/setServerEnabled
                // 在 error 状态跳过 disconnect 后留下孤儿 client（stdio 子进程 /
                // HTTP session 悬挂）。引用比较防止误删随后 connect 注册的新 client。
                if (deps.clients.get(info.config.id) === httpClient) {
                    deps.clients.delete(info.config.id);
                }
                void httpClient.disconnect().catch(() => { /* 连接可能已死，忽略 */ });
            });

            // 提前注册到管理 map
            deps.clients.set(info.config.id, httpClient);

            try {
                await httpClient.connect();
            } catch (_e) {
                if (deps.clients.get(info.config.id) === httpClient) {
                    deps.clients.delete(info.config.id);
                }
                await httpClient.disconnect();
                throw _e;
            }

            if (!deps.isCurrentGeneration(info.config.id, generation)) {
                await httpClient.disconnect();
                return;
            }

            info.capabilities = {
                tools: httpClient.getTools().map(t => ({
                    name: t.name,
                    description: t.description,
                    inputSchema: t.inputSchema
                })),
                resources: httpClient.getResources().map(r => ({
                    uri: r.uri,
                    name: r.name,
                    description: r.description,
                    mimeType: r.mimeType
                })),
                prompts: httpClient.getPrompts().map(p => ({
                    name: p.name,
                    description: p.description,
                    arguments: p.arguments
                }))
            };
            info.protocolVersion = httpClient.getProtocolVersion();

            const httpServerInfo = httpClient.getServerInfo();
            if (httpServerInfo) {
                info.serverVersion = httpServerInfo.version;
                info.serverDescription = httpServerInfo.name;
            }
            httpClient.on('notification', (method: string, params?: unknown) => {
                if (!deps.isCurrentGeneration(info.config.id, generation)) {
                    return;
                }
                void deps.handleServerNotification(info, httpClient, generation, method, params);
            });
            break;
        }
    }
}

/**
 * 执行断开连接
 */
export async function performDisconnect(
    deps: McpConnectionDeps,
    info: McpServerInfo
): Promise<void> {
    const client = deps.clients.get(info.config.id);
    if (client) {
        await client.disconnect();
        // 只删除自己断开的 client，避免误删并发 connect 注册的新客户端
        if (deps.clients.get(info.config.id) === client) {
            deps.clients.delete(info.config.id);
        }
    }
    // 清理该 server 的刷新链与合并标记：残留链会让重连后的新代际通知误合并到旧链上
    //（旧链代际校验跳过刷新 → 通知丢失）；在途旧链本身会正常结束，不受此处清理影响
    deps.refreshChains.delete(info.config.id);
    deps.refreshPending.delete(info.config.id);
}
