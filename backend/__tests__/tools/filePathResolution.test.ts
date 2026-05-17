import * as path from 'path';
import * as vscode from 'vscode';
import { resolveFileToolPathWithInfo } from '../../tools/utils';

describe('file tool path resolution', () => {
    beforeEach(() => {
        const workspaceRoot = path.resolve('/workspace/project');
        (vscode.workspace as any).workspaceFolders = [{
            name: 'project',
            uri: vscode.Uri.file(workspaceRoot)
        }];
    });

    it('marks normal relative paths as inside workspace', () => {
        const resolved = resolveFileToolPathWithInfo('src/index.ts');

        expect(resolved.uri?.fsPath).toBe(path.join(path.resolve('/workspace/project'), 'src/index.ts'));
        expect(resolved.isOutsideWorkspace).toBe(false);
        expect(resolved.workspace?.name).toBe('project');
    });

    it('marks relative paths escaping the workspace as outside workspace', () => {
        const resolved = resolveFileToolPathWithInfo('../secret.txt');

        expect(resolved.uri?.fsPath).toBe(path.resolve('/workspace/secret.txt'));
        expect(resolved.isOutsideWorkspace).toBe(true);
        expect(resolved.workspace).toBeUndefined();
    });

    it('marks absolute paths outside workspace as outside workspace', () => {
        const resolved = resolveFileToolPathWithInfo(path.resolve('/tmp/outside.txt'));

        expect(resolved.uri?.fsPath).toBe(path.resolve('/tmp/outside.txt'));
        expect(resolved.isOutsideWorkspace).toBe(true);
        expect(resolved.workspace).toBeUndefined();
    });

    it('treats absolute paths inside workspace as workspace files', () => {
        const absolutePath = path.join(path.resolve('/workspace/project'), 'README.md');
        const resolved = resolveFileToolPathWithInfo(absolutePath);

        expect(resolved.uri?.fsPath).toBe(absolutePath);
        expect(resolved.isOutsideWorkspace).toBe(false);
        expect(resolved.workspace?.name).toBe('project');
        expect(resolved.relativePath).toBe('README.md');
    });
});
