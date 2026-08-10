/**
 * GrayCode - 存档点（Checkpoint）相关设置类型
 *
 * 从 types.ts 拆分而来：types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

import type { CheckpointExclusionConfig } from '../checkpoint';
import {
    DEFAULT_ENABLED_PROFILES,
    DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES
} from '../checkpoint';

/**
 * 消息类型存档点配置
 *
 * 类似工具备份配置，支持在消息前后创建存档点
 */
export interface MessageCheckpointConfig {
    /**
     * 需要在消息发送/接收前创建备份的消息类型
     * 可选值: 'user', 'model'
     */
    beforeMessages: string[];
    
    /**
     * 需要在消息发送/接收后创建备份的消息类型
     * 可选值: 'user', 'model'
     */
    afterMessages: string[];
    
    /**
     * 连续调用工具时，是否只在最外层创建模型消息存档点
     *
     * 当为 true 时：
     * - 模型消息前存档点：只在第一次迭代时创建
     * - 模型消息后存档点：只在最后一次迭代（无工具调用）时创建
     *
     * 当为 false 时：
     * - 每次迭代都会创建模型消息的前后存档点
     *
     * 默认为 true
     */
    modelOuterLayerOnly?: boolean;
    
    /**
     * 是否合并显示消息前后无变更的存档点
     *
     * 当为 true 时：
     * - 如果消息前后存档点的内容哈希相同，则合并显示为一个"内容未变化"的存档点
     *
     * 当为 false 时：
     * - 始终分别显示消息前和消息后的存档点
     *
     * 默认为 true
     */
    mergeUnchangedCheckpoints?: boolean;
}

/**
 * 存档点配置
 *
 * 控制哪些工具需要在执行前后创建备份
 */
export interface CheckpointConfig {
    /**
     * 是否全局启用存档点功能
     */
    enabled: boolean;
    
    /**
     * 需要在执行前创建备份的工具列表
     */
    beforeTools: string[];
    
    /**
     * 需要在执行后创建备份的工具列表
     */
    afterTools: string[];
    
    /**
     * 消息类型存档点配置
     *
     * 控制是否为用户消息和模型消息创建存档点
     */
    messageCheckpoint?: MessageCheckpointConfig;
    
    /**
     * 保留的最大存档点数量
     * 超过此数量时自动清理旧的存档点
     */
    maxCheckpoints: number;
    
    /**
     * 自定义忽略模式（追加到默认 .gitignore 规则）
     *
     * @deprecated 遗留字段：新写入请使用 `exclusion.customPatterns`；
     * 读取时两者都会生效（customIgnorePatterns 在前）。
     */
    customIgnorePatterns?: string[];

    /**
     * 排除配置（EX-08）：默认排除类别开关、单文件大小上限、自定义排除模式。
     * 缺省时按 DEFAULT_CHECKPOINT_CONFIG 的默认值处理（类别全开、50 MiB 上限）。
     */
    exclusion?: CheckpointExclusionConfig;
    
    [key: string]: unknown;
}

/**
 * 默认消息存档点配置
 *
 * 默认配置：
 * - 用户消息：只在发送前创建存档点
 * - 助手消息：不创建存档点
 */
export const DEFAULT_MESSAGE_CHECKPOINT_CONFIG: MessageCheckpointConfig = {
    beforeMessages: ['user'],  // 用户消息前创建存档点
    afterMessages: [],
    modelOuterLayerOnly: true,  // 默认只在最外层创建
    mergeUnchangedCheckpoints: true  // 默认合并无变更的存档点
};

/**
 * 默认存档点配置
 *
 * 默认对文件修改类工具启用备份
 */
export const DEFAULT_CHECKPOINT_CONFIG: CheckpointConfig = {
    enabled: true,
    beforeTools: [
        'apply_diff',
        'write_file',
        'insert_code',
        'delete_file',
        'delete_code',
        'create_directory',
        'execute_command',
        'search_in_files',
        'generate_image',
        'remove_background',
        'crop_image',
        'resize_image',
        'rotate_image',
        'create_plan',
        'update_plan',
        'create_design',
        'update_design',
        'create_progress',
        'update_progress',
        'record_progress_milestone',
        'create_review',
        'record_review_milestone',
        'finalize_review',
        'reopen_review'
    ],
    afterTools: [
        'apply_diff',
        'write_file',
        'insert_code',
        'delete_file',
        'delete_code',
        'create_directory',
        'execute_command',
        'search_in_files',
        'generate_image',
        'remove_background',
        'crop_image',
        'resize_image',
        'rotate_image',
        'create_plan',
        'update_plan',
        'create_design',
        'update_design',
        'create_progress',
        'update_progress',
        'record_progress_milestone',
        'create_review',
        'record_review_milestone',
        'finalize_review',
        'reopen_review'
    ],
    messageCheckpoint: DEFAULT_MESSAGE_CHECKPOINT_CONFIG,
    maxCheckpoints: -1,  // -1 表示无上限
    customIgnorePatterns: [],
    // EX-08: 排除配置默认值（类别全开、单文件 50 MiB 上限、无自定义模式）
    exclusion: {
        enabledProfiles: { ...DEFAULT_ENABLED_PROFILES },
        maxFileSizeBytes: DEFAULT_EXCLUSION_MAX_FILE_SIZE_BYTES,
        customPatterns: []
    }
};
