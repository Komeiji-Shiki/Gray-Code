/**
 * GrayCode - API 模块导出
 * 
 * 统一导出前后端通信相关的所有类型和处理器
 */

// 对话模块
export { ChatHandler } from './chat';
export type {
    ChatRequestData,
    ChatSuccessData,
    ChatErrorData,
    ChatStreamChunkData,
    ChatStreamCompleteData,
    ChatStreamErrorData,
    RetryRequestData,
    EditAndRetryRequestData,
    DeleteToMessageRequestData,
    DeleteToMessageSuccessData,
    DeleteToMessageErrorData
} from './chat';

// Chat 服务（api/chat/services 子门面聚合导出）
export { CheckpointService } from './chat/services';

// 设置模块
export { SettingsHandler } from './settings';
export type {
    GetSettingsRequest,
    GetSettingsResponse,
    UpdateSettingsRequest,
    UpdateSettingsResponse,
    SetActiveChannelRequest,
    SetToolEnabledRequest,
    SetToolsEnabledRequest,
    SetDefaultToolModeRequest,
    UpdateUISettingsRequest,
    UpdateProxySettingsRequest,
    ResetSettingsRequest,
    SettingsChangeNotification,
    GetToolsListRequest,
    GetToolsListResponse,
    ToolInfo
} from './settings';

// 渠道配置模块
export { ChannelHandler } from './channel';
export type {
    GetAllChannelsRequest,
    GetAllChannelsResponse,
    GetChannelRequest,
    GetChannelResponse,
    CreateChannelRequest,
    CreateChannelResponse,
    UpdateChannelRequest,
    UpdateChannelResponse,
    DeleteChannelRequest,
    DeleteChannelResponse,
    SetChannelEnabledRequest,
    ChannelChangeNotification
} from './channel';

// 模型管理模块
export { ModelsHandler } from './models';
export type {
    GetModelsRequest,
    GetModelsResponse,
    AddModelsRequest,
    AddModelsResponse,
    RemoveModelRequest,
    RemoveModelResponse,
    SetActiveModelRequest,
    SetActiveModelResponse
} from './models';

// MCP 模块
export { McpHandler } from './mcp';
export type {
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
    McpConnectionResponse,
    OpenMcpConfigFileRequest,
    OpenMcpConfigFileResponse,
    McpServerChangeNotification,
    McpApiError
} from './mcp';