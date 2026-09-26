import * as fs from 'fs/promises';
import * as path from 'path';
import { MemoryEngine } from './MemoryEngine';
import { MemoryLogStore } from './MemoryLogStore';
import type { MemoryConfig } from './types';
import { buildConfigContent, parseConfigContent, writeConfigAtomic } from './configFile';

/** 原文件存储入口，公开记忆行为由共享引擎负责。 */
export class MemoryManager extends MemoryEngine {
    constructor(storagePath: string, config?: Partial<MemoryConfig>, sharedConfigPath?: string) {
        const configPath = sharedConfigPath ?? path.join(storagePath, 'config');
        super({
            store: getConfig => new MemoryLogStore(storagePath, getConfig),
            config: {
                initialize: async defaults => {
                    try { await fs.writeFile(configPath, buildConfigContent(defaults), { encoding: 'utf-8', flag: 'wx' }); }
                    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
                },
                load: async () => {
                    try { return parseConfigContent(await fs.readFile(configPath, 'utf-8')); }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                        throw error;
                    }
                },
                save: value => writeConfigAtomic(configPath, buildConfigContent(value)),
            },
        }, config);
    }
}
