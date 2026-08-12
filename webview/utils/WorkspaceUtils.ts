/**
 * 工作区工具函数
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { t } from '../../backend/i18n';
import { getWorkspaceManager } from './WorkspaceManager';
import { getFsCaseSensitivity } from './fsCaseSensitivity';
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
    const regexPattern = normalizedPattern
      .replace(/\*\*/g, GLOBSTAR)
      .replace(/\*/g, STAR)
      .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
      .replace(new RegExp(GLOBSTAR, 'g'), '.*')
      .replace(new RegExp(STAR, 'g'), '[^/]*');
    const regex = new RegExp(`(?:^|/)${regexPattern}(?:$|/)`, 'i');
    return regex.test(filePath.replace(/\\/g, '/'));
  } catch {
    return false;
  }
}

/**
 * 路径等价比对：大小写不敏感文件系统上同一目录以不同大小写路径打开/绑定时
 * 仍视为同一路径（否则绑定 URI 与打开文件夹 URI 大小写漂移时，合法文件会被
 * 误判为「属于其他工作区」）。口径与 WorkspaceManager 一致：运行时探测，
 * 而非仅看平台（macOS APFS / WSL drvfs 默认大小写不敏感）。
 */
function pathsEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const caseSensitive = getWorkspaceManager()?.getFsCaseSensitivity()
    ?? getFsCaseSensitivity(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  if (caseSensitive) return false;
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

/**
 * 获取当前激活工作区 URI
 *
 * 多工作区支持：优先使用 WorkspaceManager 的激活工作区（跟随活动编辑器/用户固定），
 * 管理器未初始化时回退第一个文件夹（旧行为）。
 */
export function getCurrentWorkspaceUri(): string | null {
  const manager = getWorkspaceManager();
  if (manager) {
    return manager.getActiveWorkspaceUri();
  }
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder ? workspaceFolder.uri.toString() : null;
}

/**
 * 将绝对路径或 URI 转换为相对路径
 * 支持 file://, vscode-remote:// URI 格式以及 Windows 绝对路径格式
 *
 * 多工作区支持：在全部已打开工作区中查找包含该路径的文件夹并以其为基准计算相对路径
 * （旧实现固定用第一个文件夹，多工作区下浏览非首个项目的文件会误报"不在工作区内"）。
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
  
  // 在全部工作区中查找包含该路径的文件夹（先 API 后前缀匹配，兼容远程 scheme 差异）
  const findBelongingFolder = (): { folder: vscode.WorkspaceFolder; comparePath: string } | undefined => {
    let best: { folder: vscode.WorkspaceFolder; comparePath: string } | undefined;
    let bestLength = -1;
    for (const folder of workspaceFolders) {
      const rootPath = isRemote ? folder.uri.path : folder.uri.fsPath;
      const normalizedFilePath = filePath.replace(/\\/g, '/').toLowerCase();
      const normalizedRootPath = rootPath.replace(/\\/g, '/').toLowerCase();
      if (normalizedFilePath.startsWith(normalizedRootPath + '/') || normalizedFilePath === normalizedRootPath) {
        // 多个工作区嵌套时取最长匹配（最具体的文件夹）
        if (normalizedRootPath.length > bestLength) {
          bestLength = normalizedRootPath.length;
          best = { folder, comparePath: rootPath };
        }
      }
    }
    return best;
  };
  
  const belonging = findBelongingFolder();
  if (!belonging) {
    // 回退到 node 的 path.relative（仅适用于本地路径）
    const relativePath = path.relative(workspaceFolders[0].uri.fsPath, filePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      // 文件不在任何工作区内，抛出错误防止调用方误用
      throw new Error(t('webview.errors.fileNotInAnyWorkspace'));
    }
    return relativePath.replace(/\\/g, '/');
  }
  
  const rootPath = belonging.comparePath;
  if (filePath.startsWith(rootPath + '/')) {
    return filePath.substring(rootPath.length + 1).replace(/\\/g, '/');
  } else if (filePath === rootPath) {
    return '';
  }
  return path.relative(rootPath, filePath).replace(/\\/g, '/');
}

/**
 * 按 URI 解析工作区文件夹（含已关闭的对话绑定工作区）。
 *
 * 多工作区语义：对话绑定工作区必须独立于“当前打开的工作区”——桌面版切换打开
 * 工作区后绑定工作区会从 workspaceFolders 移除，但对话仍需在该工作区内读写文件。
 * URI 未命中已打开文件夹时，目录仍存在则按 URI 重建虚拟文件夹（index = -1）。
 */
export function resolveWorkspaceFolderByUri(workspaceUri?: string): vscode.WorkspaceFolder | undefined {
  if (!workspaceUri) return undefined;
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders) {
    const open = workspaceFolders.find(f => f.uri.toString() === workspaceUri);
    if (open) return open;
  }
  // 仅处理本地 file 工作区；远程 scheme（vscode-remote:// 等）不做虚拟解析
  if (workspaceUri.includes('://') && !workspaceUri.startsWith('file://')) {
    return undefined;
  }
  try {
    const uri = workspaceUri.startsWith('file://') ? vscode.Uri.parse(workspaceUri) : vscode.Uri.file(workspaceUri);
    if (uri.scheme !== 'file' || !uri.fsPath) return undefined;
    if (!fs.existsSync(uri.fsPath) || !fs.statSync(uri.fsPath).isDirectory()) return undefined;
    return {
      uri,
      name: path.basename(uri.fsPath) || uri.fsPath,
      index: -1,
      fsPath: uri.fsPath
    } as vscode.WorkspaceFolder;
  } catch {
    return undefined;
  }
}

/**
 * 检查文件是否存在
 */
export async function checkFileExists(relativePath: string, workspaceUri: string): Promise<boolean> {
  try {
    const workspaceFolder = resolveWorkspaceFolderByUri(workspaceUri);
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
      // 对话绑定工作区可能已关闭：按 URI 虚拟解析，保证绑定工作区独立
      const targetWorkspace = workspaceUri
        ? resolveWorkspaceFolderByUri(workspaceUri)
        : workspaceFolders?.[0];
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

    // 对话绑定工作区已关闭：按 URI 虚拟解析归属（大小写不敏感比对，兼容 Windows）
    if (!belongingWorkspace && workspaceUri) {
      const virtual = resolveWorkspaceFolderByUri(workspaceUri);
      if (virtual) {
        const normalizedFile = fileUri.fsPath.replace(/\\/g, '/').toLowerCase();
        const normalizedVirtual = (virtual as any).fsPath.replace(/\\/g, '/').toLowerCase();
        if (normalizedFile.startsWith(normalizedVirtual + '/') || normalizedFile === normalizedVirtual) {
          belongingWorkspace = virtual;
        }
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
      if (providedWorkspacePath !== undefined && !pathsEqual(belongingWorkspace.uri.path, providedWorkspacePath)) {
        const belongingWorkspaceName = belongingWorkspace.name;
        return {
          valid: false,
          error: t('webview.errors.fileInOtherWorkspace', { workspaceName: belongingWorkspaceName }),
          errorCode: 'NOT_IN_CURRENT_WORKSPACE'
        };
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
    } else if (belongingWorkspace.index === -1) {
      // 虚拟工作区（已关闭的绑定工作区）：用 fsPath 计算，避免 Uri.file 与
      // Uri.parse 之间盘符大小写差异导致前缀匹配失败
      const rel = path.relative((belongingWorkspace as any).fsPath, fileUri.fsPath);
      relativePath = rel ? rel.replace(/\\/g, '/') : '';
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
