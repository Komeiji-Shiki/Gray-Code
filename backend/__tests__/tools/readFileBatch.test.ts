import * as path from 'path';
import * as vscode from 'vscode';
import { createReadFileTool } from '../../tools/file/read_file';

const encoder = new TextEncoder();

function workspaceFilePath(relativePath: string): string {
    return path.join(path.resolve('/workspace/project'), relativePath);
}

describe('read_file batch requests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace as any).workspaceFolders = [{
            name: 'project',
            uri: vscode.Uri.file(path.resolve('/workspace/project'))
        }];

        (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 64, type: vscode.FileType.File });
        (vscode.workspace.fs.readFile as jest.Mock).mockImplementation(async (uri: { fsPath: string }) => {
            if (uri.fsPath === workspaceFilePath('a.txt')) {
                return encoder.encode('a1\na2\na3');
            }
            if (uri.fsPath === workspaceFilePath('b.txt')) {
                return encoder.encode('b1\nb2\nb3\nb4');
            }
            throw new Error('ENOENT');
        });
    });

    test('declaration exposes legacy path and batch files forms', () => {
        const declaration = createReadFileTool().declaration as any;

        expect(declaration.parameters.properties.path.type).toBe('string');
        expect(declaration.parameters.properties.files.type).toBe('array');
        expect(declaration.parameters.properties.files.items.required).toEqual(['path']);
        expect(declaration.description).toContain('一个或多个文件');
    });

    test('keeps the existing single-path call compatible', async () => {
        const result = await createReadFileTool().handler({
            path: 'a.txt',
            startLine: 2,
            endLine: 3
        }) as any;

        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({ successCount: 1, failCount: 0, totalCount: 1 });
        expect(result.data.results[0]).toMatchObject({
            path: 'a.txt',
            startLine: 2,
            endLine: 3,
            content: '   2 | a2\n   3 | a3'
        });
    });

    test('treats an empty files default as absent when path is provided', async () => {
        const result = await createReadFileTool().handler({
            path: 'a.txt',
            files: [],
            startLine: 1,
            endLine: 1
        }) as any;

        expect(result.success).toBe(true);
        expect(result.data.results[0]).toMatchObject({
            path: 'a.txt',
            content: '   1 | a1'
        });
    });

    test('reads multiple files in input order with independent line ranges', async () => {
        const result = await createReadFileTool().handler({
            files: [
                { path: 'a.txt', startLine: 1, endLine: 1 },
                { path: 'b.txt', startLine: 3, endLine: 4 }
            ]
        }) as any;

        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({ successCount: 2, failCount: 0, totalCount: 2 });
        expect(result.data.results.map((item: any) => item.path)).toEqual(['a.txt', 'b.txt']);
        expect(result.data.results[0].content).toBe('   1 | a1');
        expect(result.data.results[1].content).toBe('   3 | b3\n   4 | b4');
    });

    test('preserves successful results when one batch item fails', async () => {
        const result = await createReadFileTool().handler({
            files: [{ path: 'a.txt' }, { path: 'missing.txt' }]
        }) as any;

        expect(result.success).toBe(false);
        expect(result.error).toBe('1 file failed to read');
        expect(result.data).toMatchObject({ successCount: 1, failCount: 1, totalCount: 2 });
        expect(result.data.results[0].success).toBe(true);
        expect(result.data.results[1]).toMatchObject({ path: 'missing.txt', success: false, error: 'ENOENT' });
    });

    test('rejects empty batches and ambiguous mixed forms', async () => {
        const tool = createReadFileTool();
        const empty = await tool.handler({ files: [] }) as any;
        const mixed = await tool.handler({ path: 'a.txt', files: [{ path: 'b.txt' }] }) as any;

        expect(empty).toMatchObject({ success: false, error: 'files must contain at least one file request.' });
        expect(mixed).toMatchObject({ success: false, error: 'Provide either path or files, not both.' });
        expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    });

    it('rejects batches with more than 20 files', async () => {
        const files = Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.txt` }));
        const result = await createReadFileTool().handler({ files }) as any;

        expect(result.success).toBe(false);
        expect(result.error).toContain('Too many files requested (21)');
        expect(result.error).toContain('20');
        expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    });

    it('rejects batches whose total size exceeds the byte budget', async () => {
        // 每个文件 30MB，两个文件合计 60MB > 50MB 预算
        (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({
            size: 30 * 1024 * 1024,
            type: vscode.FileType.File
        });

        const result = await createReadFileTool().handler({
            files: [{ path: 'a.txt' }, { path: 'b.txt' }]
        }) as any;

        expect(result.success).toBe(false);
        expect(result.error).toContain('exceeds the limit');
        expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    });
});
