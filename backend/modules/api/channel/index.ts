/**
 * GrayCode - 渠道配置 API 模块
 * 
 * 导出渠道配置相关的所有接口和实现
 */

export { ChannelHandler } from './ChannelHandler';
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
} from './types';