import { McpManager } from '../../../../backend/modules/mcp/McpManager';
import { mcpResultToToolResult, mcpToolToDeclaration } from '../../../../backend/modules/mcp/toolAdapter';
import { MCP_TOOL_PREFIX } from '../../../../shared/mcpToolNameCodec';
import { cleanToolSchemaForModel } from '../../../../shared/toolSchema';
import type { RuntimeTool } from '@graycode/core';
import type { PlatformApplication } from '../application';

export class PlatformMcpService {
  readonly manager: McpManager;
  private synchronizeQueue: Promise<void> = Promise.resolve();
  /** 按服务器缓存已构建的工具；指纹覆盖构建用到的全部输入，指纹不变时声明、校验 Schema 与执行目标都不变。 */
  private serverTools = new Map<string, { fingerprint: string; tools: RuntimeTool[] }>();
  private catalogKey?: string;
  constructor(private readonly app: PlatformApplication) {
    this.manager = new McpManager({
      getAllConfigs: async () => app.product.mcpConfigs(),
      getConfig: async id => app.product.mcpConfigs().find(config => config.id === id) ?? null,
      saveConfig: async () => { throw new Error('通过统一设置草稿保存 MCP 配置。'); },
      deleteConfig: async () => { throw new Error('通过统一设置草稿删除 MCP 配置。'); },
    });
    for (const event of ['server:connected', 'server:disconnected', 'server:error', 'server:capabilities_updated'] as const) {
      this.manager.addEventListener(event, change => {
        this.refreshTools();
        app.publish({ type: 'ui.message', message: { type: 'command', command: 'mcp.configChanged', data: { serverId: change.serverId } } });
      });
    }
  }
  async initialize(): Promise<void> { await this.manager.initialize(); this.refreshTools(); }
  names(): string[] { return this.app.tools.declarations().filter(tool => tool.name.startsWith(MCP_TOOL_PREFIX)).map(tool => tool.name); }
  synchronize(): Promise<void> {
    const operation = this.synchronizeQueue.catch(() => {}).then(async () => { await this.manager.synchronizeConfigs(); this.refreshTools(); });
    this.synchronizeQueue = operation;
    return operation;
  }
  /**
   * 连接事件与列表变更都走这里。列表刷新会合并同一服务器的多条通知并一次拉取全部列表，事件里的
   * method 不能证明工具未变，所以按工具内容指纹判断：资源或提示词变化时工具指纹不变，工具目录与校验器
   * 保持原样；只有指纹变化的服务器重建工具。替换仍按 getAllTools 的服务器与工具顺序提交整个命名空间，
   * 不按服务器前缀局部替换：服务器 ID 允许以单下划线结尾，mcp__a__ 会同时匹配 a_ 的工具。
   */
  private refreshTools(): void {
    const servers = this.manager.getAllTools();
    const next = new Map<string, { fingerprint: string; tools: RuntimeTool[] }>();
    for (const server of servers) {
      const fingerprint = JSON.stringify([server.cleanSchema, server.tools ?? []]);
      const cached = this.serverTools.get(server.serverId);
      next.set(server.serverId, cached?.fingerprint === fingerprint ? cached : { fingerprint, tools: this.buildTools(server) });
    }
    const catalogKey = JSON.stringify(servers.map(server => [server.serverId, next.get(server.serverId)!.fingerprint]));
    this.serverTools = next;
    if (catalogKey === this.catalogKey) return;
    this.app.tools.replaceNamespace(MCP_TOOL_PREFIX, servers.flatMap(server => next.get(server.serverId)!.tools));
    this.catalogKey = catalogKey;
  }
  private buildTools(server: ReturnType<McpManager['getAllTools']>[number]): RuntimeTool[] {
    const tools: RuntimeTool[] = [];
    for (const tool of server.tools ?? []) {
      const declaration = mcpToolToDeclaration(tool, server.serverId);
      tools.push({ declaration: { ...declaration, parameters: server.cleanSchema ? cleanToolSchemaForModel(declaration.parameters) : declaration.parameters },
        // MCP 未声明方言时按协议使用 2020-12；该元数据只用于本地校验。
        validationSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...declaration.parameters },
        // Server annotations do not grant local or external permissions. Per-tool approvals
        // remain configurable through the same settings used for built-in tools.
        effects: () => ['high_risk'],
        execute: async (args, context) => {
          const { multimodal, ...result } = mcpResultToToolResult(await this.manager.callTool({ serverId: server.serverId,
            toolName: tool.name, arguments: args, signal: context.signal }));
          return { ...result, attachments: multimodal };
        },
      });
    }
    return tools;
  }
  async close(): Promise<void> { await this.synchronizeQueue.catch(() => {}); await this.manager.dispose(); }
}
