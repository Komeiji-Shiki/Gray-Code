import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../../../packages/core/tests/fixtures';
import type { PlatformApplication } from '../../../apps/server/src/application';
import { LegacyMemoryImporter } from '../../../apps/server/src/memory/import';
import { PlatformMemory } from '../../../apps/server/src/memory/service';
import { LOG_REC } from '../../modules/memory/types';
import { pad } from '../../modules/memory/logFormat';

/** 导入器只需要账号边界与正式存储；不启动模型、工作区和桌面服务。 */
export async function legacyMemoryImportFixture() {
    const storage = await fixture();
    const app = {
        storage: storage.store,
        requireOwner: () => {},
        actor: () => ({ id: 'owner', role: 'owner' }),
    } as unknown as PlatformApplication;
    Object.assign(app, { memory: new PlatformMemory(app) });
    const importer = new LegacyMemoryImporter(app);
    const directory = path.join(storage.source, 'memory');
    await mkdir(directory, { recursive: true });
    const scope = app.memory.scope('owner');
    const writeLog = async (texts: string[], width = LOG_REC, tail?: Buffer) => {
        const bytes = Buffer.concat([
            ...texts.map((text, id) => pad(`#${id} 2024-01-01 ${text}`, width)),
            ...(tail ? [tail] : []),
        ]);
        await writeFile(path.join(directory, 'LOG.txt'), bytes);
        return bytes;
    };
    const writeTree = async (blockSize: number, bytes: Buffer) => {
        await mkdir(path.join(directory, 'TREE'), { recursive: true });
        const file = path.join(directory, 'TREE', String(blockSize));
        await writeFile(file, bytes);
        return file;
    };
    return {
        directory,
        logPath: path.join(directory, 'LOG.txt'),
        writeLog,
        writeTree,
        run: () => importer.run('owner', storage.source, new AbortController().signal),
        entries: () => storage.store.memoryEntries(scope, 0, 100),
        summaries: () => storage.store.memorySummaries(scope),
        engine: async () => (await app.memory.engine('owner')).engine,
        cleanup: storage.cleanup,
    };
}
