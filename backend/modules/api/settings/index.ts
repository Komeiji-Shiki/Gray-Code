/**
 * GrayCode - 设置 API 模块
 * 
 * 导出设置相关的所有接口和实现
 */

export { SettingsHandler } from './SettingsHandler';
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
} from './types';