/**
 * 检查点模块共享路径工具（CP-DUP-1）。
 *
 * isExcludedAbsolutePath：判断绝对路径是否位于任一强制排除目录内
 * （存档目录自身等，防止存档把自己再次备份）。
 *
 * CHECKPOINT_CREATE_LOCK_PREFIX：跨进程「创建中」lockfile 前缀（CP-ORPHAN-3）。
 * 备份创建流程 mkdir 后写 `<checkpointsDir>/.creating-<checkpointId>`，完成/失败后删除；
 * 孤儿清理（removeOrphanBackupDirs）据此跳过另一窗口正在创建的备份目录
 *（mkdir→writeManifest 可远超单进程 mtime 新鲜度窗口，见 CheckpointQueryService）。
 *
 * 大小写策略统一（EX-CASE-1/EX-CASE-2 同族）：
 * - win32（Windows 文件系统不区分大小写）与 darwin（macOS 默认 APFS
 *   大小写不敏感卷）下折叠小写比较，排除配置与磁盘路径的大小写差异
 *   不应放行强制排除；
 * - 其余平台（大小写敏感）按原样比较。
 */
import * as path from 'path';

/** 跨进程「创建中」lockfile 前缀（CP-ORPHAN-3） */
export const CHECKPOINT_CREATE_LOCK_PREFIX = '.creating-';

/** 判断绝对路径是否位于任一强制排除目录内（含等于排除目录自身） */
export function isExcludedAbsolutePath(absolutePath: string, excludePaths: readonly string[]): boolean {
    if (excludePaths.length === 0) return false;
    const caseFold = process.platform === 'win32' || process.platform === 'darwin'
        ? (p: string) => p.toLowerCase()
        : (p: string) => p;
    const target = caseFold(path.resolve(absolutePath));
    return excludePaths.some(excludePath => {
        const excluded = caseFold(path.resolve(excludePath));
        if (target === excluded) return true;
        return target.startsWith(excluded + path.sep);
    });
}
