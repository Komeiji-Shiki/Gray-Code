/**
 * GrayCode - MCP API 类型定义
 * 
 * 前后端交互的 MCP 配置相关数据结构
 */

import type {
    McpServerConfig,
    McpServerInfo,
    McpServerStatus,
    CreateMcpServerInput,
    UpdateMcpServerInput
} from '../../mcp/types';

/**
 * ========== 请求类型 ==========
 */

/**
 * 获取所有 MCP 服务器请求
 */
export interface GetAllMcpServersRequest {
    // 空对象
}

/**
 * 获取单个 MCP 服务器请求
 */
export interface GetMcpServerRequest {
    /** 服务器 ID */
    serverId: string;
}

/**
 * 创建 MCP 服务器请求
 */
export interface CreateMcpServerRequest {
    /** 服务器配置输入 */
    input: CreateMcpServerInput;
}

/**
 * 更新 MCP 服务器请求
 */
export interface UpdateMcpServerRequest {
    /** 服务器 ID */
    serverId: string;
    
    /** 要更新的字段 */
    updates: UpdateMcpServerInput;
}

/**
 * 删除 MCP 服务器请求
 */
export interface DeleteMcpServerRequest {
    /** 服务器 ID */
    serverId: string;
}

/**
 * 设置 MCP 服务器启用状态请求
 */
export interface SetMcpServerEnabledRequest {
    /** 服务器 ID */
    serverId: string;
    
    /** 是否启用 */
    enabled: boolean;
}

/**
 * 连接 MCP 服务器请求
 */
export interface ConnectMcpServerRequest {
    /** 服务器 ID */
    serverId: string;
}

/**
 * 断开 MCP 服务器请求
 */
export interface DisconnectMcpServerRequest {
    /** 服务器 ID */
    serverId: string;
}

/**
 * 打开 MCP 配置文件请求
 */
export interface OpenMcpConfigFileRequest {
    // 空对象
}

/**
 * ========== 响应类型 ==========
 */

/**
 * 通用错误信息
 */
export interface McpApiError {
    code: string;
    message: string;
}

/**
 * 获取所有 MCP 服务器成功响应
 */
export interface GetAllMcpServersSuccessData {
    success: true;
    
    /** 所有服务器运行时信息 */
    servers: McpServerInfo[];
}

/**
 * 获取所有 MCP 服务器失败响应
 */
export interface GetAllMcpServersErrorData {
    success: false;
    error: McpApiError;
}

export type GetAllMcpServersResponse = GetAllMcpServersSuccessData | GetAllMcpServersErrorData;

/**
 * 获取单个 MCP 服务器成功响应
 */
export interface GetMcpServerSuccessData {
    success: true;
    
    /** 服务器运行时信息 */
    server: McpServerInfo;
}

/**
 * 获取单个 MCP 服务器失败响应
 */
export interface GetMcpServerErrorData {
    success: false;
    error: McpApiError;
}

export type GetMcpServerResponse = GetMcpServerSuccessData | GetMcpServerErrorData;

/**
 * 创建 MCP 服务器成功响应
 */
export interface CreateMcpServerSuccessData {
    success: true;
    
    /** 创建的服务器 ID */
    serverId: string;
    
    /** 服务器运行时信息 */
    server: McpServerInfo;
}

/**
 * 创建 MCP 服务器失败响应
 */
export interface CreateMcpServerErrorData {
    success: false;
    error: McpApiError;
}

export type CreateMcpServerResponse = CreateMcpServerSuccessData | CreateMcpServerErrorData;

/**
 * 更新 MCP 服务器成功响应
 */
export interface UpdateMcpServerSuccessData {
    success: true;
    
    /** 更新后的服务器运行时信息 */
    server: McpServerInfo;
}

/**
 * 更新 MCP 服务器失败响应
 */
export interface UpdateMcpServerErrorData {
    success: false;
    error: McpApiError;
}

export type UpdateMcpServerResponse = UpdateMcpServerSuccessData | UpdateMcpServerErrorData;

/**
 * 删除 MCP 服务器成功响应
 */
export interface DeleteMcpServerSuccessData {
    success: true;
}

/**
 * 删除 MCP 服务器失败响应
 */
export interface DeleteMcpServerErrorData {
    success: false;
    error: McpApiError;
}

export type DeleteMcpServerResponse = DeleteMcpServerSuccessData | DeleteMcpServerErrorData;

/**
 * 连接/断开 MCP 服务器成功响应
 */
export interface McpConnectionSuccessData {
    success: true;
    
    /** 当前状态 */
    status: McpServerStatus;
}

/**
 * 连接/断开 MCP 服务器失败响应
 */
export interface McpConnectionErrorData {
    success: false;
    error: McpApiError;
}

export type McpConnectionResponse = McpConnectionSuccessData | McpConnectionErrorData;

/**
 * 打开 MCP 配置文件成功响应
 */
export interface OpenMcpConfigFileSuccessData {
    success: true;
    
    /** 配置文件路径 */
    filePath: string;
}

/**
 * 打开 MCP 配置文件失败响应
 */
export interface OpenMcpConfigFileErrorData {
    success: false;
    error: McpApiError;
}

export type OpenMcpConfigFileResponse = OpenMcpConfigFileSuccessData | OpenMcpConfigFileErrorData;

/**
 * MCP 服务器变更通知
 */
export interface McpServerChangeNotification {
    type: 'mcpServerChanged';
    
    /** 变更类型 */
    changeType: 'created' | 'updated' | 'deleted' | 'connected' | 'disconnected' | 'error';
    
    /** 服务器 ID */
    serverId: string;
    
    /** 服务器信息（删除时为 undefined） */
    server?: McpServerInfo;
}