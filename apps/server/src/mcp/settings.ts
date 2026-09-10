import { createHash } from 'node:crypto';
import { McpManager } from '../../../../backend/modules/mcp/McpManager';
import type { McpServerConfig, McpStorageAdapter } from '../../../../backend/modules/mcp/types';

export function createMcpSettingsDraft(value: { mcpServers?: McpServerConfig[] }, changed: () => void): McpManager {
  const adapter: McpStorageAdapter = {
    getAllConfigs: async () => structuredClone(value.mcpServers ?? []),
    getConfig: async id => structuredClone(value.mcpServers?.find(item => item.id === id) ?? null),
    saveConfig: async config => {
      validateMcpConfigurations([config]);
      const items = value.mcpServers ??= [];
      const index = items.findIndex(item => item.id === config.id);
      if (index < 0) items.push(structuredClone(config)); else items[index] = structuredClone(config);
      changed();
    },
    deleteConfig: async id => { value.mcpServers = (value.mcpServers ?? []).filter(item => item.id !== id); changed(); },
  };
  return new McpManager(adapter, { connections: false });
}

export function validateMcpConfigurations(configs: McpServerConfig[]): void {
  for (const config of configs) {
    const transport = config.transport;
    if (!transport || !['stdio', 'sse', 'streamable-http'].includes(transport.type)) throw new Error(`MCP ${config.name} 的传输类型无效。`);
    if (transport.type === 'stdio') {
      if (typeof transport.command !== 'string' || !transport.command.trim() || transport.command.includes('\0') ||
          transport.args !== undefined && (!Array.isArray(transport.args) || transport.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) throw new Error(`MCP ${config.name} 的命令或参数无效。`);
    } else {
      const url = new URL(transport.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('MCP HTTP 地址需要 http 或 https 协议。');
    }
    const fields = transport.type === 'stdio' ? transport.env : transport.headers;
    if (fields !== undefined && (!fields || Array.isArray(fields) || typeof fields !== 'object' || Object.values(fields).some(value => typeof value !== 'string'))) throw new Error('MCP 环境变量和请求头的值必须是字符串。');
    if (config.timeout !== undefined && (!Number.isFinite(config.timeout) || config.timeout <= 0)) throw new Error('MCP 超时需要正数。');
  }
}

export async function revealMcpSettings(servers: McpServerConfig[], references: Record<string, string>, credential: (reference: string) => Promise<string | null>): Promise<McpServerConfig[]> {
  const result = structuredClone(servers);
  for (const server of result) {
    const reference = references[server.id];
    if (!reference) continue;
    const secret = await credential(reference);
    if (secret === null) throw new Error(`无法读取 MCP ${server.name} 的加密连接配置。`);
    const fields = JSON.parse(secret) as Record<string, string>;
    if (server.transport.type === 'stdio') server.transport.env = fields; else server.transport.headers = fields;
  }
  return result;
}

export function sealMcpSettings(servers: McpServerConfig[], previous: Record<string, string>, credentials: Record<string, string | null>) {
  validateMcpConfigurations(servers);
  const configs = structuredClone(servers);
  const references: Record<string, string> = {};
  for (const server of configs) {
    const fields = server.transport.type === 'stdio' ? server.transport.env : server.transport.headers;
    if (!fields || !Object.keys(fields).length) continue;
    const reference = `mcp_${createHash('sha256').update(server.id).digest('hex').slice(0, 24)}`;
    references[server.id] = reference;
    credentials[reference] = JSON.stringify(fields);
    if (server.transport.type === 'stdio') delete server.transport.env; else delete server.transport.headers;
  }
  for (const [id, reference] of Object.entries(previous)) if (!references[id]) credentials[reference] = null;
  return { configs, references };
}
