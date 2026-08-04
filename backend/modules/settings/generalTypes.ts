/**
 * GrayCode - 全局设置聚合类型与默认值
 *
 * 从 types.ts 拆分而来：包含全局设置总接口、设置变更事件、
 * 代理/存储路径等通用配置，以及 DEFAULT_GLOBAL_SETTINGS 聚合默认值。
 * types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

import type { UISoundSettings } from './uiTypes';
import type {
    ToolsEnabledState,
    ToolAutoExecConfig,
    ToolsConfig
} from './toolsTypes';
import {
    DEFAULT_MAX_TOOL_ITERATIONS,
    DEFAULT_TOOL_AUTO_EXEC_CONFIG,
    DEFAULT_READ_FILE_CONFIG,
    DEFAULT_WRITE_FILE_CONFIG,
    DEFAULT_LIST_FILES_CONFIG,
    DEFAULT_FIND_FILES_CONFIG,
    DEFAULT_SEARCH_IN_FILES_CONFIG,
    DEFAULT_APPLY_DIFF_CONFIG,
    DEFAULT_DELETE_FILE_CONFIG,
    getDefaultExecuteCommandConfig,
    DEFAULT_GENERATE_IMAGE_CONFIG,
    DEFAULT_REMOVE_BACKGROUND_CONFIG,
    DEFAULT_CROP_IMAGE_CONFIG,
    DEFAULT_RESIZE_IMAGE_CONFIG,
    DEFAULT_ROTATE_IMAGE_CONFIG,
    DEFAULT_MEMORY_TOOL_CONFIG
} from './toolsTypes';
import { DEFAULT_CHECKPOINT_CONFIG } from './checkpointTypes';
import { DEFAULT_SUMMARIZE_CONFIG } from './summarizeTypes';
import { DEFAULT_TOKEN_COUNT_CONFIG } from './tokenCountTypes';
import { DEFAULT_CONTEXT_AWARENESS_CONFIG } from './contextTypes';
import { DEFAULT_PINNED_FILES_CONFIG } from './pinnedFilesTypes';
import { DEFAULT_SYSTEM_PROMPT_CONFIG } from './promptModes';

/**
 * 代理配置
 */
export interface ProxySettings {
    /**
     * 是否启用代理
     */
    enabled: boolean;
    
    /**
     * 代理地址
     *
     * 格式: http://host:port 或 https://host:port
     * 例如: http://127.0.0.1:7890
     */
    url?: string;
}

/**
 * 数据存储路径配置
 *
 * 允许用户自定义大文件的存储位置，避免占用 C 盘空间
 * 核心设置仍保存在 globalStorageUri，只有大文件使用自定义路径
 */
export interface StoragePathConfig {
    /**
     * 自定义数据存储根目录
     *
     * 如果为空或未设置，使用默认的 globalStorageUri
     * 例如: "D:\\GrayCodeData" 或 "/home/user/GrayCode-data"
     */
    customDataPath?: string;
    
    /**
     * 最后一次成功迁移的时间戳
     */
    lastMigrationAt?: number;
    
    /**
     * 迁移状态
     */
    migrationStatus?: 'none' | 'pending' | 'in_progress' | 'completed' | 'failed';
    
    /**
     * 迁移失败的错误信息
     */
    migrationError?: string;
}

/**
 * 存储目录统计信息
 */
export interface StorageStats {
    /**
     * 目录路径
     */
    path: string;
    
    /**
     * 总大小（字节）
     */
    totalSize: number;
    
    /**
     * 文件数量
     */
    fileCount: number;
    
    /**
     * 子目录统计
     */
    subDirs: {
        conversations: { size: number; count: number };
        checkpoints: { size: number; count: number };
        mcp: { size: number; count: number };
        dependencies: { size: number; count: number };
        diffs: { size: number; count: number };
    };
}

/**
 * 全局设置
 *
 * 包含所有全局级别的配置项
 */
export interface GlobalSettings {
    /**
     * 数据存储路径配置
     */
    storagePath?: StoragePathConfig;
    
    /**
     * 当前激活的渠道配置 ID
     *
     * 用于快速切换渠道
     */
    activeChannelId?: string;
    
    /**
     * 单回合最大工具调用次数
     *
     * 防止 AI 无限循环调用工具
     * -1 表示无限制
     * 默认: 50
     */
    maxToolIterations?: number;
    
    /**
     * 工具启用状态
     *
     * 控制哪些工具对所有渠道可用
     * 未列出的工具默认启用
     */
    toolsEnabled: ToolsEnabledState;
    
    /**
     * 工具自动执行配置
     *
     * 控制哪些工具可以自动执行（无需用户确认）
     * 未列出的工具默认自动执行
     */
    toolAutoExec?: ToolAutoExecConfig;
    
    /**
     * 工具特定配置
     *
     * 每个工具可以有自己的配置项
     */
    toolsConfig?: ToolsConfig;
    
    /**
     * 全局默认工具模式
     *
     * 当渠道配置未指定时使用
     */
    defaultToolMode?: 'function_call' | 'xml' | 'json';
    
    /**
     * 代理配置
     *
     * 用于 API 请求通过代理服务器
     */
    proxy?: ProxySettings;
    
