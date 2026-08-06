/**
 * LimCode MCP (Model Context Protocol) 模块 - 客户端管理器
 *
 * 管理 MCP 服务器配置和客户端连接
 */

import { t } from '../../i18n';
import type {
    McpServerConfig,
    McpServerInfo,
    McpServerStatus,
    McpServerCapabilities,
    McpStorageAdapter,
    CreateMcpServerInput,
    UpdateMcpServerInput,
    McpToolCallRequest,
    McpToolCallResult,
    McpResourceReadRequest,
    McpResourceContent,
    McpPromptGetRequest,
    McpPromptMessage,
    McpEvent,
    McpEventListener,
    McpEventType
} from './types';
import { StdioMcpClient } from './StdioClient';
import { HttpMcpClient } from './HttpClient';
import { MCP_SERVER_ID_PATTERN } from './mcpToolNameCodec';

/**
 * 生成唯一 ID（名称无法 slug 化或 slug 冲突时的回退方案）
 */
function generateId(): string {
    return `mcp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * 将服务器名称转换为可读的 slug ID
 *
 * 规则：
 * - 转为小写，空白替换为单下划线
 * - 仅保留字母、数字、下划线、中划线
 * - 折叠连续下划线（避免双下划线破坏 MCP 工具名解码）
 * - 结果不符合 MCP_SERVER_ID_PATTERN 时返回空串（调用方回退随机 ID）
 */
function slugifyServerName(name: string): string {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/^-+|-+$/g, '');
    return MCP_SERVER_ID_PATTERN.test(slug) ? slug : '';
}

/**
 * MCP 管理器
 * 
 * 负责：
 * - 管理服务器配置（CRUD）
 * - 管理服务器连接状态
 * - 提供工具调用、资源读取等功能
 */
export class McpManager {
    /** 存储适配器 */
    private storageAdapter: McpStorageAdapter;
    
    /** 服务器运行时信息 */
    private servers: Map<string, McpServerInfo> = new Map();
    
    /** 活跃的客户端连接 */
    private clients: Map<string, StdioMcpClient | HttpMcpClient> = new Map();
    
    /** 每个 serverId 的连接代际计数（防止旧连接的 catch/exit/error 回调覆盖新连接状态） */
    private connectGenerations: Map<string, number> = new Map();
    
    /** 每个 serverId 的 in-flight connect promise（防止并发 connect 假成功） */
    private connectPromises: Map<string, Promise<void>> = new Map();

    /** 每个 serverId 的列表刷新链（串行化并发 list_changed 通知刷新，防止旧刷新覆盖新数据） */
    private refreshChains: Map<string, Promise<void>> = new Map();
    
    /** 事件监听器 */
    private listeners: Map<McpEventType, Set<McpEventListener>> = new Map();
    
    /** 是否已初始化 */
    private initialized: boolean = false;

    constructor(storageAdapter: McpStorageAdapter) {
        this.storageAdapter = storageAdapter;
    }

    /**
     * 初始化管理器
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }
        
        // 从文件加载配置并初始化运行时状态
        await this.reloadFromStorage();

        this.initialized = true;

        // 触发自动连接
        const serversToConnect = this.getServersToAutoConnect();
        for (const serverId of serversToConnect) {
            // 异步连接，不阻塞初始化流程
            this.connect(serverId).catch(e => {
                console.error(`[MCP] Auto-connect failed for ${serverId}:`, e);
            });
        }
    }
    
    /**
     * 获取需要自动连接的服务器列表
     */
    getServersToAutoConnect(): string[] {
        const serverIds: string[] = [];
        for (const [serverId, info] of this.servers) {
            if (info.config.enabled && info.config.autoConnect && info.status === 'disconnected') {
                serverIds.push(serverId);
            }
        }
        return serverIds;
    }

    /**
     * 从存储重新加载配置
     * 保留运行时状态（连接状态等）
     */
    private async reloadFromStorage(): Promise<void> {
        const configs = await this.storageAdapter.getAllConfigs();
        const configMap = new Map(configs.map(c => [c.id, c]));
        
        // 更新已存在的服务器配置
        for (const [serverId, info] of this.servers) {
            const newConfig = configMap.get(serverId);
            if (newConfig) {
                info.config = newConfig;
                configMap.delete(serverId);
            } else {
                // 服务器已被删除，断开连接
                if (info.status === 'connected' || info.status === 'connecting') {
                    await this.disconnect(serverId).catch(() => {});
                }
                this.servers.delete(serverId);
            }
        }
        
        // 添加新服务器
        for (const [serverId, config] of configMap) {
            this.servers.set(serverId, {
                config,
                status: 'disconnected'
            });
        }
    }

    /**
     * 释放资源
     */
    async dispose(): Promise<void> {
        // 断开所有连接
        for (const [serverId] of this.servers) {
            try {
                await this.disconnect(serverId);
            } catch {
                // 忽略断开失败
            }
        }

        this.servers.clear();
        this.listeners.clear();
        this.initialized = false;
    }

    // ==================== 服务器配置管理 ====================

    /**
     * 验证服务器 ID 是否可用（不重复）
     * @param id 要验证的 ID
     * @param excludeId 排除的 ID（用于更新时排除自身）
     */
    async validateServerId(id: string, excludeId?: string): Promise<{ valid: boolean; error?: string }> {
        // 验证 ID 格式（只允许字母、数字、下划线、中划线，禁止双下划线）
        if (!MCP_SERVER_ID_PATTERN.test(id)) {
            return { valid: false, error: t('modules.mcp.errors.invalidServerId') };
        }
        
        // 检查是否与其他 MCP 服务器 ID 重复
        const configs = await this.storageAdapter.getAllConfigs();
        for (const config of configs) {
            if (config.id === id && config.id !== excludeId) {
                return { valid: false, error: t('modules.mcp.errors.serverIdExists', { serverId: id }) };
            }
        }
        
        return { valid: true };
    }
    
    /**
     * 创建服务器配置
     * @param input 服务器配置输入
     * @param customId 自定义 ID（可选，不提供则自动生成）
     */
    async createServer(input: CreateMcpServerInput, customId?: string): Promise<string> {
        const id = customId || await this.generateReadableId(input.name);
        
        // 验证 ID 是否可用
        const validation = await this.validateServerId(id);
        if (!validation.valid) {
            throw new Error(validation.error);
        }
        
        const now = Date.now();
        const config: McpServerConfig = {
            ...input,
            id,
            createdAt: now,
            updatedAt: now
        };

        await this.storageAdapter.saveConfig(config);
        
        this.servers.set(config.id, {
            config,
            status: 'disconnected'
        });
        
        // 如果启用了自动连接，立即尝试连接
        if (config.enabled && config.autoConnect) {
            // 异步连接，不阻塞创建流程
            this.connect(config.id).catch(() => {
                // 忽略自动连接失败
            });
        }
        
        return config.id;
    }

    /**
     * 生成可读的服务器 ID：优先基于名称生成 slug，冲突或无法生成时回退随机 ID
     */
    private async generateReadableId(name: string): Promise<string> {
        const slug = slugifyServerName(name);
        if (slug) {
            // slug 未被占用时直接使用
            const direct = await this.validateServerId(slug);
            if (direct.valid) {
                return slug;
            }
            // slug 被占用时追加数字后缀（_2、_3 …），最多尝试 100 次
            for (let i = 2; i <= 100; i++) {
                const candidate = `${slug}_${i}`;
                const validation = await this.validateServerId(candidate);
                if (validation.valid) {
                    return candidate;
                }
            }
        }
        // 名称无法 slug 化（如纯中文）或全部冲突时回退随机 ID
        return generateId();
    }

    /**
     * 获取服务器配置（从文件读取）
     */
    async getServer(serverId: string): Promise<McpServerConfig | null> {
        // 直接从文件读取，确保获取最新配置
        return await this.storageAdapter.getConfig(serverId);
    }

    /**
     * 获取服务器运行时信息（包含连接状态）
     * 配置从文件读取，运行时状态从内存获取
     */
    async getServerInfo(serverId: string): Promise<McpServerInfo | null> {
        const config = await this.storageAdapter.getConfig(serverId);
        if (!config) {
            return null;
        }
        
        const runtimeInfo = this.servers.get(serverId);
        return {
            config,
            status: runtimeInfo?.status ?? 'disconnected',
            capabilities: runtimeInfo?.capabilities,
            protocolVersion: runtimeInfo?.protocolVersion,
            serverVersion: runtimeInfo?.serverVersion,
            serverDescription: runtimeInfo?.serverDescription,
            lastError: runtimeInfo?.lastError,
            connectedAt: runtimeInfo?.connectedAt
        };
    }

    /**
     * 更新服务器配置
     */
    async updateServer(serverId: string, updates: UpdateMcpServerInput): Promise<void> {
        const info = this.servers.get(serverId);
        if (!info) {
            throw new Error(t('modules.mcp.errors.serverNotFound', { serverId }));
        }

        const updatedConfig: McpServerConfig = {
            ...info.config,
            ...updates,
            updatedAt: Date.now()
        };

        await this.storageAdapter.saveConfig(updatedConfig);
        info.config = updatedConfig;
    }

    /**
     * 删除服务器配置
     */
    async deleteServer(serverId: string): Promise<void> {
        const info = this.servers.get(serverId);
        if (!info) {
            throw new Error(t('modules.mcp.errors.serverNotFound', { serverId }));
        }

        // 先断开连接
        if (info.status === 'connected' || info.status === 'connecting') {
            await this.disconnect(serverId);
        }

        await this.storageAdapter.deleteConfig(serverId);
        this.servers.delete(serverId);
    }

    /**
     * 列出所有服务器（从文件读取配置，合并运行时状态）
     */
    async listServers(): Promise<McpServerInfo[]> {
        const configs = await this.storageAdapter.getAllConfigs();
        
        return configs.map(config => {
            const runtimeInfo = this.servers.get(config.id);
            return {
                config,
                status: runtimeInfo?.status ?? 'disconnected',
                capabilities: runtimeInfo?.capabilities,
                protocolVersion: runtimeInfo?.protocolVersion,
                serverVersion: runtimeInfo?.serverVersion,
                serverDescription: runtimeInfo?.serverDescription,
                lastError: runtimeInfo?.lastError,
                connectedAt: runtimeInfo?.connectedAt
            };
        });
    }

    /**
     * 列出所有服务器配置（直接从文件读取）
     */
    async listServerConfigs(): Promise<McpServerConfig[]> {
        return await this.storageAdapter.getAllConfigs();
    }

    /**
     * 设置服务器启用状态
     */
    async setServerEnabled(serverId: string, enabled: boolean): Promise<void> {
        await this.updateServer(serverId, { enabled });
        
        // 如果禁用，断开连接
        if (!enabled) {
            const info = this.servers.get(serverId);
            if (info && (info.status === 'connected' || info.status === 'connecting')) {
                await this.disconnect(serverId);
            }
        }
    }

    // ==================== 连接管理 ====================

    /**
     * 连接到服务器
     *
     * 并发保护：
     * - 已连接：直接返回
     * - 已有 in-flight connect：复用同一个 promise（避免第二个调用方"假成功"）
     * - 每次连接分配递增代际号，旧连接的 catch/exit/error 回调不会影响新连接
     */
    async connect(serverId: string): Promise<void> {
        // 先尝试从存储重新加载（支持手动编辑配置文件的情况）
        await this.reloadFromStorage();
        
        let info = this.servers.get(serverId);
        if (!info) {
            // 列出所有可用的服务器 ID
            const availableIds = Array.from(this.servers.keys());
            throw new Error(t('modules.mcp.errors.serverNotFoundWithAvailable', {
                serverId,
                available: availableIds.join(', ') || 'none'
            }));
        }

        if (!info.config.enabled) {
            throw new Error(t('modules.mcp.errors.serverDisabled', { serverId }));
        }

        if (info.status === 'connected') {
            return;
        }

        // 复用 in-flight connect promise（注意：上方检查与下方注册之间没有 await，并发调用会串行化）
        const inFlight = this.connectPromises.get(serverId);
        if (inFlight) {
            return inFlight;
        }

        const generation = this.nextGeneration(serverId);
        this.updateServerStatus(serverId, 'connecting');

        const promise = this.runConnect(serverId, info, generation);
        this.connectPromises.set(serverId, promise);

        try {
            await promise;
        } finally {
            // 只清理自己注册的 promise，避免误删新连接注册的 promise
            if (this.connectPromises.get(serverId) === promise) {
                this.connectPromises.delete(serverId);
            }
        }
    }

    /**
     * 断开服务器连接
     */
    async disconnect(serverId: string): Promise<void> {
        const info = this.servers.get(serverId);
        if (!info) {
            throw new Error(t('modules.mcp.errors.serverNotFound', { serverId }));
        }

        if (info.status === 'disconnected') {
            return;
        }

        // 使 in-flight connect 失效：其 promise 不再被复用，其回调/完成路径也不会覆盖新状态
        const disconnectGeneration = this.nextGeneration(serverId);
        this.connectPromises.delete(serverId);

        // 立即标记为 disconnected；若期间有新的 connect 启动，由代际校验防止覆盖
        this.updateServerStatus(serverId, 'disconnected');
        info.connectedAt = undefined;
        info.capabilities = undefined;

        try {
            await this.performDisconnect(info);
        } catch {
            // 忽略断开连接错误
        }

        // 断开期间若已启动新连接（代际已变），不重复发 disconnected 事件
        if (this.connectGenerations.get(serverId) !== disconnectGeneration) {
            return;
        }

        this.emitEvent({
            type: 'server:disconnected',
            serverId,
            timestamp: Date.now()
        });
    }

    /**
     * 重新连接服务器
     */
    async reconnect(serverId: string): Promise<void> {
        await this.disconnect(serverId);
        await this.connect(serverId);
    }

    /**
     * 获取服务器状态
     */
    getServerStatus(serverId: string): McpServerStatus | null {
        const info = this.servers.get(serverId);
        return info?.status ?? null;
    }

    // ==================== MCP 操作 ====================

    /**
     * 调用工具
     */
    async callTool(request: McpToolCallRequest): Promise<McpToolCallResult> {
        const info = this.servers.get(request.serverId);
        if (!info) {
            return {
                success: false,
                error: t('modules.mcp.errors.serverNotFound', { serverId: request.serverId })
            };
        }

        if (info.status !== 'connected') {
            return {
                success: false,
                error: t('modules.mcp.errors.serverNotConnected', { serverName: info.config.name })
            };
        }

        try {
            const result = await this.performToolCall(info, request);
            
            this.emitEvent({
                type: 'tool:result',
                serverId: request.serverId,
                data: { toolName: request.toolName, result },
                timestamp: Date.now()
            });

            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                error: errorMessage,
                isError: true
            };
        }
    }

    /**
     * 读取资源
     */
    async readResource(request: McpResourceReadRequest): Promise<McpResourceContent | null> {
        const info = this.servers.get(request.serverId);
        if (!info) {
            throw new Error(t('modules.mcp.errors.serverNotFound', { serverId: request.serverId }));
        }

        if (info.status !== 'connected') {
            throw new Error(t('modules.mcp.errors.serverNotConnected', { serverName: info.config.name }));
        }

        return await this.performResourceRead(info, request);
    }

    /**
     * 获取提示
     */
    async getPrompt(request: McpPromptGetRequest): Promise<McpPromptMessage[]> {
        const info = this.servers.get(request.serverId);
        if (!info) {
            throw new Error(t('modules.mcp.errors.serverNotFound', { serverId: request.serverId }));
        }

        if (info.status !== 'connected') {
            throw new Error(t('modules.mcp.errors.serverNotConnected', { serverName: info.config.name }));
        }

        return await this.performPromptGet(info, request);
    }

    /**
     * 获取所有已连接服务器的工具列表
     */
    getAllTools(): Array<{ serverId: string; serverName: string; tools: McpServerCapabilities['tools']; cleanSchema: boolean }> {
        const result: Array<{ serverId: string; serverName: string; tools: McpServerCapabilities['tools']; cleanSchema: boolean }> = [];

        for (const [serverId, info] of this.servers) {
            if (info.status === 'connected' && info.capabilities?.tools) {
                result.push({
                    serverId,
                    serverName: info.config.name,
                    tools: info.capabilities.tools,
                    // 默认为 true（清理 schema）
                    cleanSchema: info.config.cleanSchema !== false
                });
            }
        }

        return result;
    }

    /**
     * 获取所有已连接服务器的资源列表
     */
    getAllResources(): Array<{ serverId: string; serverName: string; resources: McpServerCapabilities['resources'] }> {
        const result: Array<{ serverId: string; serverName: string; resources: McpServerCapabilities['resources'] }> = [];

        for (const [serverId, info] of this.servers) {
            if (info.status === 'connected' && info.capabilities?.resources) {
                result.push({
                    serverId,
                    serverName: info.config.name,
                    resources: info.capabilities.resources
                });
            }
        }

        return result;
    }

    /**
     * 获取所有已连接服务器的提示模板列表
     */
    getAllPrompts(): Array<{ serverId: string; serverName: string; prompts: McpServerCapabilities['prompts'] }> {
        const result: Array<{ serverId: string; serverName: string; prompts: McpServerCapabilities['prompts'] }> = [];

        for (const [serverId, info] of this.servers) {
            if (info.status === 'connected' && info.capabilities?.prompts) {
                result.push({
                    serverId,
                    serverName: info.config.name,
                    prompts: info.capabilities.prompts
                });
            }
        }

        return result;
    }

    // ==================== 事件系统 ====================

    /**
     * 添加事件监听器
     */
    addEventListener(type: McpEventType, listener: McpEventListener): void {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }
        this.listeners.get(type)!.add(listener);
    }

    /**
     * 移除事件监听器
     */
    removeEventListener(type: McpEventType, listener: McpEventListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    /**
     * 发送事件
     */
    private emitEvent(event: McpEvent): void {
        const listeners = this.listeners.get(event.type);
        if (listeners) {
            for (const listener of listeners) {
                try {
                    listener(event);
                } catch {
                    // 忽略监听器错误
                }
            }
        }
    }

    // ==================== 私有方法 ====================

    /**
     * 更新服务器状态
     */
    private updateServerStatus(serverId: string, status: McpServerStatus): void {
        const info = this.servers.get(serverId);
        if (info) {
            info.status = status;
        }
    }

    /**
     * 判断指定代际是否仍是 serverId 的当前连接代际
     */
    private isCurrentGeneration(serverId: string, generation: number): boolean {
        return this.connectGenerations.get(serverId) === generation;
    }

    /**
     * 递增并返回 serverId 的下一个连接代际号
     */
    private nextGeneration(serverId: string): number {
        const next = (this.connectGenerations.get(serverId) ?? 0) + 1;
        this.connectGenerations.set(serverId, next);
        return next;
    }

    /**
     * 执行连接并更新状态（带代际校验）
     *
     * 旧代际的连接完成/失败路径不会覆盖新连接的状态；
     * 但错误仍会传播给发起该次连接的调用方。
     */
    private async runConnect(serverId: string, info: McpServerInfo, generation: number): Promise<void> {
        try {
            await this.performConnect(info, generation);

            // 旧代际的连接完成路径不得覆盖新连接的状态
            if (!this.isCurrentGeneration(serverId, generation)) {
                return;
            }

            this.updateServerStatus(serverId, 'connected');
            info.connectedAt = Date.now();

            this.emitEvent({
                type: 'server:connected',
                serverId,
                timestamp: Date.now()
            });
        } catch (error) {
            // 旧代际连接失败：不覆盖新连接的状态（错误仍传播给调用方）
            if (!this.isCurrentGeneration(serverId, generation)) {
                throw error;
            }

            const errorMessage = error instanceof Error ? error.message : String(error);
            info.lastError = errorMessage;
            this.updateServerStatus(serverId, 'error');

            this.emitEvent({
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
    private async performConnect(info: McpServerInfo, generation: number): Promise<void> {
        const { transport } = info.config;
        
        switch (transport.type) {
            case 'stdio': {
                // error 状态下旧 stdio 子进程可能仍存活：直接覆盖 clients 条目会把旧 client
                // 孤儿化（子进程存活到自然退出）。先断开旧 client（tree-kill）再建新连接；
                // 旧 client 的 exit 回调带代际 + 引用双重校验，不会误删随后注册的新 client。
                const previousClient = this.clients.get(info.config.id);
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
                    if (!this.isCurrentGeneration(info.config.id, generation)) {
                        return;
                    }
                    info.lastError = err.message;
                    this.updateServerStatus(info.config.id, 'error');
                });

                client.on('exit', () => {
                    if (!this.isCurrentGeneration(info.config.id, generation)) {
                        return;
                    }
                    // 只删除自己注册的 client，避免误删随后 connect 注册的新客户端
                    if (this.clients.get(info.config.id) === client) {
                        this.clients.delete(info.config.id);
                    }
                    this.updateServerStatus(info.config.id, 'disconnected');
                });

                // 提前注册到管理 map，确保连接过程中的 delete/disable/disconnect 能找到它
                this.clients.set(info.config.id, client);

                try {
                    await client.connect();
                } catch (_e) {
                    // 只清理自己注册的 client
                    if (this.clients.get(info.config.id) === client) {
                        this.clients.delete(info.config.id);
                    }
                    await client.disconnect();
                    throw _e;
                }

                // 连接期间若已被 disconnect/新 connect 取代，不再写入能力并关闭旧进程
                if (!this.isCurrentGeneration(info.config.id, generation)) {
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
                    if (!this.isCurrentGeneration(info.config.id, generation)) {
                        return;
                    }
                    // fire-and-forget：handleServerNotification 内部按 serverId 串行化、
                    // 自带异常兜底，不会产生未处理的 rejection（async 监听器 rejection 兜底）
                    void this.handleServerNotification(info, client, generation, method, params);
                });
                break;
            }

            case 'sse': {
                const sseClient = new HttpMcpClient(
                    transport.url,
                    'sse',
                    transport.headers || {},
                    info.config.timeout || 30000
                );

                // 提前注册到管理 map
                this.clients.set(info.config.id, sseClient);

                try {
                    await sseClient.connect();
                } catch (_e) {
                    if (this.clients.get(info.config.id) === sseClient) {
                        this.clients.delete(info.config.id);
                    }
                    await sseClient.disconnect();
                    throw _e;
                }

                if (!this.isCurrentGeneration(info.config.id, generation)) {
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
                break;
            }

            case 'streamable-http': {
                const httpClient = new HttpMcpClient(
                    transport.url,
                    'streamable-http',
                    transport.headers || {},
                    info.config.timeout || 30000
                );

                // 提前注册到管理 map
                this.clients.set(info.config.id, httpClient);

                try {
                    await httpClient.connect();
                } catch (_e) {
                    if (this.clients.get(info.config.id) === httpClient) {
                        this.clients.delete(info.config.id);
                    }
                    await httpClient.disconnect();
                    throw _e;
                }

                if (!this.isCurrentGeneration(info.config.id, generation)) {
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
                break;
            }
        }
    }

    /**
     * 执行断开连接
     */
    private async performDisconnect(info: McpServerInfo): Promise<void> {
        const client = this.clients.get(info.config.id);
        if (client) {
            await client.disconnect();
            // 只删除自己断开的 client，避免误删并发 connect 注册的新客户端
            if (this.clients.get(info.config.id) === client) {
                this.clients.delete(info.config.id);
            }
        }
    }

    /**
     * 处理服务器推送的通知
     *
     * 收到列表变更通知（notifications/tools|resources|prompts/list_changed）时，
     * 重新拉取列表并刷新 info.capabilities 缓存，供 ToolDeclarationResolver 等
     * 消费方在下一次工具声明重建时使用新数据。
     * - 同一 serverId 的刷新按到达顺序串行执行（per-server 刷新链），
     *   避免并发刷新时旧结果覆盖新结果
     * - 刷新完成写入 capabilities 前重查代际：await 期间若已 disconnect/重连，
     *   不得用旧 client 的空列表覆盖新连接的能力缓存
     * - 刷新失败仅记日志，不重连（避免服务器临时故障时无谓重连）
     * - 刷新成功广播 server:capabilities_updated 事件，供前端等订阅方感知
     * - 全程不向外抛出 rejection（async 监听器兜底：链尾 catch）
     */
    private async handleServerNotification(
        info: McpServerInfo,
        client: StdioMcpClient,
        generation: number,
        method: string,
        params?: any
    ): Promise<void> {
        if (method !== 'notifications/tools/list_changed'
            && method !== 'notifications/resources/list_changed'
            && method !== 'notifications/prompts/list_changed') {
            return;
        }

        const serverId = info.config.id;
        // per-server 刷新链：后到的通知排在先到的之后执行，旧刷新不得覆盖新数据
        const previous = this.refreshChains.get(serverId) ?? Promise.resolve();
        const refresh = previous.then(async () => {
            // 排队期间可能已 disconnect/重连：代际已变则跳过本次刷新
            if (!this.isCurrentGeneration(serverId, generation)) {
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
            if (!this.isCurrentGeneration(serverId, generation)) {
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

            this.emitEvent({
                type: 'server:capabilities_updated',
                serverId,
                data: { method },
                timestamp: Date.now()
            });
        });
        // 链尾兜底：异常不得让刷新链断裂，也不得产生未处理的 rejection（监听器无 await 方）
        this.refreshChains.set(serverId, refresh.catch(error => {
            console.error(`[MCP] Unexpected error during list refresh for ${serverId}:`, error);
        }));
        await this.refreshChains.get(serverId);
    }

    /**
     * 执行工具调用
     */
    private async performToolCall(
        info: McpServerInfo,
        request: McpToolCallRequest
    ): Promise<McpToolCallResult> {
        const client = this.clients.get(info.config.id);
        if (!client) {
            return {
                success: false,
                error: t('modules.mcp.errors.clientNotConnected')
            };
        }
        
        try {
            const result = await client.callTool(request.toolName, request.arguments, request.signal);
            return {
                success: !result.isError,
                content: result.content.map(c => ({
                    type: c.type as 'text' | 'image' | 'resource',
                    text: c.text,
                    data: c.data,
                    mimeType: c.mimeType
                })),
                isError: result.isError
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : t('modules.mcp.errors.toolCallFailed')
            };
        }
    }

    /**
     * 执行资源读取
     */
    private async performResourceRead(
        info: McpServerInfo,
        request: McpResourceReadRequest
    ): Promise<McpResourceContent | null> {
        const client = this.clients.get(info.config.id);
        if (!client) {
            throw new Error(t('modules.mcp.errors.clientNotConnected'));
        }
        
        const result = await client.readResource(request.uri, request.signal);
        const content = result.contents[0];
        if (!content) {
            return null;
        }
        
        return {
            uri: content.uri,
            mimeType: content.mimeType,
            text: content.text,
            blob: content.blob
        };
    }

    /**
     * 执行提示获取
     */
    private async performPromptGet(
        info: McpServerInfo,
        request: McpPromptGetRequest
    ): Promise<McpPromptMessage[]> {
        const client = this.clients.get(info.config.id);
        if (!client) {
            throw new Error(t('modules.mcp.errors.clientNotConnected'));
        }
        
        const result = await client.getPrompt(request.promptName, request.arguments, request.signal);
        return result.messages.map(m => ({
            role: m.role as 'user' | 'assistant',
            content: {
                type: m.content.type as 'text' | 'image' | 'resource',
                text: m.content.text
            }
        }));
    }
}