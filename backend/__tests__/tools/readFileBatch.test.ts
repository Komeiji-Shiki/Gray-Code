import * as path from 'path';
import * as vscode from 'vscode';
import { createReadFileTool } from '../../tools/file/read_file';
import { normalizeToolArgs } from '../../tools/coerceToolArgs';
import * as iconv from 'iconv-lite';

const encoder = new TextEncoder();
const GBK_SCRIPT = '@echo off\r\nrem 启动游戏并等待退出\r\necho 正在运行\r\n';

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
            if (uri.fsPath === workspaceFilePath('run.cmd')) {
                return iconv.encode(GBK_SCRIPT, 'gbk');
            }
            if (uri.fsPath === workspaceFilePath('wide.txt')) {
                return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('宽字符\n第二行', 'utf16le')]);
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
        const tool = createReadFileTool();
        const { args, warnings } = normalizeToolArgs('read_file', {
            file_path: 'a.txt',
            startLine: 2,
            endLine: 3
        }, tool.declaration.parameters, { paramAliases: tool.declaration.paramAliases });
        expect(warnings.join(' ')).toContain('`file_path`');
        const result = await tool.handler(args) as any;

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
        expect(result.data).toMatchObject({ successCount: 1, failCount: 1, totalCount: 2, partial: true });
        expect(result.data.results[0].success).toBe(true);
        expect(result.data.results[1]).toMatchObject({ path: 'missing.txt', success: false, error: 'ENOENT' });
    });

    test('自动识别 GBK 与 UTF-16 并标注编码，UTF-8 结果不增加字段，可显式指定编码', async () => {
        const tool = createReadFileTool();
        expect((tool.declaration.parameters as any).properties.encoding.type).toBe('string');
        expect((tool.declaration.parameters as any).properties.files.items.properties.encoding.type).toBe('string');
        const result = await tool.handler({ files: [{ path: 'run.cmd', startLine: 2, endLine: 3 }, { path: 'wide.txt' }, { path: 'a.txt' }] }) as any;
        expect(result.data.results[0]).toMatchObject({ content: '   2 | rem 启动游戏并等待退出\n   3 | echo 正在运行', encoding: 'gbk', encodingGuessed: true });
        expect(result.data.results[1]).toMatchObject({ content: '   1 | 宽字符\n   2 | 第二行', encoding: 'utf-16le (BOM)' });
        expect(result.data.results[2]).not.toHaveProperty('encoding');
        // 指定编码时不再推测；不支持的编码名只让该文件失败
        const explicit = await tool.handler({ path: 'run.cmd', encoding: 'gb18030', startLine: 2, endLine: 2 }) as any;
        expect(explicit.data.results[0]).toMatchObject({ content: '   2 | rem 启动游戏并等待退出', encoding: 'gb18030' });
        expect(explicit.data.results[0]).not.toHaveProperty('encodingGuessed');
        const invalid = await tool.handler({ files: [{ path: 'run.cmd', encoding: 'klingon' }, { path: 'a.txt' }] }) as any;
        expect(invalid.data.results[0]).toMatchObject({ success: false, error: expect.stringContaining('不支持的编码') });
        expect(invalid.data.results[1].success).toBe(true);
    });

    test('rejects empty batches and ambiguous mixed forms', async () => {
        const tool = createReadFileTool();
        const empty = await tool.handler({ files: [] }) as any;
        const mixed = await tool.handler({ path: 'a.txt', files: [{ path: 'b.txt' }] }) as any;

        expect(empty).toMatchObject({ success: false, error: 'files must contain at least one file request.' });
        expect(mixed).toMatchObject({ success: false, error: 'Provide either path or files, not both.' });
        expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    });
});
