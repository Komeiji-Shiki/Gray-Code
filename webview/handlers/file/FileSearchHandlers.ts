/**
 * 工作区文件搜索消息处理器
 *
 * 拆分自 FileHandlers.ts 域 I：searchWorkspaceFiles 及配套的
 * EXCLUDED_DIRS / MAX_SEARCH_RESULTS / sanitizeGlobQuery / searchDirectories。
 */

import { MESSAGE_NAMES } from '../../../shared/protocol';
import * as vscode from 'vscode';
import * as path from 'path';
import { t } from '../../../backend/i18n';
import type { MessageHandler } from '../../types';

// ========== 工作区文件搜索 ==========

// 排除的目录模式
const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 
  '.vscode', '.idea', '__pycache__', '.cache', 'coverage'
]);

/** searchWorkspaceFiles 结果数量上限：webview 传入的 limit 会被钳制到该值以内 */
const MAX_SEARCH_RESULTS = 200;

/**
 * 过滤 glob 元字符（[ ] { } * ? 等）。
 *
 * query 会被拼入 vscode.workspace.findFiles 的 glob 模式（通配前缀 + query + 通配后缀），
 * 直接透传会破坏模式结构（如 query="[" 产生非法字符类、query="*" 退化成全匹配）。
 * 采用剥离而非转义：VS Code glob 用反斜杠转义，在 Windows 上与路径分隔符冲突，剥离最稳妥。
 */
function sanitizeGlobQuery(query: string): string {
  return typeof query === 'string' ? query.replace(/[\\[\]{}()*+?$|!@]/g, '') : '';
}

// 递归搜索文件夹（子目录并行遍历，避免逐目录串行 await 的深度遍历）
async function searchDirectories(
  baseUri: vscode.Uri, 
  query: string, 
  limit: number,
  results: { path: string; name: string; isDirectory: boolean }[],
  currentPath: string = ''
): Promise<void> {
  if (results.length >= limit) return;
  
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(baseUri);
  } catch {
    // 忽略无法访问的目录
    return;
  }
  
  const normalizedQuery = query.toLowerCase();
  const subDirectoryPromises: Promise<void>[] = [];
  for (const [name, type] of entries) {
    // 跳过排除的目录
    if (EXCLUDED_DIRS.has(name.toLowerCase())) continue;
    
    const relativePath = currentPath ? `${currentPath}/${name}` : name;
    
    if (type === vscode.FileType.Directory) {
      const nameMatches = !normalizedQuery || name.toLowerCase().includes(normalizedQuery);
      if (nameMatches) {
        if (results.length >= limit) break;
        results.push({
          path: relativePath,
          name,
          isDirectory: true
        });
      }
      
      // 有查询时只递归匹配目录，避免对每个不相关目录做深度五层的全量扫描。
      const depth = relativePath.split('/').length;
      if (depth < 5 && (!normalizedQuery || nameMatches)) {
        const subUri = vscode.Uri.joinPath(baseUri, name);
        subDirectoryPromises.push(searchDirectories(subUri, query, limit, results, relativePath));
      }
    }
  }
  await Promise.all(subDirectoryPromises);
}

