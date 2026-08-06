/**
 * 扩展信息工具函数
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * 从扩展目录读取 package.json 中的版本号。
 *
 * 供 ChatViewProvider 与 SettingsHandlers 共用（两处此前各自实现同一逻辑，容易漂移），
 * 读取失败时回退 '0.0.0'。
 */

// 打包后 package.json 不变：按扩展路径 memoize，避免每次调用同步读盘 + JSON.parse
const versionCache = new Map<string, string>();

export function getExtensionVersion(extensionPath: string): string {
  const cached = versionCache.get(extensionPath);
  if (cached !== undefined) return cached;
  try {
    const packageJsonPath = path.join(extensionPath, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const version = packageJson.version || '0.0.0';
    versionCache.set(extensionPath, version);
    return version;
  } catch (error) {
    console.warn('[extensionInfo] Failed to read extension version from package.json:', error);
    return '0.0.0';
  }
}
