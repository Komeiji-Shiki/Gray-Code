import type { FileHandle } from 'node:fs/promises';
import { readRecordBuffer } from '../../modules/memory/recordIO';
import { pad } from '../../modules/memory/logFormat';

describe('平台记忆导入的部分读取', () => {
    test('文件每次只返回部分缓冲区时仍保留全部记录', async () => {
        const values = ['第一条', '第二条', '第三条', '第四条'];
        const original = Buffer.concat(values.map((text, id) => pad(`#${id} 2026-09-26 ${text}`, 1024)));
        const file = {
            read: async (buffer: Buffer, offset: number, length: number, position: number) => {
                const bytesRead = Math.min(length, 1024, original.length - position);
                original.copy(buffer, offset, position, position + bytesRead);
                return { bytesRead, buffer };
            },
        } as unknown as FileHandle;
        const result = Buffer.alloc(original.length);
        await readRecordBuffer(file, result, 0);
        expect(result).toEqual(original);
    });
});
