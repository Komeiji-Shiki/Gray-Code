/**
 * isUriInsideWorkspace 纯路径包含性校验 单元测试
 *
 * 覆盖：
 * - 工作区内 URI 返回 true
 * - 工作区外 URI 返回 false
 * - 路径穿越 `..` 被识别为越界
 * - 无工作区时返回 false
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { isUriInsideWorkspace } from '../../../webview/handlers/FileHandlers';

describe('isUriInsideWorkspace', () => {
    const workspaceRoot = path.resolve('/workspace/project');

    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace as any).workspaceFolders = [{
            name: 'project',
            uri: vscode.Uri.file(workspaceRoot)
        }];
    });

    it('returns true for a file inside the workspace', () => {
        const fileUri = vscode.Uri.file(path.join(workspaceRoot, 'src', 'index.ts'));
        expect(isUriInsideWorkspace(fileUri)).toBe(true);
    });

    it('returns true for the workspace root itself', () => {
        const rootUri = vscode.Uri.file(workspaceRoot);
        expect(isUriInsideWorkspace(rootUri)).toBe(true);
    });

    it('returns false for a file outside the workspace (e.g. /tmp)', () => {
        const outsideUri = vscode.Uri.file('/tmp/secret.txt');
        expect(isUriInsideWorkspace(outsideUri)).toBe(false);
    });

    it('returns false for a path-traversal escape via ..', () => {
        // 模拟 joinPath 产出的越界 URI
        const escapedUri = vscode.Uri.file(path.resolve(workspaceRoot, '..', '..', 'etc', 'passwd'));
        expect(isUriInsideWorkspace(escapedUri)).toBe(false);
    });

    it('returns false when no workspace folders are open', () => {
        (vscode.workspace as any).workspaceFolders = undefined;
        const fileUri = vscode.Uri.file(path.join(workspaceRoot, 'src', 'index.ts'));
        expect(isUriInsideWorkspace(fileUri)).toBe(false);
    });

    it('returns true when vscode.workspace.getWorkspaceFolder API recognizes the URI', () => {
        const fileUri = vscode.Uri.file(path.join(workspaceRoot, 'lib', 'utils.ts'));
        (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue({
            name: 'project',
            uri: vscode.Uri.file(workspaceRoot)
        });
        expect(isUriInsideWorkspace(fileUri)).toBe(true);
        expect(vscode.workspace.getWorkspaceFolder).toHaveBeenCalledWith(fileUri);
    });

    it('falls back to fsPath prefix when getWorkspaceFolder returns undefined', () => {
        const fileUri = vscode.Uri.file(path.join(workspaceRoot, 'nested', 'deep', 'file.json'));
        (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(undefined);
        expect(isUriInsideWorkspace(fileUri)).toBe(true);
    });

    it('returns false for a sibling directory (prefix match false positive prevention)', () => {
        // /workspace/project-2 should NOT match if workspace is /workspace/project
        const siblingUri = vscode.Uri.file(path.join('/workspace', 'project-2', 'file.ts'));
        (vscode.workspace.getWorkspaceFolder as jest.Mock).mockReturnValue(undefined);
        expect(isUriInsideWorkspace(siblingUri)).toBe(false);
    });
});
