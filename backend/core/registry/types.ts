/**
 * LimCode 模块注册系统 - 类型定义
 */

/**
 * API 参数定义
 */
export interface ApiParameter {
    /** 参数名 */
    name: string;
    /** 参数类型 */
    type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';
    /** 是否必需 */
    required: boolean;
    /** 参数描述 */
    description?: string;
    /** 默认值 */
    default?: unknown;
}

/**
 * API 定义
 */
export interface ApiDefinition {
    /** API 名称（唯一标识） */
    name: string;
    /** API 描述 */
    description: string;
    /** 参数列表 */
    parameters: ApiParameter[];
    /** 返回值类型描述 */
    returnType: string;
    /** API 处理函数 */
    handler: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * 模块定义
 */
export interface ModuleDefinition {
    /** 模块 ID（唯一标识） */
    id: string;
    /** 模块名称 */
    name: string;
    /** 模块版本 */
    version: string;
    /** 模块描述 */
    description: string;
    /** 模块提供的 API 列表 */
    apis: ApiDefinition[];
    /** 初始化函数（可选） */
    initialize?: () => Promise<void>;
    /** 清理函数（可选） */
    dispose?: () => Promise<void>;
}

/**
 * API 调用请求
 */
export interface ApiRequest {
    /** 模块 ID */
    moduleId: string;
    /** API 名称 */
    apiName: string;
    /** 参数 */
    params: Record<string, unknown>;
}

/**
 * API 调用响应
 */
export interface ApiResponse {
    /** 是否成功 */
    success: boolean;
    /** 返回数据 */
    data?: unknown;
    /** 错误信息 */
    error?: string;
}

/**
 * 模块注册表接口
 */
export interface IModuleRegistry {
    /** 注册模块（执行 initialize 生命周期） */
    registerModule(module: ModuleDefinition): Promise<void>;
    
    /** 取消注册模块（执行 dispose 生命周期） */
    unregisterModule(moduleId: string): Promise<void>;
    
    /** 调用 API */
    callApi(request: ApiRequest): Promise<ApiResponse>;
    
    /** 获取所有模块 */
    getModules(): ModuleDefinition[];
    
    /** 获取模块 */
    getModule(moduleId: string): ModuleDefinition | undefined;
    
    /** 获取模块的所有 API（JSON 格式，用于前端） */
    getModuleApisJson(moduleId: string): string;
    
    /** 获取所有 API（JSON 格式，用于前端） */
    getAllApisJson(): string;
}