/**
 * 模型管理 API 处理器
 */

import { t } from '../../../i18n';
import type { ConfigManager } from '../../config/ConfigManager';
import type { SettingsManager } from '../../settings/SettingsManager';
import { getModels, type ModelInfo } from '../../channel/modelList';
import type {
    GetModelsRequest,
    GetModelsResponse,
    AddModelsRequest,
    AddModelsResponse,
    RemoveModelRequest,
    RemoveModelResponse,
    SetActiveModelRequest,
    SetActiveModelResponse
} from './types';

export class ModelsHandler {
    constructor(
        private configManager: ConfigManager,
        private settingsManager: SettingsManager
    ) {}

    /**
     * 获取可用模型列表（从API）
     */
    async getModels(request: GetModelsRequest): Promise<GetModelsResponse> {
        try {
            const config = await this.configManager.getConfig(request.configId);
            if (!config) {
                return {
                    success: false,
                    error: t('modules.api.models.errors.configNotFound')
                };
            }

            const proxyUrl = this.settingsManager.getEffectiveProxyUrl();
            const models = await getModels(config, proxyUrl);
            
            return {
                success: true,
                models
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || t('modules.api.models.errors.getModelsFailed')
            };
        }
    }

    /**
     * 添加模型到配置
     */
    async addModels(request: AddModelsRequest): Promise<AddModelsResponse> {
        try {
            const config = await this.configManager.getConfig(request.configId);
            if (!config) {
                return {
                    success: false,
                    error: t('modules.api.models.errors.configNotFound')
                };
            }

            // 获取现有模型列表
            const existingModels = (config as any).models || [];
            const existingIds = new Set(existingModels.map((m: ModelInfo) => m.id));

            // 去重：只添加不存在的模型
            const newModels = request.models.filter(m => !existingIds.has(m.id));
            const updatedModels = [...existingModels, ...newModels];

            // 更新配置
            await this.configManager.updateConfig(request.configId, {
                models: updatedModels
            } as any);

            return {
                success: true
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || t('modules.api.models.errors.addModelsFailed')
            };
        }
    }

    /**
     * 从配置移除模型
     */
    async removeModel(request: RemoveModelRequest): Promise<RemoveModelResponse> {
        try {
            const config = await this.configManager.getConfig(request.configId);
            if (!config) {
                return {
                    success: false,
                    error: t('modules.api.models.errors.configNotFound')
                };
            }

            // 获取现有模型列表
            const existingModels = (config as any).models || [];
            const updatedModels = existingModels.filter((m: ModelInfo) => m.id !== request.modelId);

            // 如果移除的是当前模型，清空（允许删除正在使用的模型）
            let updates: any = {
                models: updatedModels
            };

            if ((config as any).model === request.modelId) {
                // 清空当前模型，不自动选择其他模型
                updates.model = '';
            }

            // 更新配置
            await this.configManager.updateConfig(request.configId, updates);

            return {
                success: true
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || t('modules.api.models.errors.removeModelFailed')
            };
        }
    }

    /**
     * 设置当前激活模型
     */
    async setActiveModel(request: SetActiveModelRequest): Promise<SetActiveModelResponse> {
        try {
            const config = await this.configManager.getConfig(request.configId);
            if (!config) {
                return {
                    success: false,
                    error: t('modules.api.models.errors.configNotFound')
                };
            }

            // 验证模型是否在列表中
            const models = (config as any).models || [];
            const modelExists = models.some((m: ModelInfo) => m.id === request.modelId);

            if (!modelExists && request.modelId !== '') {
                return {
                    success: false,
                    error: t('modules.api.models.errors.modelNotInList')
                };
            }

            // 更新配置
            await this.configManager.updateConfig(request.configId, {
                model: request.modelId
            } as any);

            return {
                success: true
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || t('modules.api.models.errors.setActiveModelFailed')
            };
        }
    }
}