import { mcpToolToDeclaration } from '../../../../backend/modules/mcp/toolAdapter';
import { configToJson, jsonToConfig } from '../../../../backend/modules/mcp/jsonConfig';
import { MCP_SERVER_ID_PATTERN } from '../../../../shared/mcpToolNameCodec';
import { createMcpSettingsDraft, validateMcpConfigurations } from './settings';
import type { ProductSettingsDraft } from '../settings/product';
import type { PlatformApplication } from '../application';

export function mcpUiHandlers(draft: ProductSettingsDraft, app: PlatformApplication) {
  return {
    getMcpServers: async () => {
      const live = new Map((await app.mcp.manager.listServers()).map(server => [server.config.id, server]));
      const servers = (await draft.mcp.listServers()).map(server => ({ ...live.get(server.config.id), ...server,
        status: live.get(server.config.id)?.status ?? server.status, capabilities: live.get(server.config.id)?.capabilities,
        lastError: live.get(server.config.id)?.lastError }));
      return { success: true, servers };
    },
    validateMcpServerId: async (data: any) => ({ success: true, ...await draft.mcp.validateServerId(data.id, data.excludeId) }),
    createMcpServer: async (data: any) => ({ success: true, serverId: await draft.mcp.createServer(data.input, data.customId) }),
    updateMcpServer: async (data: any) => { await draft.mcp.updateServer(data.serverId, data.updates); return { success: true }; },
    deleteMcpServer: async (data: any) => { await draft.mcp.deleteServer(data.serverId); return { success: true }; },
    setMcpServerEnabled: async (data: any) => { await draft.mcp.setServerEnabled(data.serverId, data.enabled); return { success: true }; },
    connectMcpServer: async (data: any) => {
      const pending = await draft.mcp.getServer(data.serverId);
      const saved = await app.mcp.manager.getServer(data.serverId);
      if (!saved || JSON.stringify(pending) !== JSON.stringify(saved)) throw new Error('请先保存 MCP 配置，再连接服务器。');
      await app.mcp.manager.connect(data.serverId); return { success: true };
    },
    disconnectMcpServer: async (data: any) => { await app.mcp.manager.disconnect(data.serverId); return { success: true }; },
    'tools.getMcpTools': () => ({ tools: app.mcp.manager.getAllTools().flatMap(server => (server.tools ?? []).map(tool => ({
      ...mcpToolToDeclaration(tool, server.serverId), enabled: true, serverId: server.serverId, serverName: server.serverName,
    }))) }),
    // C1：资源与提示模板只读选择入口。只读 live manager（app.mcp.manager），不使用
    // 草稿 manager、不额外启动 stdio 进程。列表返回各服务器连接状态与具体错误，
    // 未连接时不假装返回空列表即成功；读取/获取透传取消信号。
    'mcp.listResources': async (data: any = {}) => {
      const filter = typeof data?.serverId === 'string' && data.serverId.trim() ? data.serverId : undefined;
      const servers = await app.mcp.manager.listServers();
      if (filter && !servers.some(server => server.config.id === filter)) throw new Error(`MCP 服务器不存在：${filter}`);
      const byId = new Map(app.mcp.manager.getAllResources().map(entry => [entry.serverId, entry.resources ?? []]));
      const items = servers.filter(server => !filter || server.config.id === filter).map(server => ({
        serverId: server.config.id, serverName: server.config.name, status: server.status, lastError: server.lastError,
        resources: byId.get(server.config.id) ?? [],
      }));
      return { success: true, resources: items };
    },
    'mcp.readResource': async (data: any, signal?: AbortSignal) => {
      const serverId = data?.serverId;
      const uri = data?.uri;
      if (typeof serverId !== 'string' || !serverId.trim()) throw new Error('需要提供 serverId。');
      if (typeof uri !== 'string' || !uri.trim()) throw new Error('需要提供资源 URI。');
      const effective = signal ?? (data?.signal instanceof AbortSignal ? data.signal as AbortSignal : undefined);
      if (effective?.aborted) throw new Error('资源读取已取消。');
      const content = await app.mcp.manager.readResource({ serverId, uri, ...(effective ? { signal: effective } : {}) });
      if (!content) throw new Error(`MCP 资源为空：${uri}`);
      return { success: true, content };
    },
    'mcp.listPrompts': async (data: any = {}) => {
      const filter = typeof data?.serverId === 'string' && data.serverId.trim() ? data.serverId : undefined;
      const servers = await app.mcp.manager.listServers();
      if (filter && !servers.some(server => server.config.id === filter)) throw new Error(`MCP 服务器不存在：${filter}`);
      const byId = new Map(app.mcp.manager.getAllPrompts().map(entry => [entry.serverId, entry.prompts ?? []]));
      const items = servers.filter(server => !filter || server.config.id === filter).map(server => ({
        serverId: server.config.id, serverName: server.config.name, status: server.status, lastError: server.lastError,
        prompts: byId.get(server.config.id) ?? [],
      }));
      return { success: true, prompts: items };
    },
    'mcp.getPrompt': async (data: any, signal?: AbortSignal) => {
      const serverId = data?.serverId;
      const promptName = data?.promptName ?? data?.name;
      const args = data?.arguments ?? data?.args;
      if (typeof serverId !== 'string' || !serverId.trim()) throw new Error('需要提供 serverId。');
      if (typeof promptName !== 'string' || !promptName.trim()) throw new Error('需要提供提示模板名称。');
      if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args) ||
          Object.values(args).some(value => typeof value !== 'string'))) throw new Error('提示参数必须是字符串键值对。');
      const definition = (app.mcp.manager.getAllPrompts().find(entry => entry.serverId === serverId)?.prompts ?? [])
        .find(item => item?.name === promptName);
      for (const item of definition?.arguments ?? []) {
        if (item.required && !(args?.[item.name])) throw new Error(`缺少提示参数：${item.name}`);
      }
      const effective = signal ?? (data?.signal instanceof AbortSignal ? data.signal as AbortSignal : undefined);
      if (effective?.aborted) throw new Error('提示获取已取消。');
      const messages = await app.mcp.manager.getPrompt({ serverId, promptName, ...(args ? { arguments: args } : {}),
        ...(effective ? { signal: effective } : {}) });
      return { success: true, messages };
    },
    'mcp.getJson': () => ({ mcpServers: Object.fromEntries((draft.value.mcpServers ?? []).map(config => [config.id, configToJson(config)])) }),
    'mcp.replaceJson': async (data: any) => {
      const value = data.config?.mcpServers;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置需要 mcpServers 对象。');
      const configs = Object.entries(value).map(([id, entry]) => {
        if (!MCP_SERVER_ID_PATTERN.test(id) || !entry || typeof entry !== 'object') throw new Error(`MCP 配置无效：${id}`);
        return jsonToConfig(id, entry);
      });
      const next = createMcpSettingsDraft({ mcpServers: configs }, () => {});
      validateMcpConfigurations(configs);
      await next.initialize(); await next.dispose();
      draft.value.mcpServers = configs;
      await draft.mcp.dispose();
      draft.mcp = createMcpSettingsDraft(draft.value, () => { draft.dirty = true; });
      await draft.mcp.initialize(); draft.dirty = true;
      return { success: true };
    },
  };
}
