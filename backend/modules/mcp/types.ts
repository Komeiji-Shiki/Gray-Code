/**
 * GrayCode MCP (Model Context Protocol) 模块 - 类型定义
 * 
 * MCP 是一个标准协议，允许 LLM 与外部工具和服务进行交互。
 */

/**
 * MCP 服务器传输类型
 */
export type McpTransportType = 'stdio' | 'sse' | 'streamable-http';

/**
 * MCP 服务器状态
 */
export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Stdio 传输配置
 */
export interface StdioTransportConfig {
    type: 'stdio';
    /** 命令行可执行文件 */
    command: string;
    /** 命令行参数 */
    args?: string[];
    /** 环境变量 */
    env?: Record<string, string>;
}

/**
 * SSE 传输配置
 *
 * 注意：经典 SSE 传输（GET /sse 端点 + 独立事件流）实际未实现——'sse' 类型仅为
 * 兼容旧配置保留，HttpMcpClient 按 streamable-http 语义统一处理（POST 请求 +
 * SSE 响应流）。新建配置请使用 streamable-http。
 */
export interface SseTransportConfig {
    type: 'sse';
    /** SSE 服务器 URL */
    url: string;
    /** 请求头 */
    headers?: Record<string, string>;
}

/**
 * Streamable HTTP 传输配置
 */
export interface StreamableHttpTransportConfig {
    type: 'streamable-http';
    /** HTTP 服务器 URL */
    url: string;
    /** 请求头 */
    headers?: Record<string, string>;
}

/**
 * MCP 传输配置（联合类型）
 */
export type McpTransportConfig = StdioTransportConfig | SseTransportConfig | StreamableHttpTransportConfig;

/**
 * MCP 服务器配置
 */
export interface McpServerConfig {
    /** 配置唯一标识 */
    id: string;
    /** 服务器名称（用户可读） */
    name: string;
    /** 服务器描述 */
    description?: string;
    /** 传输配置 */
    transport: McpTransportConfig;
    /** 是否启用 */
    enabled: boolean;
    /** 是否自动连接 */
    autoConnect: boolean;
    /** 连接超时（毫秒） */
    timeout?: number;
    /**
     * 是否清理 JSON Schema
     *
     * 如果为 true，会移除 JSON Schema 中不兼容的字段（如 $schema, additionalProperties）
     * 某些 API（如 Gemini）不支持这些字段
     *
     * 默认为 true
     */
    cleanSchema?: boolean;
    /** 创建时间 */
    createdAt: number;
    /** 更新时间 */
    updatedAt: number;
}

/**
 * MCP 服务器配置输入（创建时使用）
 */
export type CreateMcpServerInput = Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * MCP 服务器配置更新输入
 */
export type UpdateMcpServerInput = Partial<Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>>;

/**
 * MCP 工具定义
 */
export interface McpToolDefinition {
    /** 工具名称 */
    name: string;
    /** 工具描述 */
    description?: string;
    /** 输入参数的 JSON Schema */
    inputSchema: {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
        [key: string]: unknown;
    };
}

/**
 * MCP 资源定义
 */
export interface McpResourceDefinition {
    /** 资源 URI */
    uri: string;
    /** 资源名称 */
    name: string;
    /** 资源描述 */
    description?: string;
    /** MIME 类型 */
    mimeType?: string;
}

/**
 * MCP 提示模板定义
 */
export interface McpPromptDefinition {
    /** 提示名称 */
    name: string;
    /** 提示描述 */
    description?: string;
    /** 参数定义 */
    arguments?: Array<{
        name: string;
        description?: string;
        required?: boolean;
    }>;
}

/**
 * MCP 服务器能力
 */
export interface McpServerCapabilities {
    /** 支持的工具列表 */
    tools?: McpToolDefinition[];
    /** 支持的资源列表 */
    resources?: McpResourceDefinition[];
    /** 支持的提示模板列表 */
    prompts?: McpPromptDefinition[];
    /** 是否支持采样 */
    sampling?: boolean;
    /** 是否支持日志 */
    logging?: boolean;
}

