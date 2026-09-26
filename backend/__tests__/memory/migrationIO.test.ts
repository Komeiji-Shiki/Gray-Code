import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MemoryManager } from '../../modules/memory/MemoryManager';
import { pad } from '../../modules/memory/logFormat';
import { LOG_REC } from '../../modules/memory/types';

const fsPromises = require('fs/promises') as typeof import('fs/promises');

describe('旧记忆迁移的部分 IO', () => {
    let directory: string;
    beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-migration-io-')); });
    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test.each(['read', 'write'] as const)('文件 %s 只处理部分缓冲区时仍保留全部记录', async operation => {
        const logFile = path.join(directory, 'LOG.txt');
        const values = ['第一条', '第二条', '第三条', '第四条'];
        fs.writeFileSync(logFile, Buffer.concat(values.map((text, id) => pad(`#${id} 2026-09-26 ${text}`, 1024))));
        const originalOpen = fsPromises.open;
        let limited = false;
        jest.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
            const handle = await originalOpen(...args);
            if (operation === 'read' && String(args[0]) === logFile && args[1] === 'r') {
                const read = handle.read.bind(handle);
                jest.spyOn(handle, 'read').mockImplementation(async (...input: any[]) => {
                    if (!limited && input[2] > 2048) {
                        limited = true;
                        return read(input[0], input[1], 1024, input[3]);
                    }
                    return (read as any)(...input);
                });
            }
            if (operation === 'write' && String(args[0]) === `${logFile}.tmp`) {
                const write = handle.write.bind(handle);
                jest.spyOn(handle, 'write').mockImplementation(async (...input: any[]) => {
                    if (!limited) {
                        limited = true;
                        return write(input[0], input[1] ?? 0, 1024, input[3]);
                    }
                    return (write as any)(...input);
                });
            }
            return handle;
        });

        const manager = new MemoryManager(directory);
        await manager.init();
        const entries = await manager.listEntries();
        expect(limited).toBe(true);
        expect(entries.map(entry => entry.text)).toEqual(values);
        expect(fs.statSync(logFile).size).toBe(values.length * LOG_REC);
    });

    test.each(['scan', 'range', 'entries'] as const)('短读不能让 %s 跳过完整记录', async action => {
        const logFile = path.join(directory, 'LOG.txt');
        const values = ['第一条', '第二条', '第三条', '第四条'];
        fs.writeFileSync(logFile, Buffer.concat(values.map((text, id) => pad(`#${id} 2026-09-26 ${text}`, LOG_REC))));
        const originalOpen = fsPromises.open;
        let limited = false;
        jest.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
            const handle = await originalOpen(...args);
            if (String(args[0]) === logFile && args[1] === 'r') {
                const read = handle.read.bind(handle);
                jest.spyOn(handle, 'read').mockImplementation(async (...input: any[]) => {
                    if (!limited && input[2] > 2048) {
                        limited = true;
                        return read(input[0], input[1], 17, input[3]);
                    }
                    return (read as any)(...input);
                });
            }
            return handle;
        });
        const manager = new MemoryManager(directory);
        await manager.init();
        if (action === 'range') await manager.deleteRange(1, 1);
        if (action === 'entries') await manager.deleteEntries([1, 2]);
        const expected = action === 'scan' ? values : action === 'range' ? [values[0], values[2], values[3]] : [values[0], values[3]];
        expect((await manager.listEntries()).map(entry => entry.text)).toEqual(expected);
        expect(limited).toBe(true);
    });
});
