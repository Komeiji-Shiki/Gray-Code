/**
 * 分段历史写入的临时路径必须是 Uri 对象。
 *
 * 回归背景：writeSegmentedHistory 曾用 `getHistoryDir(conversationId) + '.tmp'`，
 * 把 Uri 对象与字符串拼接得到字符串，再传给 vscode.workspace.fs（createDirectory/delete/writeFile/rename）。
 * 扩展宿主把字符串当作 UriComponents 重新解析（URI.from strict 校验），
 * 抛出 [UriError]: Scheme contains illegal characters，导致新建对话/保存历史失败。
 *
 * 本测试锁定：saveHistory 传给 workspace.fs 的所有路径参数都必须是 Uri 对象。
 */

import { FileSystemStorageAdapter } from '../../modules/conversation/storage';
import type { ConversationHistory } from '../../modules/conversation/types';
import { Uri, workspace } from 'vscode';

describe('FileSystemStorageAdapter 分段历史写入 - tmp 路径必须是 Uri 对象', () => {
    const fs = workspace.fs as any;

    beforeEach(() => {
        fs.rename = jest.fn(async () => {});
        fs.createDirectory.mockClear();
        fs.delete.mockClear();
        fs.writeFile.mockClear();
        (fs.rename as jest.Mock).mockClear();
    });

    it('saveHistory 传给 workspace.fs 的所有路径参数必须是 Uri 对象，不能是字符串', async () => {
        const vscode = { Uri, workspace, FileType: { File: 1, Directory: 2 } };
        const adapter = new FileSystemStorageAdapter(vscode as any, 'file:///c%3A/data/graycode');

        const history: ConversationHistory = [
            { role: 'user', parts: [{ text: 'hi' }], isUserInput: true, timestamp: 1 }
        ] as ConversationHistory;
        await adapter.saveHistory('conv_1', history);

        const allCalls: Array<[string, any[][]]> = [
            ['createDirectory', fs.createDirectory.mock.calls],
            ['delete', fs.delete.mock.calls],
            ['writeFile', fs.writeFile.mock.calls],
            ['rename', fs.rename.mock.calls]
        ];

        const totalCalls = allCalls.reduce((n, [, calls]) => n + calls.length, 0);
        expect(totalCalls).toBeGreaterThan(0);

        for (const [method, calls] of allCalls) {
            for (const call of calls) {
                // 第一个参数是路径，必须是 Uri 对象（有 scheme/fsPath），不能是字符串
                expect(typeof call[0]).toBe('object');
                expect(call[0]).not.toBeNull();
                expect(typeof call[0].fsPath).toBe('string');
                expect(call[0].scheme).toBe('file');
            }
        }

        // 临时目录确实被使用，且是 conversation 目录下的兄弟路径（history.tmp）
        const tmpCreate = fs.createDirectory.mock.calls.find((c: any[]) => c[0]?.fsPath?.includes('history.tmp'));
        expect(tmpCreate).toBeTruthy();
        expect(tmpCreate[0].fsPath).toContain('conv_1');
    });

    it('写空历史（新建对话）不抛错且临时 index 也是 Uri 对象', async () => {
        const vscode = { Uri, workspace, FileType: { File: 1, Directory: 2 } };
        const adapter = new FileSystemStorageAdapter(vscode as any, 'file:///c%3A/data/graycode');

        await expect(adapter.saveHistory('conv_empty', [])).resolves.toBeUndefined();

        const tmpIndexWrite = fs.writeFile.mock.calls.find((c: any[]) => c[0]?.fsPath?.includes('history.index.json.tmp'));
        expect(tmpIndexWrite).toBeTruthy();
        expect(typeof tmpIndexWrite[0].fsPath).toBe('string');
    });
});
