/**
 * 工作区工具函数
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../../backend/i18n';
import { isPathInsideOrEqual } from './workspaceRealpath';

/**
 * 检查路径是否应该被忽略
 */
export function shouldIgnorePath(relativePath: string, ignorePatterns: string[]): boolean {
  for (const pattern of ignorePatterns) {
    if (matchGlobPattern(relativePath, pattern)) {
      return true;
    }
  }
  return false;
}

/**
 * 简单的 glob 模式匹配
 * 支持 * 和 ** 通配符
 */
export function matchGlobPattern(filePath: string, pattern: string): boolean {
  if (typeof filePath !== 'string' || typeof pattern !== 'string' || !pattern) return false;
  try {
    const normalizedPattern = pattern.replace(/\\/g, '/');
    const GLOBSTAR = '\u0000';
    const STAR = '\u0001';
    const QUESTION = '\u0002';
    const regexPattern = normalizedPattern
      .replace(/\*\*/g, GLOBSTAR)
      .replace(/\*/g, STAR)
      // glob 规范：? 匹配单个非路径分隔符字符。先替换为占位符，
      // 避免被后续特殊字符转义把 [^/] 变成字面量（F16）
      .replace(/\?/g, QUESTION)
      .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
      .replace(new RegExp(GLOBSTAR, 'g'), '.*')
      .replace(new RegExp(STAR, 'g'), '[^/]*')
      .replace(new RegExp(QUESTION, 'g'), '[^/]');
    // 大小写敏感性按平台：仅 Windows 文件系统不区分大小写（F13）
    const flags = process.platform === 'win32' ? 'i' : undefined;
    const regex = new RegExp(`(?:^|/)${regexPattern}(?:$|/)`, flags);
    return regex.test(filePath.replace(/\\/g, '/'));
  } catch {
    return false;
  }
}

/**
 * 获取当前工作区 URI
 */
export function getCurrentWorkspaceUri(): string | null {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder ? workspaceFolder.uri.toString() : null;
}

/**
 * 将绝对路径或 URI 转换为相对路径
 * 支持 file://, vscode-remote:// URI 格式以及 Windows 绝对路径格式
 */
export function getRelativePathFromAbsolute(absolutePath: string): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error(t('webview.errors.noWorkspaceOpen'));
  }
  
  let filePath = absolutePath;
  let isRemote = false;
  
  // 支持 file:// 和 vscode-remote:// URI 格式
  if (absolutePath.startsWith('file://') || absolutePath.startsWith('vscode-remote://')) {
    try {
      const uri = vscode.Uri.parse(absolutePath);
      isRemote = absolutePath.startsWith('vscode-remote://');
      // 对于本地文件使用 fsPath，对于远程文件使用 path
      filePath = isRemote ? uri.path : uri.fsPath;
    } catch {
      // 解析失败，保持原始路径
    }
  } else if (/^[a-zA-Z]:[/\\]/.test(absolutePath)) {
    // 处理 Windows 绝对路径格式 (如 f:\path 或 F:/path)
    try {
      const uri = vscode.Uri.file(absolutePath);
      filePath = uri.fsPath;
    } catch {
      // 解析失败，保持原始路径
    }
  }
  
  // 遍历所有工作区根做前缀匹配：多根工作区中文件可能属于任一根（F15）
  for (const workspaceFolder of workspaceFolders) {
    // 对于远程工作区，使用 uri.path 进行比较
    if (isRemote) {
      const workspaceRoot = workspaceFolder.uri.path;
      if (filePath.startsWith(workspaceRoot + '/')) {
        return filePath.substring(workspaceRoot.length + 1);
      } else if (filePath === workspaceRoot) {
        return '';
      }
      continue;
    }
    
    // 对于本地工作区，使用 fsPath 进行比较
    const workspaceFsPath = workspaceFolder.uri.fsPath;
    
    // 规范化路径以便比较：仅 Windows 文件系统不区分大小写才做小写归一，
    // 其余平台保持大小写敏感，避免把大小写不同的路径宽松误判为属于工作区
    // （与 matchGlobPattern/validateFileInWorkspace 的平台判断口径一致）
    const normalizeForCompare = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const normalizedFilePath = normalizeForCompare(filePath.replace(/\\/g, '/'));
    const normalizedWorkspacePath = normalizeForCompare(workspaceFsPath.replace(/\\/g, '/'));
    
    // 计算相对路径
    if (normalizedFilePath.startsWith(normalizedWorkspacePath + '/')) {
      return filePath.substring(workspaceFsPath.length + 1).replace(/\\/g, '/');
    } else if (normalizedFilePath === normalizedWorkspacePath) {
      return '';
    }
  }
  
  // 回退到 node 的 path.relative（仅适用于本地路径，以第一个根为基准）
  const workspaceFsPath = workspaceFolders[0].uri.fsPath;
  const relativePath = path.relative(workspaceFsPath, filePath);
  
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    // 文件不在任何工作区内，抛出错误防止调用方误用
    throw new Error(t('webview.errors.fileNotInAnyWorkspace'));
  }
  
  return relativePath.replace(/\\/g, '/');
}

/**
 * 检查文件是否存在
 */
