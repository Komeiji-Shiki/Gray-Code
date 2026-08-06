/**
 * LimCode 模块注册表实现
 */

import type {
    ModuleDefinition,
    ApiRequest,
    ApiResponse,
    IModuleRegistry
} from './types';
import { t } from '../../i18n';
import { Logger } from '../logger';

const log = Logger.get('ModuleRegistry');

/**
 * 模块注册表
 */
export class ModuleRegistry implements IModuleRegistry {
    private modules = new Map<string, ModuleDefinition>();

    /**
     * 注册模块
     */
    registerModule(module: ModuleDefinition): void {
        if (this.modules.has(module.id)) {
            throw new Error(t('core.registry.moduleAlreadyRegistered', { moduleId: module.id }));
        }

        // 验证 API 名称唯一性
        const apiNames = new Set<string>();
        for (const api of module.apis) {
            if (apiNames.has(api.name)) {
                throw new Error(t('core.registry.duplicateApiName', { moduleId: module.id, apiName: api.name }));
            }
            apiNames.add(api.name);
        }

        this.modules.set(module.id, module);
        // 注册/注销是启动期与热加载期的常规操作，console.log 会刷屏；降为 debug 级
        log.debug('module.registered', { moduleId: module.id, moduleName: module.name, version: module.version });
    }

    /**
     * 取消注册模块
     */
    unregisterModule(moduleId: string): void {
        if (!this.modules.has(moduleId)) {
            console.warn(t('core.registry.moduleNotRegistered', { moduleId }));
            return;
        }

        this.modules.delete(moduleId);
        log.debug('module.unregistered', { moduleId });
    }

    /**
     * 调用 API
     */
    async callApi(request: ApiRequest): Promise<ApiResponse> {
        try {
            // 查找模块
            const module = this.modules.get(request.moduleId);
            if (!module) {
                return {
                    success: false,
                    error: t('core.registry.moduleNotRegistered', { moduleId: request.moduleId })
                };
            }

            // 查找 API
            const api = module.apis.find(a => a.name === request.apiName);
            if (!api) {
                return {
                    success: false,
                    error: t('core.registry.apiNotFound', { moduleId: request.moduleId, apiName: request.apiName })
                };
            }

            // 验证参数
            const missingParams = api.parameters
                .filter(p => p.required && !(p.name in request.params))
                .map(p => p.name);

            if (missingParams.length > 0) {
                return {
                    success: false,
                    error: t('core.registry.missingRequiredParams', { params: missingParams.join(', ') })
                };
            }

            // 调用 API
            const result = await api.handler(request.params);

            return {
                success: true,
                data: result
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * 获取所有模块
     */
    getModules(): ModuleDefinition[] {
        return Array.from(this.modules.values());
    }

    /**
     * 获取模块
     */
    getModule(moduleId: string): ModuleDefinition | undefined {
        return this.modules.get(moduleId);
    }

    /**
     * 获取模块的所有 API（JSON 格式）
     */
    getModuleApisJson(moduleId: string): string {
        const module = this.modules.get(moduleId);
        if (!module) {
            return JSON.stringify({ error: t('core.registry.moduleNotRegistered', { moduleId }) });
        }

        return JSON.stringify({
            moduleId: module.id,
            moduleName: module.name,
            version: module.version,
            apis: module.apis.map(api => ({
                name: api.name,
                description: api.description,
                parameters: api.parameters.map(p => ({
                    name: p.name,
                    type: p.type,
                    required: p.required,
                    description: p.description,
                    default: p.default
                })),
                returnType: api.returnType
            }))
        }, null, 2);
    }

    /**
     * 获取所有 API（JSON 格式）
     */
    getAllApisJson(): string {
        const allApis = Array.from(this.modules.values()).map(module => ({
            moduleId: module.id,
            moduleName: module.name,
            version: module.version,
            description: module.description,
            apis: module.apis.map(api => ({
                name: api.name,
                description: api.description,
                parameters: api.parameters.map(p => ({
                    name: p.name,
                    type: p.type,
                    required: p.required,
                    description: p.description,
                    default: p.default
                })),
                returnType: api.returnType
            }))
        }));

        return JSON.stringify(allApis, null, 2);
    }
}

/**
 * 全局模块注册表单例
 */
export const globalRegistry = new ModuleRegistry();