export const searchWorkspaceFiles: MessageHandler = async (data, requestId, ctx) => {
  try {
    const { query: rawQuery = '', limit: rawLimit = 50 } = data || {};

    // 钳制 limit：webview 传入值不可信，防止一次请求遍历/返回海量结果
    const requestedLimit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 50;
    const limit = Math.min(Math.max(requestedLimit, 1), MAX_SEARCH_RESULTS);

    // 过滤 glob 元字符并 trim，避免 query 破坏 findFiles 模式
    const query = sanitizeGlobQuery(rawQuery).trim();
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    
    if (!workspaceFolder) {
      ctx.sendResponse(requestId, { files: [], activeFilePath: null });
      return;
    }
    
    const results: { path: string; name: string; isDirectory: boolean; isOpen?: boolean }[] = [];
    const addedPaths = new Set<string>();
    const openPaths = new Set<string>(); // 记录所有已打开的文件路径
    
    // 获取当前活跃编辑器的文件路径（相对路径）
    let activeFilePath: string | null = null;
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && !activeEditor.document.isUntitled) {
      const activeUri = activeEditor.document.uri;
      // 检查文件是否在工作区内
      if (vscode.workspace.getWorkspaceFolder(activeUri) === workspaceFolder) {
        activeFilePath = vscode.workspace.asRelativePath(activeUri);
      }
    }
    
    // 收集所有已打开的标签页文件路径
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        if (tab.input instanceof vscode.TabInputText) {
          const uri = tab.input.uri;
          // 检查文件是否在工作区内
          if (vscode.workspace.getWorkspaceFolder(uri) === workspaceFolder) {
            const relativePath = vscode.workspace.asRelativePath(uri);
            openPaths.add(relativePath);
          }
        }
      }
    }
    
    // 如果没有搜索查询，优先显示已打开的标签页
    if (!query) {
      // 收集所有打开的标签页文件
      const openFiles: { path: string; name: string; isDirectory: boolean; isActive: boolean }[] = [];
      
      for (const tabGroup of vscode.window.tabGroups.all) {
        for (const tab of tabGroup.tabs) {
          if (tab.input instanceof vscode.TabInputText) {
            const uri = tab.input.uri;
            // 检查文件是否在工作区内
            if (vscode.workspace.getWorkspaceFolder(uri) === workspaceFolder) {
              const relativePath = vscode.workspace.asRelativePath(uri);
              if (!addedPaths.has(relativePath)) {
                addedPaths.add(relativePath);
                const isActive = activeFilePath === relativePath;
                openFiles.push({
                  path: relativePath,
                  name: path.basename(uri.fsPath),
                  isDirectory: false,
                  isActive
                });
              }
            }
          }
        }
      }
      
      // 排序：当前活跃文件在最前，其他按路径排序
      openFiles.sort((a, b) => {
        if (a.isActive !== b.isActive) {
          return a.isActive ? -1 : 1;
        }
        return a.path.localeCompare(b.path);
      });
      
      // 添加已打开的文件到结果
      for (const file of openFiles) {
        if (results.length >= limit) break;
        results.push({
          path: file.path,
          name: file.name,
          isDirectory: false,
          isOpen: true
        });
      }
    }
    
    // 无查询时只返回已打开标签页：跳过目录递归扫描与 findFiles 全工作区扫描
    // （大工作区下每次打开文件选择器都全目录深度 5 扫描 + findFiles('**/*') 会卡数秒）
    if (query) {
      // 1. 搜索文件夹
      const folderResults: { path: string; name: string; isDirectory: boolean }[] = [];
      await searchDirectories(workspaceFolder.uri, query, Math.floor(limit / 2), folderResults);
      
      // 添加文件夹（排除已添加的）
      for (const folder of folderResults) {
        if (results.length >= limit) break;
        if (!addedPaths.has(folder.path)) {
          addedPaths.add(folder.path);
          results.push(folder);
        }
      }
      
      // 2. 搜索文件
      const pattern = `**/*${query}*`;
      const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**,**/out/**,**/.vscode/**,**/.idea/**,**/__pycache__/**,**/.cache/**,**/coverage/**}';
      const files = await vscode.workspace.findFiles(pattern, excludePattern, limit * 2); // 获取更多以便过滤
      
      // 添加文件结果（排除已添加的）
      for (const uri of files) {
        if (results.length >= limit) break;
        const relativePath = vscode.workspace.asRelativePath(uri);
        if (!addedPaths.has(relativePath)) {
          addedPaths.add(relativePath);
          results.push({
            path: relativePath,
            name: path.basename(uri.fsPath),
            isDirectory: false,
            isOpen: openPaths.has(relativePath)
          });
        }
      }
    }
    
    // 如果有查询，需要重新排序：文件夹在前，然后按路径长度排序
    if (query) {
      results.sort((a, b) => {
        // 文件夹优先
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        // 然后按路径长度
        return a.path.length - b.path.length;
      });
    }
    
    ctx.sendResponse(requestId, { files: results, activeFilePath });
  } catch (error: any) {
    ctx.sendError(requestId, 'SEARCH_FILES_ERROR', error.message || t('webview.errors.searchFilesFailed'));
  }
};

/**
 * 注册工作区文件搜索处理器
 */
export function registerFileSearchHandlers(registry: Map<string, MessageHandler>): void {
  // 工作区文件搜索
  registry.set(MESSAGE_NAMES.searchWorkspaceFiles, searchWorkspaceFiles);
}
