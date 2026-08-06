/**
 * 路径策略统一辅助（plan / design / progress 共用）。
 *
 * 修改原因：plan/pathUtils、design/pathUtils、progress/pathUtils 三处维护了
 * 同构的 isXxxModePathAllowedWithMultiRoot（多根工作区前缀拆分校验）与
 * ensureParentDir（创建父目录），逻辑一致却各自复制。
 * 修改方式：收敛到本模块；plan/design/progress 的 pathUtils 改为薄封装，
 * 保留原有导出名与签名，调用点无需改动。
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { getAllWorkspaces } from './utils';

/**
 * 多根工作区下的作用域路径校验（progress 版本的通用实现）：
 * - 先整体校验通过则放行；
 * - 未通过且为多根工作区时，按首个 "/" 拆出 workspace 前缀，校验剩余部分。
 *   （单根工作区或前缀不含法时直接拒绝，语义与 plan/design 原实现一致）
 */
export function isScopedPathAllowedWithMultiRoot(
  pathStr: string,
  validator: (path: string) => boolean
): boolean {
  if (validator(pathStr)) return true;

  const workspaces = getAllWorkspaces();
  if (workspaces.length <= 1) return false;

  const normalized = (pathStr || '').replace(/\\/g, '/');
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0) return false;

  const workspacePrefix = normalized.slice(0, slashIndex);
  if (workspacePrefix === '.' || workspacePrefix === '..') return false;
  if (workspacePrefix.includes(':')) return false;

  const rest = normalized.slice(slashIndex + 1);
  return validator(rest);
}

/**
 * 确保目标文件所在父目录存在（创建目录时 createDirectory 对已存在目录是幂等的）。
 */
export async function ensureParentDir(uriFsPath: string): Promise<void> {
  const dir = path.dirname(uriFsPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
}
