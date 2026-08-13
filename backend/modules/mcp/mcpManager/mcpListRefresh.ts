/**
 * GrayCode MCP 能力列表刷新层
 *
 * 从 McpManager 抽离：处理服务器推送的列表变更通知
 * （notifications/tools|resources|prompts/list_changed），
 * 重新拉取列表并刷新 info.capabilities 缓存。
 */

import type { McpServerInfo, McpEvent } from '../types';
import type { StdioMcpClient } from '../StdioClient';
import type { HttpMcpClient } from '../HttpClient';

/**
 * 列表刷新层依赖（由 McpManager 提供）
 */
export interface McpListRefreshDeps {
    readonly refreshChains: Map<string, { promise: Promise<void>; generation: number }>;
    readonly refreshPending: Map<string, boolean>;
    isCurrentGeneration(serverId: string, generation: number): boolean;
    emitEvent(event: McpEvent): void;
}

/**
 * 处理服务器推送的通知
 *
 * 收到列表变更通知（notifications/tools|resources|prompts/list_changed）时，
 * 重新拉取列表并刷新 info.capabilities 缓存，供 ToolDeclarationResolver 等
 * 消费方在下一次工具声明重建时使用新数据。
 * - 同一 serverId 的刷新按到达顺序串行执行（per-server 刷新链），
 *   避免并发刷新时旧结果覆盖新结果；通知风暴时合并（链长有上限），
 *   disconnect 时清理残留链
 * - 刷新完成写入 capabilities 前重查代际：await 期间若已 disconnect/重连，
 *   不得用旧 client 的空列表覆盖新连接的能力缓存
 * - 刷新失败仅记日志，不重连（避免服务器临时故障时无谓重连）
 * - 刷新成功广播 server:capabilities_updated 事件，供前端等订阅方感知
 * - 全程不向外抛出 rejection（async 监听器兜底：链尾 catch）
 */
export async function handleServerNotification(
    deps: McpListRefreshDeps,
    info: McpServerInfo,
    client: StdioMcpClient | HttpMcpClient,
    generation: number,
    method: string,
    params?: unknown
): Promise<void> {
    if (method !== 'notifications/tools/list_changed'
        && method !== 'notifications/resources/list_changed'
        && method !== 'notifications/prompts/list_changed') {
        return;
    }

    const serverId = info.config.id;
    // 合并通知风暴：同一 server 已有在途刷新链时不追加链节（链长有上限），仅置
    // refreshPending 标记，由链尾补刷一次，避免 list_changed 通知风暴下链无限增长。
    // 旧代际残留链（disconnect 后未及清理）不合并：等待其结束后走新链，防止通知丢失。
    // 等待结束后循环重查 refreshChains：并发等待同一条旧链的多个新代际通知，若各自
    // 直接落穿建链，后建链会覆盖先建链的注册 → 双链并发刷新（旧结果覆盖新结果）。
    for (;;) {
        const queued = deps.refreshChains.get(serverId);
        if (!queued) {
            break;
        }
        if (queued.generation === generation) {
            deps.refreshPending.set(serverId, true);
            await queued.promise;
            // 链已结束且消费了 pending（补刷已发生）：本次通知已被覆盖；
            // pending 仍为 true（链结束前未及消费的极端时序）：走新链补刷，确保不丢
            if (deps.refreshPending.get(serverId) !== true) {
                return;
            }
            deps.refreshPending.set(serverId, false);
            // 已结束链未消费 pending：需自建新链补刷（注册会覆盖已结束的旧链，旧注册者
            // 的比较式清理不会误删新链），无需继续循环等待
            break;
        }
        // 代际不匹配（旧链残留或等待期间其他通知注册的新链）：等待其结束后重查，
        // 期间注册的新链会被继续等待合并，避免双链并发刷新
        await queued.promise;
    }

    // 执行刷新；执行期间合并进来的通知（pending）触发链尾补刷
    deps.refreshPending.set(serverId, false);
    const chain = (async () => {
        for (;;) {
            // 排队期间可能已 disconnect/重连：代际已变则跳过本次刷新
            if (!deps.isCurrentGeneration(serverId, generation)) {
                return;
            }

            try {
                await client.refreshLists();
            } catch (error) {
                // 刷新失败仅记日志，不重连
                console.error(`[MCP] Failed to refresh lists for ${serverId} after ${method}:`, error);
                return;
            }

            // 写入前重查代际：await 期间可能已 disconnect/重连，
            // 不得用旧 client 的空列表覆盖新连接的能力缓存
            if (!deps.isCurrentGeneration(serverId, generation)) {
                return;
            }

            // 重建能力缓存：下一次 getAllTools/getAllResources/getAllPrompts 使用新数据
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

            deps.emitEvent({
                type: 'server:capabilities_updated',
                serverId,
                data: { method },
                timestamp: Date.now()
            });

            // 执行期间有合并进来的通知：补刷一次
            if (deps.refreshPending.get(serverId) !== true) {
                return;
            }
            deps.refreshPending.set(serverId, false);
        }
    })();
    // 链尾兜底：异常不得让刷新链断裂，也不得产生未处理的 rejection（监听器无 await 方）
    const safeChain = chain.catch(error => {
        console.error(`[MCP] Unexpected error during list refresh for ${serverId}:`, error);
    });
    deps.refreshChains.set(serverId, { promise: safeChain, generation });
    try {
        await safeChain;
    } finally {
        // 只清理自己注册的链，避免误删并发注册的新链
        if (deps.refreshChains.get(serverId)?.promise === safeChain) {
            deps.refreshChains.delete(serverId);
        }
    }
}
