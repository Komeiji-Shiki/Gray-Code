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

/**
 * 统一错误响应结构（与其他 handler 的 {code, message} 契约一致）。
 */
function errorResponse(code: string, message: string): { success: false; error: { code: string; message: string } } {
    return {
        success: false,
        error: { code, message }
    };
}

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
                return errorResponse('CONFIG_NOT_FOUND', t('modules.api.models.errors.configNotFound'));
            }

            const proxyUrl = this.settingsManager.getEffectiveProxyUrl();
            const models = await getModels(config, proxyUrl);

            return {
                success: true,
                models
            };
        } catch (error: unknown) {
            return errorResponse(
                'GET_MODELS_FAILED',
                error instanceof Error ? error.message : t('modules.api.models.errors.getModelsFailed')
            );
        }
    }

    /**
     * 添加模型到配置
     */
    async addModels(request: AddModelsRequest): Promise<AddModelsResponse> {
        try {
            const config = await this.configManager.getConfig(request.configId);
            if (!config) {
                return errorResponse('CONFIG_NOT_FOUND', t('modules.api.models.errors.configNotFound'));
            }

            // 原子合并：基于最新缓存合并写回，避免 check-then-write 竞态；
            // 同时把 request.models 内部重复 id 去重（Set 语义）
            await this.configManager.updateModels(request.configId, (current) => {
                const existingIds = new Set(current.map(m => m.id));
                const seen = new Set<string>();
                const newModels: ModelInfo[] = [];
                for (const m of request.models) {
                    if (!existingIds.has(m.id) && !seen.has(m.id)) {
                        seen.add(m.id);
                        newModels.push(m);
                    }
                }
                return [...current, ...newModels];
            });

            return {
                success: true
            };
        } catch (error: unknown) {
            return errorResponse(
                'ADD_MODELS_FAILED',
                error instanceof Error ? error.message : t('modules.api.models.errors.addModelsFailed')
            );
        }
    }

    /**
     * 从配置移除模型
     */
    async removeModel(request: RemoveModelRequest): Promise<RemoveModelResponse> {
        try {
            const config = await this.configManager.getConfig(request.configId);
            if (!config) {
                return errorResponse('CONFIG_NOT_FOUND', t('modules.api.models.errors.configNotFound'));
            }

            // 原子移除（基于最新缓存）；如果移除的是当前激活模型，随后清空 model 字段
            const removedActive = config.models?.some(m => m.id === request.modelId)
                && config.model === request.modelId;

            await this.configManager.updateModels(request.configId, (current) =>
                current.filter(m => m.id !== request.modelId)
            );

            if (removedActive) {
                await this.configManager.updateConfig(request.configId, {
                    model: ''
                });
            }

            return {
                success: true
            };
        } catch (error: unknown) {
            return errorResponse(
                'REMOVE_MODEL_FAILED',
                error instanceof Error ? error.message : t('modules.api.models.errors.removeModelFailed')
            );
        }
    }

    /**
     * 设置当前激活模型
     */
    async setActiveModel(request: SetActiveModelRequest): Promise<SetActiveModelResponse> {
        try {
            const config = await this.configManager.getConfig(request.configId);
            if (!config) {
                return errorResponse('CONFIG_NOT_FOUND', t('modules.api.models.errors.configNotFound'));
            }

            // 验证模型是否在列表中
            const models = config.models ?? [];
            const modelExists = models.some(m => m.id === request.modelId);

            if (!modelExists && request.modelId !== '') {
                return errorResponse('MODEL_NOT_IN_LIST', t('modules.api.models.errors.modelNotInList'));
            }

            await this.configManager.updateConfig(request.configId, {
                model: request.modelId
            });

            return {
                success: true
            };
        } catch (error: unknown) {
            return errorResponse(
                'SET_ACTIVE_MODEL_FAILED',
                error instanceof Error ? error.message : t('modules.api.models.errors.setActiveModelFailed')
            );
        }
    }
}
