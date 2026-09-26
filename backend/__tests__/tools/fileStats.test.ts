import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import { countTextFileLines } from '../../tools/shared/fileStats';
import { MAX_LINE_COUNT_FILE_BYTES } from '../../tools/shared/fileSizeGuards';

jest.mock('fs/promises', () => ({ open: jest.fn() }));

const openMock = fsp.open as jest.Mock;
const statMock = vscode.workspace.fs.stat as jest.Mock;
const readFileMock = vscode.workspace.fs.readFile as jest.Mock;
const local = { scheme: 'file', fsPath: '/fixture/sample.txt' } as vscode.Uri;
const remote = { scheme: 'memfs', path: '/sample.txt' } as vscode.Uri;

function mockChunks(bytes: Buffer, chunkSize = 64 * 1024) {
    let offset = 0;
    const read = jest.fn(async (buffer: Buffer, _start: number, length: number) => {
        const bytesRead = Math.min(length, chunkSize, bytes.length - offset);
        bytes.copy(buffer, 0, offset, offset + bytesRead);
        offset += bytesRead;
        return { bytesRead };
    });
    const close = jest.fn(async () => {});
    openMock.mockResolvedValue({ read, close });
    statMock.mockResolvedValue({ size: bytes.length });
    readFileMock.mockResolvedValue(bytes);
    return { read, close };
}

beforeEach(() => { jest.resetAllMocks(); });

test.each([
    ['', 1], ['one', 1], ['one\n', 1], ['\n\n', 2], ['one\n\n', 2],
    ['首😀\r\n尾\r\n', 2], ['首\r尾\r', 2], ['首\r尾', 2],
] as Array<[string, number]>)('扩展本地与远程计数沿用读取约定：%j', async (text, expected) => {
    const handle = mockChunks(Buffer.from(text), 1);
    expect(await countTextFileLines(local, 'sample.txt')).toBe(expected);
    expect(readFileMock).not.toHaveBeenCalled();
    if (text) expect(handle.close).toHaveBeenCalledTimes(1);
    expect(await countTextFileLines(remote, 'sample.txt')).toBe(expected);
});

test.each([
    ['CRLF 跨块', 'x'.repeat(64 * 1024 - 1) + '\r\n尾\r', 2],
    ['多字节跨块', 'x'.repeat(64 * 1024 - 1) + '中😀\n尾', 2],
])('扩展流式统计：%s', async (_name, text, expected) => {
    const handle = mockChunks(Buffer.from(text as string));
    expect(await countTextFileLines(local, 'sample.txt')).toBe(expected);
    expect(handle.read).toHaveBeenCalledTimes(3);
    expect(handle.read.mock.calls.every(call => call[2] === 64 * 1024)).toBe(true);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
});

test('二进制、超限与读取失败不提供行数，并保持大小护栏', async () => {
    expect(await countTextFileLines(local, 'sample.png')).toBeUndefined();
    expect(statMock).not.toHaveBeenCalled();
    statMock.mockResolvedValue({ size: MAX_LINE_COUNT_FILE_BYTES + 1 });
    expect(await countTextFileLines(local, 'sample.txt')).toBeUndefined();
    expect(await countTextFileLines(remote, 'sample.txt')).toBeUndefined();
    expect(openMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();

    const handle = mockChunks(Buffer.from('one\n'));
    handle.read.mockRejectedValueOnce(new Error('read failed'));
    expect(await countTextFileLines(local, 'sample.txt')).toBeUndefined();
    expect(handle.close).toHaveBeenCalledTimes(1);
});

test('stat 后文件增长仍停止统计，远程读取也不接受超限数据', async () => {
    const handle = mockChunks(Buffer.alloc(MAX_LINE_COUNT_FILE_BYTES + 1, 97));
    statMock.mockResolvedValue({ size: 1 });
    expect(await countTextFileLines(local, 'sample.txt')).toBeUndefined();
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(await countTextFileLines(remote, 'sample.txt')).toBeUndefined();
});
