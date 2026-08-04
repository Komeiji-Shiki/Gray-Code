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
export function getExtensionVersion(extensionPath: string): string {
  try {
    const packageJsonPath = path.join(extensionPath, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version || '0.0.0';
  } catch (error) {
    console.warn('[extensionInfo] Failed to read extension version from package.json:', error);
    return '0.0.0';
  }
}
