/**
 * 文件工具模块
 *
 * 导出所有文件相关的工具
 */

// 静态导入注册函数（与下方 re-export 共用同一模块实例，替代原函数内 require）
import { registerReadFile } from './read_file';
import { registerWriteFile } from './write_file';
import { registerListFiles } from './list_files';
import { registerDeleteFile } from './delete_file';
import { registerCreateDirectory } from './create_directory';
import { registerApplyDiff } from './apply_diff';
import { registerInsertCode } from './insert_code';
import { registerDeleteCode } from './delete_code';

// 导出各个工具的创建函数
export { registerReadFile } from './read_file';
export { registerWriteFile } from './write_file';
export { registerListFiles } from './list_files';
export { registerDeleteFile } from './delete_file';
export { registerCreateDirectory } from './create_directory';
export { registerApplyDiff } from './apply_diff';
export { registerInsertCode } from './insert_code';
export { registerDeleteCode } from './delete_code';

// 导出 DiffManager 相关
export { getDiffManager, type PendingDiff, type DiffSettings } from '../../core/services/diffManager';

/**
 * 获取所有文件工具的注册函数
 * @returns 注册函数数组
 */
export function getFileToolRegistrations() {
    return [
        registerReadFile,
        registerWriteFile,
        registerListFiles,
        registerDeleteFile,
        registerCreateDirectory,
        registerApplyDiff,
        registerInsertCode,
        registerDeleteCode
    ];
}