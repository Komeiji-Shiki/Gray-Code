/**
 * LimCode - MCP 处理器
 *
 * 负责处理 MCP 相关的所有请求
 */

import { t } from '../../../i18n';
import type { McpManager } from '../../mcp/McpManager';
import type { McpServerConfig, CreateMcpServerInput } from '../../mcp/types';
import type {
    GetAllMcpServersRequest,
    GetAllMcpServersResponse,
    GetMcpServerRequest,
    GetMcpServerResponse,
    CreateMcpServerRequest,
    CreateMcpServerResponse,
    UpdateMcpServerRequest,
    UpdateMcpServerResponse,
    DeleteMcpServerRequest,
    DeleteMcpServerResponse,
    SetMcpServerEnabledRequest,
    ConnectMcpServerRequest,
    DisconnectMcpServerRequest,
    McpConnectionResponse
} from './types';

/**
 * MCP 处理器
 * 
 * 职责：
 * 1. 管理 MCP 服务器配置的 CRUD 操作
 * 2. 处理连接/断开操作
 * 3. 提供 JSON 格式配置编辑功能
 */
export class McpHandler {
    constructor(
        private mcpManager: McpManager
    ) {}

    /**
     * 获取所有 MCP 服务器
     */
    async getAllServers(request: GetAllMcpServersRequest): Promise<GetAllMcpServersResponse> {
        try {
            const servers = await this.mcpManager.listServers();
            
            return {
                success: true,
                servers
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.mcp.errors.listServersFailed')
                }
            };
        }
    }

    /**
     * 获取单个 MCP 服务器
     */
    async getServer(request: GetMcpServerRequest): Promise<GetMcpServerResponse> {
        try {
            const server = await this.mcpManager.getServerInfo(request.serverId);
            
            if (!server) {
                return {
                    success: false,
                    error: {
                        code: 'SERVER_NOT_FOUND',
                        message: t('modules.api.mcp.errors.serverNotFound', { serverId: request.serverId })
                    }
                };
            }
            
            return {
                success: true,
                server
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.mcp.errors.getServerFailed')
                }
            };
        }
    }

    /**
     * 创建 MCP 服务器
     */
    async createServer(request: CreateMcpServerRequest): Promise<CreateMcpServerResponse> {
        try {
            const serverId = await this.mcpManager.createServer(request.input);
            const server = await this.mcpManager.getServerInfo(serverId);
            // 并发删除窗口内 create 后可能查不到：null 返回明确的 SERVER_NOT_FOUND，而非 success:true 泄漏
            if (!server) {
                return {
                    success: false,
                    error: {
                        code: 'SERVER_NOT_FOUND',
                        message: t('modules.api.mcp.errors.serverNotFound', { serverId }),
                    },
                };
            }
            
            return {
                success: true,
                serverId,
                server
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.mcp.errors.createServerFailed')
                }
            };
        }
    }

    /**
     * 更新 MCP 服务器
     */
    async updateServer(request: UpdateMcpServerRequest): Promise<UpdateMcpServerResponse> {
        try {
            await this.mcpManager.updateServer(request.serverId, request.updates);
            const server = await this.mcpManager.getServerInfo(request.serverId);
            if (!server) {
                return {
                    success: false,
                    error: {
                        code: 'SERVER_NOT_FOUND',
                        message: t('modules.api.mcp.errors.serverNotFound', { serverId: request.serverId }),
                    },
                };
            }
            
            return {
                success: true,
                server
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.mcp.errors.updateServerFailed')
                }
            };
        }
    }

    /**
     * 删除 MCP 服务器
     */
    async deleteServer(request: DeleteMcpServerRequest): Promise<DeleteMcpServerResponse> {
        try {
            await this.mcpManager.deleteServer(request.serverId);
            
            return {
                success: true
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.mcp.errors.deleteServerFailed')
                }
            };
        }
    }

    /**
     * 设置 MCP 服务器启用状态
     */
    async setServerEnabled(request: SetMcpServerEnabledRequest): Promise<UpdateMcpServerResponse> {
        try {
            await this.mcpManager.setServerEnabled(request.serverId, request.enabled);
            const server = await this.mcpManager.getServerInfo(request.serverId);
            if (!server) {
                return {
                    success: false,
                    error: {
                        code: 'SERVER_NOT_FOUND',
                        message: t('modules.api.mcp.errors.serverNotFound', { serverId: request.serverId }),
                    },
                };
            }
            
            return {
                success: true,
                server
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.mcp.errors.setServerStatusFailed')
                }
            };
        }
    }

    /**
     * 连接 MCP 服务器
     */
    async connectServer(request: ConnectMcpServerRequest): Promise<McpConnectionResponse> {
        try {
            await this.mcpManager.connect(request.serverId);
            const status = this.mcpManager.getServerStatus(request.serverId);
            if (!status) {
                return {
                    success: false,
                    error: {
                        code: 'SERVER_NOT_FOUND',
                        message: t('modules.api.mcp.errors.serverNotFound', { serverId: request.serverId }),
                    },
                };
            }
            
            return {
                success: true,
                status
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'CONNECTION_ERROR',
                    message: err.message || t('modules.api.mcp.errors.connectServerFailed')
                }
            };
        }
    }

    /**
     * 断开 MCP 服务器
     */
    async disconnectServer(request: DisconnectMcpServerRequest): Promise<McpConnectionResponse> {
        try {
            await this.mcpManager.disconnect(request.serverId);
            const status = this.mcpManager.getServerStatus(request.serverId);
            if (!status) {
                return {
                    success: false,
                    error: {
                        code: 'SERVER_NOT_FOUND',
                        message: t('modules.api.mcp.errors.serverNotFound', { serverId: request.serverId }),
                    },
                };
            }
            
            return {
                success: true,
                status
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'DISCONNECTION_ERROR',
                    message: err.message || t('modules.api.mcp.errors.disconnectServerFailed')
                }
            };
        }
    }

    /**
     * 获取默认配置模板
     */
    static getDefaultConfigTemplate(): string {
        const defaultConfig = [
            {
                name: 'Example MCP Server',
                description: 'An example MCP server configuration',
                transport: {
                    type: 'stdio',
                    command: 'npx',
                    args: ['-y', '@example/mcp-server']
                },
                enabled: false,
                autoConnect: false,
                timeout: 30000
            }
        ];
        return JSON.stringify(defaultConfig, null, 2);
    }
}