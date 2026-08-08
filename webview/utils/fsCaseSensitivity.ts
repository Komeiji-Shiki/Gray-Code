/**
 * 文件系统大小写敏感性探测（工作区 URI 匹配口径的依据）
 *
 * 为什么不能只看平台：
 * - Windows NTFS/ReFS 大小写不敏感（确定）
 * - macOS APFS 默认大小写不敏感，但可被格式化为大小写敏感（不确定）
 * - Linux ext4/xfs/btrfs 默认敏感，但 WSL drvfs 挂载（/mnt/c、/mnt/d）不敏感（不确定）
 *
 * 探测方法：取样本路径最后一个字母字符，切换大小写生成变体路径；
 * 变体路径存在且与原路径是同一文件（POSIX dev+ino 相同）→ 大小写不敏感；
 * 变体不存在或 inode 不同 → 大小写敏感；无法判定时回退平台默认值。
 */

import * as fs from 'fs';

/** 切换单个字符的大小写；非字母返回空串 */
function toggleCase(ch: string): string {
  if (ch >= 'a' && ch <= 'z') return ch.toUpperCase();
  if (ch >= 'A' && ch <= 'Z') return ch.toLowerCase();
  return '';
}

/**
 * 对路径做一次大小写变体探测。
 *
 * @param fsPath 样本路径（通常取第一个打开的工作区文件夹）
 * @returns true = 大小写敏感；false = 大小写不敏感；undefined = 无法判定（调用方回退默认）
 */
export function probePathCaseSensitivity(fsPath: string): boolean | undefined {
  for (let i = fsPath.length - 1; i >= 0; i--) {
    const toggled = toggleCase(fsPath[i]);
    if (!toggled) continue;
    const variant = fsPath.slice(0, i) + toggled + fsPath.slice(i + 1);
    try {
      if (fs.existsSync(variant)) {
        const stat = fs.statSync(fsPath);
        const variantStat = fs.statSync(variant);
        // 同一文件（同 dev+ino）：大小写不同的两个路径解析到同一目录 → 不敏感；
        // inode 不同（大小写敏感文件系统上恰好存在两个同名不同大小写目录）→ 敏感
        return stat.dev === variantStat.dev && stat.ino === variantStat.ino ? false : true;
      }
      return true;
    } catch {
      // 探测失败（权限等）：尝试下一个字母字符
      continue;
    }
  }
  return undefined;
}

/**
 * 判定文件系统大小写敏感性。
 *
 * @param fsPath 探测样本路径；为空或无法判定时回退平台默认值
 */
export function detectFsCaseSensitivity(fsPath: string | undefined): boolean {
  if (process.platform === 'win32') return false;
  if (fsPath) {
    const result = probePathCaseSensitivity(fsPath);
    if (result !== undefined) return result;
  }
  // 平台默认：macOS APFS 默认大小写不敏感；Linux 常见文件系统默认敏感
  return process.platform !== 'darwin';
}

/**
 * 进程级共享的大小写敏感性口径（WorkspaceManager / WorkspaceHandlers /
 * WorkspaceUtils 统一使用，避免多套口径互相矛盾）。
 *
 * - 首次带有效样本调用时完成探测并永久缓存（同一文件系统内大小写策略不变）；
 * - 样本为空（工作区列表尚未就绪）时返回平台默认且**不缓存**，后续列表就绪
 *   后再次调用会重新探测——避免 Electron 启动早期探测到空列表导致口径漂移。
 */
let cachedCaseSensitivity: boolean | null = null;
let caseSensitivityProbed = false;

export function getFsCaseSensitivity(probePath: string | undefined): boolean {
  if (caseSensitivityProbed) return cachedCaseSensitivity!;
  if (!probePath) return detectFsCaseSensitivity(undefined);
  cachedCaseSensitivity = detectFsCaseSensitivity(probePath);
  caseSensitivityProbed = true;
  return cachedCaseSensitivity;
}
