/**
 * LimCode MCP 模块 - 存储适配器
 */

import type { McpStorageAdapter, McpServerConfig } from './types';

/**
 * VSCode Memento 存储适配器
 * 
 * 使用 VSCode 的 Memento API 存储 MCP 配置
 */
export class MementoMcpStorageAdapter implements McpStorageAdapter {
    private static readonly STORAGE_KEY = 'limcode.mcp.servers';
    
    /** VSCode Memento 实例 */
    private memento: {
        get<T>(key: string, defaultValue: T): T;
        update(key: string, value: unknown): Thenable<void>;
    };

    constructor(memento: {
        get<T>(key: string, defaultValue: T): T;
        update(key: string, value: unknown): Thenable<void>;
    }) {
        this.memento = memento;
    }

    async getAllConfigs(): Promise<McpServerConfig[]> {
        return this.memento.get<McpServerConfig[]>(MementoMcpStorageAdapter.STORAGE_KEY, []);
    }

    async saveConfig(config: McpServerConfig): Promise<void> {
        const configs = await this.getAllConfigs();
        const index = configs.findIndex(c => c.id === config.id);
        
        if (index >= 0) {
            configs[index] = config;
        } else {
            configs.push(config);
        }
        
        await this.memento.update(MementoMcpStorageAdapter.STORAGE_KEY, configs);
    }

    async deleteConfig(id: string): Promise<void> {
        const configs = await this.getAllConfigs();
        const filtered = configs.filter(c => c.id !== id);
        await this.memento.update(MementoMcpStorageAdapter.STORAGE_KEY, filtered);
    }

    async getConfig(id: string): Promise<McpServerConfig | null> {
        const configs = await this.getAllConfigs();
        return configs.find(c => c.id === id) ?? null;
    }
}

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
        await this.fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
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
interface McpServerJsonEntry {
    // 基本信息（可选，不存在时使用 ID 作为名称）
    name?: string;
    description?: string;
    
    // 类型（可选，有 command 时默认为 stdio，有 url 时默认为 sse）
    type?: 'stdio' | 'sse' | 'streamable-http';
    
    // stdio 类型
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    
    // sse/streamable-http 类型
    url?: string;
    headers?: Record<string, string>;
    
    // 通用
    isActive?: boolean;
    enabled?: boolean;  // 兼容
    autoConnect?: boolean;
    timeout?: number;
    cleanSchema?: boolean;
}

interface McpServersJson {
    mcpServers: Record<string, McpServerJsonEntry>;
}

/**
 * VSCode 文件系统存储适配器
 *
 * 使用 vscode.workspace.fs API 操作文件
 * 格式: { mcpServers: { "id": {...}, ... } }
 */
