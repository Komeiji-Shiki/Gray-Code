/**
 * LimCode - 渠道配置处理器
 *
 * 负责处理渠道配置相关的所有请求
 */

import { t } from '../../../i18n';
import type { ConfigManager } from '../../config/ConfigManager';
import type {
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
    SetChannelEnabledRequest
} from './types';

/**
 * 渠道配置处理器
 * 
 * 职责：
 * 1. 管理渠道配置的 CRUD 操作
 * 2. 验证渠道配置
 * 3. 处理渠道启用/禁用
 */
export class ChannelHandler {
    constructor(
        private configManager: ConfigManager
    ) {}
    
    /**
     * 获取所有渠道配置
     */
    async getAllChannels(request: GetAllChannelsRequest): Promise<GetAllChannelsResponse> {
        try {
            const channels = await this.configManager.listConfigs();
            
            return {
                success: true,
                channels
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.channel.errors.listChannelsFailed')
                }
            };
        }
    }
    
    /**
     * 获取单个渠道配置
     */
    async getChannel(request: GetChannelRequest): Promise<GetChannelResponse> {
        try {
            const channel = await this.configManager.getConfig(request.channelId);
            
            if (!channel) {
                return {
                    success: false,
                    error: {
                        code: 'CHANNEL_NOT_FOUND',
                        message: t('modules.api.channel.errors.channelNotFound', { channelId: request.channelId })
                    }
                };
            }
            
            return {
                success: true,
                channel
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.channel.errors.getChannelFailed')
                }
            };
        }
    }
    
    /**
     * 创建渠道配置
     */
    async createChannel(request: CreateChannelRequest): Promise<CreateChannelResponse> {
        try {
            // 验证配置 ID 是否已存在
            const existing = await this.configManager.getConfig(request.config.id);
            if (existing) {
                return {
                    success: false,
                    error: {
                        code: 'CHANNEL_ALREADY_EXISTS',
                        message: t('modules.api.channel.errors.channelAlreadyExists', { channelId: request.config.id })
                    }
                };
            }
            
            // 创建配置：透传客户端传入的 id（契约上 id 允许由客户端指定；未传时由 createConfig 内部生成）
            const { id, createdAt, updatedAt, ...createInput } = request.config;
            const newId = await this.configManager.createConfig(createInput, id);
            
            // 获取创建后的配置（并发删除窗口内可能查不到：判空返回明确错误）
            const channel = await this.configManager.getConfig(newId);
            if (!channel) {
                return {
                    success: false,
                    error: {
                        code: 'CHANNEL_NOT_FOUND',
                        message: t('modules.api.channel.errors.channelNotFound', { channelId: newId }),
                    },
                };
            }
            
            return {
                success: true,
                channel
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.channel.errors.createChannelFailed')
                }
            };
        }
    }
    
    /**
     * 更新渠道配置
     */
    async updateChannel(request: UpdateChannelRequest): Promise<UpdateChannelResponse> {
        try {
            // 验证配置是否存在
            const existing = await this.configManager.getConfig(request.channelId);
            if (!existing) {
                return {
                    success: false,
                    error: {
                        code: 'CHANNEL_NOT_FOUND',
                        message: t('modules.api.channel.errors.channelNotFound', { channelId: request.channelId })
                    }
                };
            }
            
            // 更新配置（返回更新后的配置，直接消费，无需再读一次）
            const channel = await this.configManager.updateConfig(request.channelId, request.updates);
            
            return {
                success: true,
                channel
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.channel.errors.updateChannelFailed')
                }
            };
        }
    }
    
    /**
     * 删除渠道配置
     */
    async deleteChannel(request: DeleteChannelRequest): Promise<DeleteChannelResponse> {
        try {
            // 验证配置是否存在
            const existing = await this.configManager.getConfig(request.channelId);
            if (!existing) {
                return {
                    success: false,
                    error: {
                        code: 'CHANNEL_NOT_FOUND',
                        message: t('modules.api.channel.errors.channelNotFound', { channelId: request.channelId })
                    }
                };
            }
            
            // 删除配置
            await this.configManager.deleteConfig(request.channelId);
            
            return {
                success: true
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.channel.errors.deleteChannelFailed')
                }
            };
        }
    }
    
    /**
     * 启用/禁用渠道
     */
    async setChannelEnabled(request: SetChannelEnabledRequest): Promise<UpdateChannelResponse> {
        try {
            // 验证配置是否存在
            const existing = await this.configManager.getConfig(request.channelId);
            if (!existing) {
                return {
                    success: false,
                    error: {
                        code: 'CHANNEL_NOT_FOUND',
                        message: t('modules.api.channel.errors.channelNotFound', { channelId: request.channelId })
                    }
                };
            }
            
            // 更新启用状态（返回更新后的配置，直接消费，无需再读一次）
            const channel = await this.configManager.updateConfig(request.channelId, {
                enabled: request.enabled
            });
            
            return {
                success: true,
                channel
            };
        } catch (error) {
            const err = error as any;
            return {
                success: false,
                error: {
                    code: err.code || 'UNKNOWN_ERROR',
                    message: err.message || t('modules.api.channel.errors.setChannelStatusFailed')
                }
            };
        }
    }
}