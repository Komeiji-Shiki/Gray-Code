/**
 * realpath 感知的工作区路径判定工具
 *
 * 背景：webview 文件处理器（FileReadHandlers / FilePreviewHandlers / FileOpenHandlers /
 * PinnedFileHandlers）运行在扩展宿主进程（Node），此前工作区包含性校验只做词法前缀匹配，
 * 不解析符号链接：工作区内 symlink 指向工作区外文件时会被误判为“在工作区内”而放行
 * （readWorkspaceTextFile / readWorkspaceImage / openWorkspaceFile 等）。
 *
 * 本模块提供 realpath 感知的路径规范化与包含性判定，供上述处理器统一调用。
 * 实现参照后端已确认的正确范式（backend/tools/shared/workspacePaths.ts 的
 * resolveRealpathForComparison）：realpath + 最近存在祖先 + Windows 大小写归一。
 */

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

// 与后端 workspacePaths / matchGlobPattern 口径一致：仅 Windows 文件系统不区分大小写
const IS_WINDOWS = process.platform === 'win32';

/**
 * 去掉 Windows realpath 输出可能带上的长路径前缀（\\?\ 与 \\?\UNC\）。
 *
 * fs.realpath 在 Windows 长路径/UNC 下会返回 \\?\ 前缀路径，直接参与字符串前缀比较会让
 * 同一物理文件出现两种写法（//?/C:/... 与 C:/...），必须统一为普通盘符/UNC 路径形式。
 * POSIX 路径不含该前缀，调用无副作用。
 */
function stripWindowsLongPathPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) {
    return '\\\\' + p.slice(8);
  }
  if (p.startsWith('\\\\?\\')) {
    return p.slice(4);
  }
  return p;
}

/**
 * 将路径解析为用于比较的规范绝对路径（realpath-aware，异步版）。
 *
 * 对路径本身（或其最近的存在祖先）做 realpath 解析后，再拼接不存在的尾部段，把解析结果
 * 用于前缀比较；不存在/无权限/符号链接循环/realpath 实现缺失（如测试 mock 掉的 fs）时
 * 降级为词法路径。不存在的路径会向上找最近的存在祖先，最多一次目录树深度。
 *
 * 与后端 resolveRealpathForComparison 同口径；差异仅在用异步 fs.promises.realpath
 * （这些 handler 均为异步消息处理器，无需同步阻塞扩展宿主）。
 */
export async function resolveRealpathForComparison(fsPath: string): Promise<string> {
  const absolute = path.resolve(fsPath);
  // fs.promises.realpath 可能被测试 mock 掉（jest.mock('fs') 只保留部分 API），缺失时降级词法路径
  const realpath = (fs.promises as any)?.realpath;
  if (typeof realpath !== 'function') {
    return absolute;
  }

  let current = absolute;
  const tail: string[] = [];
  while (true) {
    try {
      const real = (await realpath(current)) as string;
      // tail 经 unshift 构建：unshift 把后失败（更浅）的段放数组前，故 tail 已是
      // 「浅→深」的正确拼接顺序（如 ['workspace','project','src','index.ts']）。
      const combined = tail.length === 0 ? real : path.join(real, ...tail);
      return stripWindowsLongPathPrefix(combined);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      // 只有“路径不存在”才向上找最近的已存在祖先；无权限（EACCES）、符号链接循环
      // （ELOOP）等其他失败直接降级词法路径，避免把不可解析路径误判为真实路径。
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return absolute;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * 归一化路径用于前缀比较：realpath + 正斜杠 + Windows 小写归一 + 去尾部斜杠。
 */
export async function normalizePathForComparison(fsPath: string): Promise<string> {
  let normalized = (await resolveRealpathForComparison(fsPath)).replace(/\\/g, '/');
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}

/**
 * 判断 childPath 是否位于 parentPath 内或等于 parentPath（均按 realpath 归一后比较）。
 */
export async function isPathInsideOrEqual(childPath: string, parentPath: string): Promise<boolean> {
  const child = await normalizePathForComparison(childPath);
  const parent = await normalizePathForComparison(parentPath);
  return child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

/**
 * realpath 感知的工作区包含性校验：判断 URI 是否位于任意已打开的工作区内。
 *
 * 与 fileHandlerUtils.isUriInsideWorkspace（纯词法、不 stat）不同：本函数先解析符号链接
 * 再做前缀比较，可阻止工作区内 symlink 指向工作区外文件的绕过。realpath 不可用（如测试
 * mock 掉 fs）或路径不可解析时内部自动降级为词法比较，保持与既有行为兼容。
 *
 * 注意：vscode.workspace.getWorkspaceFolder 本身也是词法前缀匹配（不解析 symlink），
 * 不能单独作为放行依据，因此这里一律对文件与各工作区根做 realpath 归一后比较。
 */
export async function isUriInsideWorkspaceRealpath(uri: vscode.Uri): Promise<boolean> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return false;

  const fsPath = uri.fsPath;
  for (const folder of folders) {
    if (await isPathInsideOrEqual(fsPath, folder.uri.fsPath)) {
      return true;
    }
  }
  return false;
}
