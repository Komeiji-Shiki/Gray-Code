import type { McpServerConfig } from './types';
export interface McpServerJsonEntry {
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
    createdAt?: number;
    updatedAt?: number;
}

export function inferType(json: McpServerJsonEntry): 'stdio' | 'sse' | 'streamable-http' {
        if (json.type) return json.type;
        if (json.command) return 'stdio';
        if (json.url) return 'sse';
        return 'stdio'; // 默认
    }

export function jsonToConfig(id: string, json: McpServerJsonEntry): McpServerConfig {
        const type = inferType(json);
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
            // 时间戳从 JSON 读取（缺失时为旧格式配置，回退当前时间），
            // 避免每次读取都重建为新的 Date.now() 导致时间戳漂移
            createdAt: json.createdAt ?? Date.now(),
            updatedAt: json.updatedAt ?? Date.now()
        };
    }

export function configToJson(config: McpServerConfig): McpServerJsonEntry {
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

        // 持久化时间戳：jsonToConfig 才能还原原始的 createdAt/updatedAt（而非每次重建）
        if (config.createdAt) json.createdAt = config.createdAt;
        if (config.updatedAt) json.updatedAt = config.updatedAt;

        return json;
    }