    /**
     * UI 偏好设置
     */
    ui?: {
        /** 主题模式 */
        theme?: 'light' | 'dark' | 'auto';
        
        /** 语言设置 */
        language?: string;

        /**
         * 外观设置
         */
        appearance?: {
            /**
             * 流式输出指示器文本（例如：Loading / 思考中…）
             *
             * - 为空或未设置时：前端使用默认值
             */
            loadingText?: string;

            /**
             * 是否启用选中内容入口
             *
             * - true: 显示“添加选中内容到输入框”的悬浮链接和 Code Action
             * - false: 不显示上述入口
             */
            selectionContextEnabled?: boolean;

            /**
             * 兼容旧版：是否启用选中文本悬浮入口
             * @deprecated 请改用 selectionContextEnabled
             */
            selectionContextHoverEnabled?: boolean;

            /**
             * 兼容旧版：是否启用选中文本 Code Action 入口
             * @deprecated 请改用 selectionContextEnabled
             */
            selectionContextCodeActionEnabled?: boolean;
        };

        /**
         * 声音提醒
         */
        sound?: UISoundSettings;

        /**
         * 用量页模型单价（美元 / 每百万 token）
         *
         * key 为 modelVersion；input = 输入单价，output = 输出单价（思考 token 按输出计）。
         * 两项均为 0 时视为未配置。
         */
        usagePricing?: Record<string, { input?: number; output?: number }>;
    };
    
    /**
     * 用户上次查看的公告版本
     * 
     * 用于判断是否需要显示新版本的更新公告
     */
    lastReadAnnouncementVersion?: string;
    
    /**
     * 最后更新时间戳
     */
    lastUpdated: number;
}

/**
 * 机器作用域键（仅本机有效，导出/导入时必须跳过）
 *
 * 这些键的值与特定机器绑定（如代理设置中的本地代理端口、
 * 数据存储路径等），跨机器导入会打断网络或数据目录。
 */
export const MACHINE_SCOPE_KEYS: readonly string[] = ['proxy', 'storagePath'];

/**
 * 设置变更事件
 */
export interface SettingsChangeEvent {
    /** 变更类型 */
    type: 'channel' | 'tools' | 'toolMode' | 'proxy' | 'storagePath' | 'ui' | 'full';
    
    /** 变更的字段路径（如 'toolsEnabled.read_file'） */
    path?: string;
    
    /** 旧值 */
    oldValue?: any;
    
    /** 新值 */
    newValue?: any;
    
    /** 完整的新设置 */
    settings: GlobalSettings;
}

/**
 * 设置变更监听器
 */
export type SettingsChangeListener = (event: SettingsChangeEvent) => void | Promise<void>;

/**
 * 默认全局设置
 */
export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
    maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
    toolsEnabled: {
        // 默认所有工具启用
    },
    toolAutoExec: DEFAULT_TOOL_AUTO_EXEC_CONFIG,
    toolsConfig: {
        read_file: DEFAULT_READ_FILE_CONFIG,
        write_file: DEFAULT_WRITE_FILE_CONFIG,
        list_files: DEFAULT_LIST_FILES_CONFIG,
        find_files: DEFAULT_FIND_FILES_CONFIG,
        search_in_files: DEFAULT_SEARCH_IN_FILES_CONFIG,
        apply_diff: DEFAULT_APPLY_DIFF_CONFIG,
        delete_file: DEFAULT_DELETE_FILE_CONFIG,
        execute_command: getDefaultExecuteCommandConfig(),
        checkpoint: DEFAULT_CHECKPOINT_CONFIG,
        summarize: DEFAULT_SUMMARIZE_CONFIG,
        generate_image: DEFAULT_GENERATE_IMAGE_CONFIG,
        remove_background: DEFAULT_REMOVE_BACKGROUND_CONFIG,
        crop_image: DEFAULT_CROP_IMAGE_CONFIG,
        resize_image: DEFAULT_RESIZE_IMAGE_CONFIG,
        rotate_image: DEFAULT_ROTATE_IMAGE_CONFIG,
        context_awareness: DEFAULT_CONTEXT_AWARENESS_CONFIG,
        pinned_files: DEFAULT_PINNED_FILES_CONFIG,
        system_prompt: DEFAULT_SYSTEM_PROMPT_CONFIG,
        token_count: DEFAULT_TOKEN_COUNT_CONFIG,
        memory: DEFAULT_MEMORY_TOOL_CONFIG
    },
    defaultToolMode: 'function_call',
    proxy: {
        enabled: false,
        url: undefined
    },
    ui: {
        theme: 'auto',
        language: 'zh-CN',
        appearance: {
            // 为空表示前端使用默认值（通常来自 i18n）
            loadingText: '',
            selectionContextEnabled: true
        },
        sound: {
            enabled: false,
            volume: 60,
            cooldownMs: 800,
            cues: {
                warning: true,
                error: true,
                taskComplete: true,
                taskError: true
            },
            theme: 'beep',
            windowsAgentStopNotification: {
                enabled: false,
                onlyWhenWindowNotFocused: true,
                cases: {
                    error: true,
                    awaitingUserAction: true,
                    continueRequired: true
                },
                content: {
                    titleTemplate: '{windowTitle} · GrayCode',
                    bodyTemplates: {
                        error: 'GrayCode 已停止，请返回处理。',
                        awaitingUserAction: 'GrayCode 正在等待：{actionLabel}。',
                        continueRequired: 'GrayCode 已暂停，可继续处理。'
                    }
                }
            }
        }
    },
    lastUpdated: Date.now()
};
