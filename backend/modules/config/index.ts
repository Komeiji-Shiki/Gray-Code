/**
 * LimCode - 配置管理模块
 * 
 * 统一导出所有类型、类和函数
 */

// 类型定义
export type {
    // 渠道类型
    ChannelType,
    
    // 配置接口
    BaseChannelConfig,
    GeminiConfig,
    OpenAIConfig,
    AnthropicConfig,
    ChannelConfig,

    // 模型信息（定义于 configs/base，channel 侧经 modelList re-export 兼容）
    ModelInfo,

    // 输入类型
    CreateConfigInput,
    UpdateConfigInput,
    
    // 统计和验证
    ConfigStats,
    ValidationResult,
    
    // 选项
    ExportOptions,
    ImportOptions,
    ConfigFilter,
    ConfigSortOptions
} from './types';

// 存储适配器
export type { ConfigStorageAdapter } from './storage';
export {
    MemoryStorageAdapter,
    MementoStorageAdapter,
    HybridStorageAdapter
} from './storage';

// 核心管理器
export { ConfigManager } from './ConfigManager';

// 补充类型（configs/base 定义的渠道级类型）
export type { TokenCountMethod, TokenCountApiConfig } from './types';
export type { CustomHeader, ToolMode } from './configs/base';