/**
 * MCP 服务器运行时信息
 */
export interface McpServerInfo {
    /** 配置 */
    config: McpServerConfig;
    /** 当前状态 */
    status: McpServerStatus;
    /** 服务器能力（连接后获取） */
    capabilities?: McpServerCapabilities;
    /** 协议版本 */
    protocolVersion?: string;
    /** 服务器版本 */
    serverVersion?: string;
    /** 服务器描述（来自服务器） */
    serverDescription?: string;
    /** 最后错误信息 */
    lastError?: string;
    /** 连接时间 */
    connectedAt?: number;
}

/**
 * MCP 工具调用请求
 */
export interface McpToolCallRequest {
    /** 服务器 ID */
    serverId: string;
    /** 工具名称 */
    toolName: string;
    /** 工具参数 */
    arguments: Record<string, unknown>;
    /** 外部取消信号（可选，透传给底层 client 的请求） */
    signal?: AbortSignal;
}

/**
 * MCP 工具调用结果
 */
export interface McpToolCallResult {
    /** 是否成功 */
    success: boolean;
    /** 结果内容 */
    content?: Array<{
        type: 'text' | 'image' | 'resource';
        text?: string;
        data?: string;
        mimeType?: string;
        uri?: string;
    }>;
    /** 错误信息 */
    error?: string;
    /** 是否为错误结果 */
    isError?: boolean;
}

/**
 * MCP 资源读取请求
 */
export interface McpResourceReadRequest {
    /** 服务器 ID */
    serverId: string;
    /** 资源 URI */
    uri: string;
    /** 外部取消信号（可选，透传给底层 client 的请求） */
    signal?: AbortSignal;
}

/**
 * MCP 资源内容
 */
export interface McpResourceContent {
    /** 资源 URI */
    uri: string;
    /** MIME 类型 */
    mimeType?: string;
    /** 文本内容 */
    text?: string;
    /** 二进制数据（Base64） */
    blob?: string;
}

/**
 * MCP 提示获取请求
 */
export interface McpPromptGetRequest {
    /** 服务器 ID */
    serverId: string;
    /** 提示名称 */
    promptName: string;
    /** 参数 */
    arguments?: Record<string, string>;
    /** 外部取消信号（可选，透传给底层 client 的请求） */
    signal?: AbortSignal;
}

/**
 * MCP 提示消息
 */
export interface McpPromptMessage {
    role: 'user' | 'assistant';
    content: {
        type: 'text' | 'image' | 'resource';
        text?: string;
        data?: string;
        mimeType?: string;
        uri?: string;
    };
}

/**
 * MCP 日志级别
 */
export type McpLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';

/**
 * MCP 日志条目
 */
export interface McpLogEntry {
    /** 服务器 ID */
    serverId: string;
    /** 日志级别 */
    level: McpLogLevel;
    /** 日志消息 */
    message: string;
    /** 日志数据 */
    data?: unknown;
    /** 时间戳 */
    timestamp: number;
}

/**
 * MCP 存储适配器接口
 */
export interface McpStorageAdapter {
    /** 获取所有服务器配置 */
    getAllConfigs(): Promise<McpServerConfig[]>;
    /** 保存服务器配置 */
    saveConfig(config: McpServerConfig): Promise<void>;
    /** 删除服务器配置 */
    deleteConfig(id: string): Promise<void>;
    /** 获取单个服务器配置 */
    getConfig(id: string): Promise<McpServerConfig | null>;
}

/**
 * MCP 事件类型
 */
export type McpEventType = 
    | 'server:connected'
    | 'server:disconnected'
    | 'server:error'
    | 'server:capabilities_updated'
    | 'tool:result'
    | 'resource:updated'
    | 'log:received';

/**
 * MCP 事件数据
 */
export interface McpEvent {
    type: McpEventType;
    serverId: string;
    data?: unknown;
    timestamp: number;
}

/**
 * MCP 事件监听器
 */
export type McpEventListener = (event: McpEvent) => void;