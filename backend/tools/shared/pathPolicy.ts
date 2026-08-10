/**
 * 路径白名单策略与父目录创建（从 design/plan/progress 各 pathUtils 收敛而来）
 */

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { getAllWorkspaces } from './workspacePaths';

/**
 * 多工作区（multi-root）下对带 scope 前缀路径的白名单校验（泛化版）。
 *
 * 规则（与 design/plan/progress 原实现逐字一致）：
 * - 单工作区（≤1 个）：直接交给 validator 判定；
 * - 多工作区：额外允许 "workspaceName/.graycode/xxx/**.md" 形式——首段视为工作区名，
 *   '.' / '..' / 含 ':' 的前缀一律拒绝，其余部分再次交给 validator。
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

/** 各文档域的路径白名单 scope 文案（错误消息使用，与各工具原文案逐字一致） */
export const DESIGN_PATH_SCOPE_LABEL = '.graycode/design/**.md';
export const PLAN_PATH_SCOPE_LABEL = '.graycode/plans/**.md';
export const REVIEW_PATH_SCOPE_LABEL = '.graycode/review/**.md';
export const PROGRESS_PATH_SCOPE_LABEL = '.graycode/progress.md';

/** 构建路径拒绝错误文案（"Rejected path" 变体，逐字保持各工具原文案） */
export function buildPathRejectedError(kind: string, scopeLabel: string, rejectedPath: string): string {
  return `Invalid ${kind} path. Only "${scopeLabel}" is allowed. Rejected path: ${rejectedPath}`;
}

/** 构建路径错误文案（"Received" 变体，compare_review_documents 使用，逐字保持原文案） */
export function buildPathReceivedError(kind: string, scopeLabel: string, received: string): string {
  return `Invalid ${kind} path. Only "${scopeLabel}" is allowed. Received: ${received}`;
}

/**
 * 通过 vscode.workspace.fs 递归创建父目录。
 * 支持远程工作区 / 虚拟文件系统（URI scheme 由 vscode 统一处理）。plan/progress/review 使用。
 */
export async function ensureParentDir(uriFsPath: string): Promise<void> {
  const dir = path.dirname(uriFsPath);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
}

/**
 * 通过本地 fs.promises.mkdir 递归创建父目录。
 *
 * 与 ensureParentDir 的差异：仅能处理本地 file 路径，远程/虚拟文件系统下行为不同；
 * design 沿用此实现（其 create/update 测试亦基于 fs.promises.mkdir 的 mock）。
 * 两个函数语义不完全等价，故分开保留。
 */
export async function ensureParentDirWithFs(uriFsPath: string): Promise<void> {
  const dir = path.dirname(uriFsPath);
  // 递归创建父目录（mkdir recursive），避免多级目录缺失时静默失败
  await fs.promises.mkdir(dir, { recursive: true });
}
