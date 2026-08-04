/**
 * GrayCode - 固定文件（Pinned Files）相关设置类型
 *
 * 从 types.ts 拆分而来：types.ts 通过 `export *` 重导出，旧引用路径保持兼容。
 */

/**
 * 固定文件项
 *
 * 单个被挂载的文件信息
 */
export interface PinnedFileItem {
    /**
     * 文件的唯一标识
     */
    id: string;
    
    /**
     * 文件路径（相对于工作区的路径）
     */
    path: string;
    
    /**
     * 所属工作区 URI
     * 用于多工作区场景下区分文件所属
     */
    workspaceUri: string;
    
    /**
     * 是否启用（可临时禁用某个文件）
     * 默认: true
     */
    enabled: boolean;
    
    /**
     * 添加时间戳
     */
    addedAt: number;
}

/**
 * 固定文件配置
 *
 * 允许挂载多个文本文件，每次调用 AI 时读取内容并添加到系统提示词
 */
export interface PinnedFilesConfig {
    /**
     * 固定文件列表
     */
    files: PinnedFileItem[];
    
    /**
     * 在系统提示词中的标题
     * 默认: 'PINNED FILES CONTENT'
     */
    sectionTitle: string;
    
    [key: string]: unknown;
}

/**
 * 默认固定文件配置
 */
export const DEFAULT_PINNED_FILES_CONFIG: PinnedFilesConfig = {
    files: [],
    sectionTitle: 'PINNED FILES CONTENT'
};
