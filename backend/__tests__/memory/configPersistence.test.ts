import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { MemoryManager } from '../../modules/memory/MemoryManager';
import { writeConfigAtomic } from '../../modules/memory/configFile';

const fsPromises = require('fs/promises') as typeof import('fs/promises');

describe('记忆文件初始化与配置写入失败', () => {
    let directory: string;
    beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-persistence-')); });
    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test.each(['config', 'LOG.txt'])('初始化不能覆盖另一个实例刚创建的 %s', async name => {
        const target = path.join(directory, name);
        const originalWrite = fsPromises.writeFile;
        let raced = false;
        const content = name === 'config' ? 'ENTRY_CHARS = 1280\n' : '#0 2026-09-26 existing memory\n';
        jest.spyOn(fsPromises, 'writeFile').mockImplementation(async (file, data, options) => {
            if (String(file) === target && !raced) {
                raced = true;
                await originalWrite(file, content);
            }
            return originalWrite(file, data, options);
        });
        await new MemoryManager(directory).init();
        expect(raced).toBe(true);
        expect(fs.readFileSync(target, 'utf8')).toBe(content);
    });

    test.each(['EPERM', 'EEXIST'])('替换配置持续 %s 时保留旧配置并报告原错误', async code => {
        const target = path.join(directory, 'config');
        fs.writeFileSync(target, 'ENTRY_CHARS = 1280\n');
        const error = Object.assign(new Error('fixture replacement refused'), { code });
        jest.spyOn(fsPromises, 'rename').mockRejectedValue(error);

        await expect(writeConfigAtomic(target, 'ENTRY_CHARS = 2048\n')).rejects.toBe(error);
        expect(fs.readFileSync(target, 'utf8')).toBe('ENTRY_CHARS = 1280\n');
        expect(fs.readdirSync(directory)).toEqual(['config']);
    });

    test('配置读取的 IO 错误不会被伪装为缺失配置', async () => {
        const manager = new MemoryManager(directory);
        await manager.init();
        const error = Object.assign(new Error('fixture read failed'), { code: 'EIO' });
        jest.spyOn(fsPromises, 'readFile').mockRejectedValueOnce(error);
        await expect(manager.loadConfig()).rejects.toBe(error);
    });
});