export class VSCodeFileSystemMcpStorageAdapter implements McpStorageAdapter {
    private fileUri: import('vscode').Uri;
    private vscodeFs: typeof import('vscode').workspace.fs;
    /** 读写串行队列：read-modify-write 不被并发 save/delete 交错覆盖 */
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        fileUri: import('vscode').Uri,
        vscodeFs: typeof import('vscode').workspace.fs
    ) {
        this.fileUri = fileUri;
        this.vscodeFs = vscodeFs;
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

    private async readFile(): Promise<McpServersJson> {
        let content: Uint8Array;
        try {
            content = await this.vscodeFs.readFile(this.fileUri);
        } catch (error) {
            // 文件不存在（ENOENT/EntryNotFound/FileNotFound）：视为无配置；
            // 其他错误上抛，禁止静默当“无配置”后被 saveConfig 覆盖
            const code = String((error as any)?.code || '');
            if (code === 'ENOENT' || code === 'EntryNotFound' || code === 'FileNotFound') {
                return { mcpServers: {} };
            }
            throw error;
        }
        try {
            const text = new TextDecoder().decode(content);
            const data = JSON.parse(text);
            return { mcpServers: data.mcpServers || {} };
        } catch {
            // JSON 损坏：明确抛错，禁止静默当“无配置”后覆盖原文件
            throw new Error(`MCP config file is corrupted: ${this.fileUri.fsPath || this.fileUri.toString()}`);
        }
    }

    private async writeFile(data: McpServersJson): Promise<void> {
        const content = JSON.stringify(data, null, 2);
        await this.vscodeFs.writeFile(this.fileUri, Buffer.from(content, 'utf-8'));
    }

    /**
     * 推断传输类型
     */
    private inferType(json: McpServerJsonEntry): 'stdio' | 'sse' | 'streamable-http' {
        if (json.type) return json.type;
        if (json.command) return 'stdio';
        if (json.url) return 'sse';
        return 'stdio'; // 默认
    }

    /**
     * 将 JSON 格式转换为 McpServerConfig
     * 支持简化格式：只有 command 和 args
     */
    private jsonToConfig(id: string, json: McpServerJsonEntry): McpServerConfig {
        const type = this.inferType(json);
        const transport: any = { type };
        
        if (type === 'stdio') {
            transport.command = json.command || '';
            if (json.args?.length) transport.args = json.args;
            if (json.env && Object.keys(json.env).length) transport.env = json.env;
        } else {
            transport.url = json.url || '';
            if (json.headers && Object.keys(json.headers).length) transport.headers = json.headers;
        }
        
        return {
            id,
            name: json.name || id, // 没有 name 时使用 ID
            description: json.description,
            transport,
            enabled: json.isActive !== false && json.enabled !== false,
            autoConnect: json.autoConnect || false,
            timeout: json.timeout,
            cleanSchema: json.cleanSchema,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
    }

    /**
     * 将 McpServerConfig 转换为 JSON 格式
     * 输出简化格式（省略可推断的字段）
     */
    private configToJson(config: McpServerConfig): McpServerJsonEntry {
        const json: McpServerJsonEntry = {};
        
        // 只在 name 与 id 不同时保存
        if (config.name && config.name !== config.id) {
            json.name = config.name;
        }
        if (config.description) json.description = config.description;
        
        // stdio 类型可以省略 type
        if (config.transport.type !== 'stdio') {
            json.type = config.transport.type;
        }
        
        if (config.transport.type === 'stdio') {
            json.command = config.transport.command;
            if (config.transport.args?.length) json.args = config.transport.args;
            if (config.transport.env && Object.keys(config.transport.env).length) {
                json.env = config.transport.env;
            }
        } else {
            json.url = (config.transport as any).url;
            if ((config.transport as any).headers && Object.keys((config.transport as any).headers).length) {
                json.headers = (config.transport as any).headers;
            }
        }
        
        // 只在非默认值时保存
        if (!config.enabled) json.isActive = false;
        if (config.autoConnect) json.autoConnect = true;
        if (config.timeout) json.timeout = config.timeout;
        if (config.cleanSchema === false) json.cleanSchema = false;

        return json;
    }

    async getAllConfigs(): Promise<McpServerConfig[]> {
        return this.enqueue(async () => {
            const data = await this.readFile();
            return Object.entries(data.mcpServers).map(([id, json]) => this.jsonToConfig(id, json));
        });
    }

    async saveConfig(config: McpServerConfig): Promise<void> {
        return this.enqueue(async () => {
            const data = await this.readFile();
            data.mcpServers[config.id] = this.configToJson(config);
            await this.writeFile(data);
        });
    }

    async deleteConfig(id: string): Promise<void> {
        return this.enqueue(async () => {
            const data = await this.readFile();
            delete data.mcpServers[id];
            await this.writeFile(data);
        });
    }

    async getConfig(id: string): Promise<McpServerConfig | null> {
        return this.enqueue(async () => {
            const data = await this.readFile();
            const json = data.mcpServers[id];
            if (!json) return null;
            return this.jsonToConfig(id, json);
        });
    }
}