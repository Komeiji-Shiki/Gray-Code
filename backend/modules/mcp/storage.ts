import { jsonToConfig, configToJson, type McpServerJsonEntry } from './jsonConfig';
/**
 * GrayCode MCP 模块 - 存储适配器
 */

import type { McpStorageAdapter, McpServerConfig } from './types';

/**
 * 内存存储适配器（用于测试）
 */
export class InMemoryMcpStorageAdapter implements McpStorageAdapter {
    private configs: Map<string, McpServerConfig> = new Map();

    async getAllConfigs(): Promise<McpServerConfig[]> {
        return Array.from(this.configs.values());
    }

    async saveConfig(config: McpServerConfig): Promise<void> {
        this.configs.set(config.id, config);
    }

    async deleteConfig(id: string): Promise<void> {
        this.configs.delete(id);
    }

    async getConfig(id: string): Promise<McpServerConfig | null> {
        return this.configs.get(id) ?? null;
    }
}

/**
 * 文件系统存储适配器
 *
 * 将配置存储到 JSON 文件中
 * 格式: { mcpServers: [...] }
 */
export class FileSystemMcpStorageAdapter implements McpStorageAdapter {
    private filePath: string;
    private fs: typeof import('fs/promises');
    private path: typeof import('path');
    /** 读写串行队列：read-modify-write 不被并发 save/delete 交错覆盖 */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        filePath: string,
        fs: typeof import('fs/promises'),
        path: typeof import('path')
    ) {
        this.filePath = filePath;
        this.fs = fs;
        this.path = path;
    }

    /** 将操作加入串行队列（防止并发 save/delete 的 read-modify-write 互相覆盖） */
    private enqueue<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.queue.then(fn);
        this.queue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }

    private async ensureDir(): Promise<void> {
        const dir = this.path.dirname(this.filePath);
        try {
            await this.fs.mkdir(dir, { recursive: true });
        } catch {
            // 目录已存在
        }
    }

    private async readFile(): Promise<McpServerConfig[]> {
        let content: string;
        try {
            content = await this.fs.readFile(this.filePath, 'utf-8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
                return []; // 文件不存在：视为无配置
            }
            // 权限等读取错误：上抛，禁止静默按“无配置”处理后被 saveConfig 覆盖
            throw error;
        }
        try {
            const data = JSON.parse(content);
            // 支持 mcpServers 格式
            return data.mcpServers || data.servers || [];
        } catch {
            // JSON 损坏：明确抛错，禁止静默当“无配置”后覆盖原文件
            throw new Error(`MCP config file is corrupted: ${this.filePath}`);
        }
    }

    private async writeFile(configs: McpServerConfig[]): Promise<void> {
        await this.ensureDir();
        // 使用 mcpServers 格式
        const data = { mcpServers: configs };
        const content = JSON.stringify(data, null, 2);
        // tmp+rename 原子替换：先写临时文件再 rename，避免写入中途崩溃/断电
        // 留下截断或半写的线上配置（调用方在 enqueue 队列内，tmp 文件名不会并发冲突）
        const tmpPath = `${this.filePath}.tmp`;
        await this.fs.writeFile(tmpPath, content, 'utf-8');
        try {
            await this.fs.rename(tmpPath, this.filePath);
        } catch {
            // Windows 上目标文件被占用时 rename 可能 EPERM：回退直接写（非原子，但至少不失败），
            // 并清理残留的 tmp 文件（rename 失败不会移动 tmp）
            await this.fs.writeFile(this.filePath, content, 'utf-8');
            try {
                await this.fs.rm(tmpPath, { force: true });
            } catch {
                // 忽略清理失败
            }
        }
    }

    async getAllConfigs(): Promise<McpServerConfig[]> {
        return this.enqueue(() => this.readFile());
    }

    async saveConfig(config: McpServerConfig): Promise<void> {
        return this.enqueue(async () => {
            const configs = await this.readFile();
            const index = configs.findIndex(c => c.id === config.id);
            
            if (index >= 0) {
                configs[index] = config;
            } else {
                configs.push(config);
            }
            
            await this.writeFile(configs);
        });
    }

    async deleteConfig(id: string): Promise<void> {
        return this.enqueue(async () => {
            const configs = await this.readFile();
            const filtered = configs.filter(c => c.id !== id);
            await this.writeFile(filtered);
        });
    }

    async getConfig(id: string): Promise<McpServerConfig | null> {
        return this.enqueue(async () => {
            const configs = await this.readFile();
            return configs.find(c => c.id === id) ?? null;
        });
    }
}

/**
 * JSON 配置格式（以 ID 为键的对象）
 *
 * 支持简化格式（只有 command 和 args）和完整格式
 */


interface McpServersJson {
    mcpServers: Record<string, McpServerJsonEntry>;
}