export async function checkFileExists(relativePath: string, workspaceUri: string): Promise<boolean> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return false;
    }
    
    const workspaceFolder = workspaceFolders.find(f => f.uri.toString() === workspaceUri);
    if (!workspaceFolder) {
      return false;
    }
    
    const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
    
    try {
      const stat = await vscode.workspace.fs.stat(fileUri);
      return stat.type === vscode.FileType.File;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * 验证文件是否在工作区内
 */
export async function validateFileInWorkspace(filePath: string, workspaceUri?: string): Promise<{
  valid: boolean;
  relativePath?: string;
  workspaceUri?: string;
  error?: string;
  errorCode?: 'NO_WORKSPACE' | 'WORKSPACE_NOT_FOUND' | 'INVALID_URI' | 'NOT_FILE' | 'FILE_NOT_EXISTS' | 'NOT_IN_ANY_WORKSPACE' | 'NOT_IN_CURRENT_WORKSPACE' | 'UNKNOWN';
}> {
  try {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return { valid: false, error: t('webview.errors.noWorkspaceOpen'), errorCode: 'NO_WORKSPACE' };
    }
    
    let fileUri: vscode.Uri;
    
    // 支持 file:// 和 vscode-remote:// URI 格式
    if (filePath.startsWith('file://') || filePath.startsWith('vscode-remote://')) {
      try {
        fileUri = vscode.Uri.parse(filePath);
      } catch (e: any) {
        return { valid: false, error: t('webview.errors.invalidFileUri'), errorCode: 'INVALID_URI' };
      }
    } else if (path.isAbsolute(filePath)) {
      fileUri = vscode.Uri.file(filePath);
    } else {
      const targetWorkspace = workspaceUri
        ? workspaceFolders.find(f => f.uri.toString() === workspaceUri)
        : workspaceFolders[0];
      if (!targetWorkspace) {
        return { valid: false, error: t('webview.errors.workspaceNotFound'), errorCode: 'WORKSPACE_NOT_FOUND' };
      }
      fileUri = vscode.Uri.joinPath(targetWorkspace.uri, filePath);
    }
    
    // 检查文件是否存在
    try {
      const stat = await vscode.workspace.fs.stat(fileUri);
      if (stat.type !== vscode.FileType.File) {
        return { valid: false, error: t('webview.errors.pathNotFile'), errorCode: 'NOT_FILE' };
      }
    } catch (e: any) {
      return { valid: false, error: t('webview.errors.fileNotExists'), errorCode: 'FILE_NOT_EXISTS' };
    }
    
    // realpath 感知的归属判定：先解析符号链接再做前缀比较，防止工作区内 symlink 指向
    // 工作区外文件时被词法前缀匹配误判为属于工作区（与 workspaceRealpath.ts 的
    // isUriInsideWorkspaceRealpath 同一实现口径）。realpath 不可用（如测试 mock 掉 fs）
    // 或路径不可解析（远程 scheme/不存在路径）时内部自动降级为词法比较，保持既有行为。
    let belongingWorkspace: vscode.WorkspaceFolder | undefined;
    for (const folder of workspaceFolders) {
      if (await isPathInsideOrEqual(fileUri.fsPath, folder.uri.fsPath)) {
        belongingWorkspace = folder;
        break;
      }
    }
    
    if (!belongingWorkspace) {
      return {
        valid: false,
        error: t('webview.errors.fileNotInAnyWorkspace'),
        errorCode: 'NOT_IN_ANY_WORKSPACE'
      };
    }
    
    if (workspaceUri && belongingWorkspace.uri.toString() !== workspaceUri) {
      // 同样需要检查路径匹配（scheme 可能不同）
      // 注意：workspaceUri 可能来自旧数据/外部输入，不能假设它是合法 URI。
      // Uri.parse 遇到非法 scheme（如反斜杠路径、含非法字符的字符串）会抛
      // [UriError]: Scheme contains illegal characters；解析失败时跳过比对，
      // 避免把本应合法的文件误判为“属于其他工作区”。
      let providedWorkspacePath: string | undefined;
      try {
        if (/^[a-zA-Z]:[\\/]/.test(workspaceUri)) {
          // 旧格式的 Windows 绝对路径（C:\...）：按文件路径语义解析，
          // 否则 Uri.parse 会得到 scheme='c'、path='\...' 的错误结果，比对必然失败
          providedWorkspacePath = vscode.Uri.file(workspaceUri).path;
        } else {
          providedWorkspacePath = vscode.Uri.parse(workspaceUri).path;
        }
      } catch {
        // 解析失败：跳过归属比对，不误杀合法文件
        providedWorkspacePath = belongingWorkspace.uri.path;
      }
      if (providedWorkspacePath !== undefined) {
        // 比对前统一规范化：Windows 文件系统大小写不敏感，直接比对 URI path
        // 会把大小写不同的同一路径误判为“属于其他工作区”（F14）。
        const normalizeForCompare = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
        if (normalizeForCompare(belongingWorkspace.uri.path) !== normalizeForCompare(providedWorkspacePath)) {
          const belongingWorkspaceName = belongingWorkspace.name;
          return {
            valid: false,
            error: t('webview.errors.fileInOtherWorkspace', { workspaceName: belongingWorkspaceName }),
            errorCode: 'NOT_IN_CURRENT_WORKSPACE'
          };
        }
      }
    }
    
    // 计算相对路径
    const workspacePath = belongingWorkspace.uri.path;
    const fileFsPath = fileUri.path;
    let relativePath: string;
    
    if (fileFsPath.startsWith(workspacePath + '/')) {
      relativePath = fileFsPath.substring(workspacePath.length + 1);
    } else if (fileFsPath === workspacePath) {
      relativePath = '';
    } else {
      // 回退到 VSCode API
      relativePath = vscode.workspace.asRelativePath(fileUri, false);
    }
    
    return {
      valid: true,
      relativePath,
      workspaceUri: belongingWorkspace.uri.toString()
    };
  } catch (error: any) {
    return { valid: false, error: error.message, errorCode: 'UNKNOWN' };
  }
}
