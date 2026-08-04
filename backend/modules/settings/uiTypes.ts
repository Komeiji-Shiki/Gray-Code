/**
 * GrayCode - UI 相关设置类型（声音提醒、Windows 通知等）
 *
 * 从 types.ts 拆分而来：types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

/**
 * UI 声音提醒设置
 */
export interface WindowsAgentStopNotificationContentSettings {
    /** 通知标题模板 */
    titleTemplate?: string;

    /** 通知正文模板 */
    bodyTemplates?: {
        /** 错误停止 */
        error?: string;
        /** 等待用户动作 */
        awaitingUserAction?: string;
        /** 等待继续 */
        continueRequired?: string;
    };
}

export interface WindowsAgentStopNotificationSettings {
    /** 总开关（默认关闭） */
    enabled?: boolean;

    /** 仅在当前窗口未聚焦时发送通知 */
    onlyWhenWindowNotFocused?: boolean;

    /** 停止场景开关 */
    cases?: {
        /** 错误停止 */
        error?: boolean;
        /** 等待用户操作 */
        awaitingUserAction?: boolean;
        /** 等待继续 */
        continueRequired?: boolean;
    };

    /** 通知内容模板 */
    content?: WindowsAgentStopNotificationContentSettings;
}

export interface UISoundSettings {
    /** 总开关（默认关闭，避免打扰） */
    enabled?: boolean;

    /** 音量（0-100） */
    volume?: number;

    /** 最小播放间隔（毫秒），用于限流 */
    cooldownMs?: number;

    /** 各类提示音开关 */
    cues?: {
        warning?: boolean;
        error?: boolean;
        taskComplete?: boolean;
        /** 任务失败提示音（可与 error 分开控制） */
        taskError?: boolean;
    };

    /**
     * 自定义音效（可选）：为各类提示音导入本地音频文件。
     *
     * 注意：为支持“清除已导入音效”，这里允许显式写入 null。
     */
    assets?: {
        warning?: UISoundAsset | null;
        error?: UISoundAsset | null;
        taskComplete?: UISoundAsset | null;
        taskError?: UISoundAsset | null;
    };

    /** 提示音风格 */
    theme?: 'beep' | 'soft';

    /**
     * Windows 专用 Agent 停止系统通知设置
     */
    windowsAgentStopNotification?: WindowsAgentStopNotificationSettings;
}

/**
 * UI 声音提醒 - 自定义音效资源
 */
export interface UISoundAsset {
    /** 文件名（展示用） */
    name: string;
    /** mime 类型（展示用，可为空字符串） */
    mime: string;
    /** base64 内容（不含 data: 前缀） */
    dataBase64: string;
}
