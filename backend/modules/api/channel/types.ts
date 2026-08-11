/**
 * GrayCode - 渠道配置 API 类型定义
 * 
 * 前后端交互的渠道配置相关数据结构
 */

import type { ChannelConfig } from '../../config/types';

/**
 * ========== 请求类型 ==========
 */

/**
 * 获取所有渠道配置请求（无需参数）
 */
export interface GetAllChannelsRequest {
    // 空对象，仅用于类型标记
}

/**
 * 获取单个渠道配置请求
 */
export interface GetChannelRequest {
    /** 渠道 ID */
    channelId: string;
}

/**
 * 创建渠道配置请求
 */
export interface CreateChannelRequest {
    /** 渠道配置 */
    config: ChannelConfig;
}

/**
 * 更新渠道配置请求
 */
export interface UpdateChannelRequest {
    /** 渠道 ID */
    channelId: string;
    
    /** 要更新的配置（部分更新） */
    updates: Partial<ChannelConfig>;
}

/**
 * 删除渠道配置请求
 */
export interface DeleteChannelRequest {
    /** 渠道 ID */
    channelId: string;
}

/**
 * 启用/禁用渠道请求
 */
export interface SetChannelEnabledRequest {
    /** 渠道 ID */
    channelId: string;
    
    /** 是否启用 */
    enabled: boolean;
}

/**
 * ========== 响应类型 ==========
 */

/**
 * 获取所有渠道配置成功响应
 */
export interface GetAllChannelsSuccessData {
    success: true;
    
    /** 所有渠道配置 */
    channels: ChannelConfig[];
}

/**
 * 获取所有渠道配置失败响应
 */
export interface GetAllChannelsErrorData {
    success: false;
    
    /** 错误信息 */
    error: {
        code: string;
        message: string;
    };
}

/**
 * 获取所有渠道配置响应
 */
export type GetAllChannelsResponse = GetAllChannelsSuccessData | GetAllChannelsErrorData;

/**
 * 获取单个渠道配置成功响应
 */
export interface GetChannelSuccessData {
    success: true;
    
    /** 渠道配置 */
    channel: ChannelConfig;
}

/**
 * 获取单个渠道配置失败响应
 */
export interface GetChannelErrorData {
    success: false;
    
    /** 错误信息 */
    error: {
        code: string;
        message: string;
    };
}

/**
 * 获取单个渠道配置响应
 */
export type GetChannelResponse = GetChannelSuccessData | GetChannelErrorData;

/**
 * 创建渠道配置成功响应
 */
export interface CreateChannelSuccessData {
    success: true;
    
    /** 创建的渠道配置 */
    channel: ChannelConfig;
}

/**
 * 创建渠道配置失败响应
 */
export interface CreateChannelErrorData {
    success: false;
    
    /** 错误信息 */
    error: {
        code: string;
        message: string;
    };
}

/**
 * 创建渠道配置响应
 */
export type CreateChannelResponse = CreateChannelSuccessData | CreateChannelErrorData;

/**
 * 更新渠道配置成功响应
 */
export interface UpdateChannelSuccessData {
    success: true;
    
    /** 更新后的渠道配置 */
    channel: ChannelConfig;
}

/**
 * 更新渠道配置失败响应
 */
export interface UpdateChannelErrorData {
    success: false;
    
    /** 错误信息 */
    error: {
        code: string;
        message: string;
    };
}

/**
 * 更新渠道配置响应
 */
export type UpdateChannelResponse = UpdateChannelSuccessData | UpdateChannelErrorData;

/**
 * 删除渠道配置成功响应
 */
export interface DeleteChannelSuccessData {
    success: true;
}

/**
 * 删除渠道配置失败响应
 */
export interface DeleteChannelErrorData {
    success: false;
    
    /** 错误信息 */
    error: {
        code: string;
        message: string;
    };
}

/**
 * 删除渠道配置响应
 */
export type DeleteChannelResponse = DeleteChannelSuccessData | DeleteChannelErrorData;

/**
 * 渠道配置变更通知数据
 * 
 * 用于实时推送渠道配置变更到前端
 */
export interface ChannelChangeNotification {
    /** 通知类型 */
    type: 'channelChanged';
    
    /** 变更类型 */
    changeType: 'created' | 'updated' | 'deleted';
    
    /** 渠道 ID */
    channelId: string;
    
    /** 变更后的配置（删除时为 undefined） */
    channel?: ChannelConfig;
}