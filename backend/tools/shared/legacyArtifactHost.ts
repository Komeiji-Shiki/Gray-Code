import * as vscode from 'vscode';
import path from 'node:path';
import { getAllWorkspaces, resolveUriWithInfo } from '../utils';
import { withArtifactHost, type ArtifactDocumentHost } from './artifactHost';
import type { Tool } from '../types';
const legacyArtifactHost: ArtifactDocumentHost = {
  resolve: resolveUriWithInfo, workspaces: getAllWorkspaces,
  read: async target => vscode.workspace.fs.readFile(target as vscode.Uri),
  write: async (target, bytes) => { await vscode.workspace.fs.writeFile(target as vscode.Uri, bytes); },
  stat: async target => vscode.workspace.fs.stat(target as vscode.Uri),
  prepareParent: async target => { await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target))); },
};
/** 工具工厂返回后仍保留扩展宿主；异步回调由调用作用域隔离。 */
export function withLegacyArtifactHost<T>(action: () => T): T {
  return withArtifactHost(legacyArtifactHost, () => {
    const value = action();
    if (value && typeof value === 'object' && 'handler' in value && typeof value.handler === 'function') {
      // 只收窄已经检查过的处理函数，不假定任意工厂结果都包含完整工具声明。
      const tool = value as T & Pick<Tool, 'handler'>;
      return { ...tool, handler: (...args: Parameters<Tool['handler']>) => withArtifactHost(legacyArtifactHost, () => tool.handler(...args)) } as T;
    }
    return value;
  });
}
