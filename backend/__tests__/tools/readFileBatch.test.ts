import * as path from 'path';
import { createReadFileTool as createRuntimeReadFileTool } from '../../tools/file/readFileRuntime';
import { createFileToolHostMock } from '../__fixtures__/mockFixtures';
import { normalizeToolArgs } from '../../tools/coerceToolArgs';
import * as iconv from 'iconv-lite';

const encoder = new TextEncoder();
const GBK_SCRIPT = '@echo off\r\nrem 启动游戏并等待退出\r\necho 正在运行\r\n';
const { host, setWorkspaces } = createFileToolHostMock();
const createReadFileTool = () => createRuntimeReadFileTool(host);

function workspaceFilePath(relativePath: string): string {
    return path.join(path.resolve('/workspace/project'), relativePath).replaceAll('\\', '/');
}

describe('read_file batch requests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        setWorkspaces([{ name: 'project', fsPath: path.resolve('/workspace/project') }]);

        host.stat.mockResolvedValue({ size: 64, type: 1 });
        host.readFile.mockImplementation(async (value: unknown) => {
            const uri = value as { fsPath: string };
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
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
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
        expect(result.data.results[1]).toMatchObject({ path: 'missing.txt', success: false, error: 'ENOENT', displayErrorCode: 'ENOENT' });
    });

    test('捕获真实 code 而非从错误文本猜测，原始错误说明保持原样', async () => {
        host.readFile.mockRejectedValueOnce(Object.assign(new Error('无法读取当前文件'), { code: 'EACCES' }));
        const coded = await createReadFileTool().handler({ path: 'a.txt' });
        expect(coded.data.results[0]).toMatchObject({ error: '无法读取当前文件', displayErrorCode: 'EACCES' });
        host.readFile.mockRejectedValueOnce(new Error('ENOENT: text without a code property'));
        const plain = await createReadFileTool().handler({ path: 'a.txt' });
        expect(plain.data.results[0].error).toBe('ENOENT: text without a code property');
        expect(plain.data.results[0]).not.toHaveProperty('displayErrorCode');
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
        expect(host.readFile).not.toHaveBeenCalled();
    });

    test('空路径只影响该项，超过批量上限的文件逐项列出且不读取', async () => {
        const files = [{ path: '' }, ...Array.from({ length: 22 }, () => ({ path: 'a.txt' }))];
        const result = await createReadFileTool().handler({ files }) as any;
        expect(result).toMatchObject({ success: false, data: {
            requestedCount: 23, processedCount: 20, totalCount: 23, successCount: 19, failCount: 1, skippedCount: 3,
            partial: true, truncated: true, omittedPaths: ['a.txt', 'a.txt', 'a.txt'],
        } });
        expect(result.data.results[0]).toMatchObject({ index: 0, success: false });
        expect(result.data.results.slice(20)).toEqual([20, 21, 22].map(index => expect.objectContaining({
            index, path: 'a.txt', success: false, skipped: true, code: 'BATCH_LIMIT',
        })));
        expect(host.readFile).toHaveBeenCalledTimes(19);
    });

    test('附件预算超限的文件不计成功，仍保留已提供附件及准确的重试路径', async () => {
        const bytes = Buffer.alloc(5 * 1024 * 1024);
        host.stat.mockResolvedValue({ size: bytes.length, type: 1 });
        host.readFile.mockResolvedValue(bytes);
        const result = await createReadFileTool().handler({ files: Array.from({ length: 5 }, (_, index) => ({ path: `${index}.pdf` })) }, {
            multimodalEnabled: true, capability: { supportsImages: true, supportsDocuments: true, supportsHistoryMultimodal: true },
        }) as any;
        expect(result).toMatchObject({ success: false, data: {
            requestedCount: 5, processedCount: 5, successCount: 4, failCount: 0, skippedCount: 1,
            partial: true, multimodalTruncated: true, omittedPaths: ['4.pdf'],
        } });
        expect(result.data.results[4]).toMatchObject({ index: 4, path: '4.pdf', success: false, skipped: true, code: 'MULTIMODAL_BUDGET' });
        expect(result.multimodal).toHaveLength(4);
    });
});
