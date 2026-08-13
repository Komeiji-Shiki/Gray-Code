/**
 * GrayCode MCP (Model Context Protocol) 模块 - 客户端管理器
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
import { generateId, slugifyServerName, transportConfigChanged } from './mcpManager/mcpServerId';
import { performToolCall, performResourceRead, performPromptGet } from './mcpManager/mcpOperations';
import { runConnect, performDisconnect, type McpConnectionDeps } from './mcpManager/mcpConnection';
import { handleServerNotification } from './mcpManager/mcpListRefresh';


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

    /** 每个 serverId 的列表刷新链（串行化 list_changed 通知刷新，防止旧刷新覆盖新数据）；
     *  同代际通知合并（refreshPending 标记），链长有上限，disconnect 时清理 */
    private refreshChains: Map<string, { promise: Promise<void>; generation: number }> = new Map();

    /** 每个 serverId 的刷新合并标记：已有在途刷新链时，后续通知仅置位，由链尾补刷一次 */
    private refreshPending: Map<string, boolean> = new Map();
    
    /** 事件监听器 */
    private listeners: Map<McpEventType, Set<McpEventListener>> = new Map();
    
    /** 是否已初始化 */
    private initialized: boolean = false;

    /** 创建服务器串行队列：校验-保存非原子，并发同 customId 会互相覆盖（M4），整段串行避免 last-writer-wins */
    private createQueue: Promise<unknown> = Promise.resolve();

    /** 连接/刷新抽离服务所共享的依赖（供 mcpConnection / mcpListRefresh 使用） */
    private readonly connectionDeps: McpConnectionDeps;

    constructor(storageAdapter: McpStorageAdapter) {
        this.storageAdapter = storageAdapter;

        // 构建连接/刷新服务共享依赖：通过箭头函数绑定私有方法，避免把私有状态暴露给
        // 抽离模块；Map 以引用共享，保证连接代际/刷新链与 McpManager 状态始终一致。
        const deps: McpConnectionDeps = {
            clients: this.clients,
            refreshChains: this.refreshChains,
            refreshPending: this.refreshPending,
            isCurrentGeneration: (serverId, generation) => this.isCurrentGeneration(serverId, generation),
            updateServerStatus: (serverId, status) => this.updateServerStatus(serverId, status),
            emitEvent: (event) => this.emitEvent(event),
            handleServerNotification: (info, client, generation, method, params) =>
                handleServerNotification(deps, info, client, generation, method, params)
        };
        this.connectionDeps = deps;
    }

    /** 将创建操作加入串行队列（前一个完成后再执行下一个，错误不阻断后续） */
    private enqueueCreate<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.createQueue.then(fn);
        this.createQueue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
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
            // storage 直载路径校验（encodeMcpToolName 的调用面在 channel/tools 模块）：
            // 手动编辑的配置文件可能含非法 serverId（含连续 __ 等），直接纳入会让下游
            // encodeMcpToolName 抛错、工具声明重建整体失败。不合法则跳过并告警，
            // 不污染服务器集合（调用面 fail-soft 双保险见 ToolDeclarationResolver）。
            if (typeof serverId !== 'string' || !MCP_SERVER_ID_PATTERN.test(serverId)) {
                console.warn(
                    `[MCP] Skipping server "${serverId}" from storage: invalid serverId ` +
                    `(must match ${MCP_SERVER_ID_PATTERN.source})`
                );
                continue;
            }
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

        // 统一清空全部状态 map：dispose 后实例不再持有任何连接/代际/刷新链残留
        this.servers.clear();
        this.clients.clear();
        this.connectPromises.clear();
        this.refreshChains.clear();
        this.refreshPending.clear();
        this.connectGenerations.clear();
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
        // 校验-生成-保存非原子：并发同 customId 会互相通过校验、后者覆盖前者（last-writer-wins，M4）。
        // 整段串行化后，后到的并发调用在前者保存完成后再校验，能发现 id 已存在并明确报错。
        return this.enqueueCreate(async () => {
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
                // 异步连接，不阻塞创建流程；失败至少记录（serverId 与原因可观测）
                this.connect(config.id).catch(e => {
                    console.warn(`[MCP] Auto-connect failed for ${config.id} after create:`, e);
                });
            }
            
            return config.id;
        });
    }

    /**
     * 生成可读的服务器 ID：优先基于名称生成 slug，冲突或无法生成时回退随机 ID
     */
    private async generateReadableId(name: string): Promise<string> {
        const slug = slugifyServerName(name);
        if (slug) {
            // 一次读全量配置建内存查重集合：避免循环内逐次全量读存储（C-16）
            const existingIds = new Set((await this.storageAdapter.getAllConfigs()).map(c => c.id));
            if (!existingIds.has(slug)) {
                return slug;
            }
            // slug 被占用时追加数字后缀（_2、_3 …），最多尝试 100 次
            for (let i = 2; i <= 100; i++) {
                const candidate = `${slug}_${i}`;
                if (!existingIds.has(candidate)) {
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
            // this.servers 未命中：回退查存储——reloadFromStorage 跳过的非法 serverId 配置
            // 仍留在存储中（listServers 直读存储仍显示），直接抛 serverNotFound 会使其成为
            // 不可更新的孤儿配置。存储中存在则允许覆盖保存（不重建运行时连接）。
            const storedConfig = await this.storageAdapter.getConfig(serverId);
            if (!storedConfig) {
                throw new Error(t('modules.mcp.errors.serverNotFound', { serverId }));
            }
            const updatedConfig: McpServerConfig = {
                ...storedConfig,
                ...updates,
                updatedAt: Date.now()
            };
            await this.storageAdapter.saveConfig(updatedConfig);
            // serverId 合法时纳入运行时集合（保持后续操作一致）；非法 serverId 维持由
            // reloadFromStorage 跳过，避免把非法 id 引入 servers 集合（下游 encode 校验）。
            if (typeof serverId === 'string' && MCP_SERVER_ID_PATTERN.test(serverId)) {
                this.servers.set(serverId, {
                    config: updatedConfig,
                    status: 'disconnected'
                });
            }
            return;
        }

        const previousTransport = info.config.transport;
        const updatedConfig: McpServerConfig = {
            ...info.config,
            ...updates,
            updatedAt: Date.now()
        };

        await this.storageAdapter.saveConfig(updatedConfig);
        info.config = updatedConfig;

        // transport 实质变化（type/命令/参数/URL/请求头/env 等连接参数变更）时，已连接/连接中的
        // 客户端仍按旧参数运行：需按新配置重连，否则新 transport 不生效（旧连接继续服务）。
        // error 状态（旧参数连接失败/服务器死亡）同样需按新配置重连，否则修改配置后服务器
        // 永远停留在 error 状态。仅比较关键连接字段而非 JSON.stringify 整串：键序变化
        //（env/headers）会误判为变化触发无谓重连，连续两次相同 updateServer 也会双重连。
        // 异步重连，不阻塞配置保存返回（与 initialize 自动连接同口径；失败仅记日志，状态由事件感知）。
        if (transportConfigChanged(previousTransport, updatedConfig.transport)
            && (info.status === 'connected' || info.status === 'connecting' || info.status === 'error')) {
            this.reconnect(serverId).catch(e => {
                console.error(`[MCP] Reconnect after updateServer failed for ${serverId}:`, e);
            });
        }
    }

    /**
     * 删除服务器配置
     */
    async deleteServer(serverId: string): Promise<void> {
        const info = this.servers.get(serverId);
        if (!info) {
            // this.servers 未命中：回退查存储——reloadFromStorage 跳过的非法 serverId 配置
            // 仍留在存储中（listServers 直读存储仍显示），直接抛 serverNotFound 会使其成为
            // 不可删除的孤儿配置。存储中存在则允许删除配置本身（无运行时状态可清理）。
            const storedConfig = await this.storageAdapter.getConfig(serverId);
            if (!storedConfig) {
                throw new Error(t('modules.mcp.errors.serverNotFound', { serverId }));
            }
            await this.storageAdapter.deleteConfig(serverId);
            return;
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
        // 只读目标服务器配置（支持手动编辑配置文件的情况）：
        // 不再全量 reloadFromStorage（多服务器时避免每次连接都枚举全部配置）
        const storedConfig = await this.storageAdapter.getConfig(serverId);
        if (storedConfig) {
            // storage 直载路径校验（同 reloadFromStorage）：手动编辑的配置文件可能含非法
            // serverId（含连续 __ 等），直接纳入会让下游 encodeMcpToolName 抛错。
            // 不合法则拒绝本次连接并告警，不污染服务器集合。
            if (typeof serverId !== 'string' || !MCP_SERVER_ID_PATTERN.test(serverId)) {
                console.warn(
                    `[MCP] Rejecting connect for "${serverId}": invalid serverId ` +
                    `(must match ${MCP_SERVER_ID_PATTERN.source})`
                );
                throw new Error(t('modules.mcp.errors.invalidServerId'));
            }
            const existing = this.servers.get(serverId);
            if (existing) {
                existing.config = storedConfig;
            } else {
                this.servers.set(serverId, { config: storedConfig, status: 'disconnected' });
            }
        }

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

        const promise = runConnect(this.connectionDeps, serverId, info, generation);
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
            await performDisconnect(this.connectionDeps, info);
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
            const result = await performToolCall(this.clients, info, request);
            
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

        return await performResourceRead(this.clients, info, request);
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

        return await performPromptGet(this.clients, info, request);
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



}