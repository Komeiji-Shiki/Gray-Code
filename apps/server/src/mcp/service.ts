import { McpManager } from '../../../../backend/modules/mcp/McpManager';
import { mcpResultToToolResult, mcpToolToDeclaration } from '../../../../backend/modules/mcp/toolAdapter';
import { MCP_TOOL_PREFIX } from '../../../../shared/mcpToolNameCodec';
import type { RuntimeTool } from '@graycode/core';
import type { PlatformApplication } from '../application';

export class PlatformMcpService {
  readonly manager: McpManager;
  private synchronizeQueue: Promise<void> = Promise.resolve();
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
  private refreshTools(): void {
    const tools: RuntimeTool[] = [];
    for (const server of this.manager.getAllTools()) for (const tool of server.tools ?? []) {
      const declaration = mcpToolToDeclaration(tool, server.serverId);
      tools.push({ declaration: { ...declaration, parameters: { ...declaration.parameters } },
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
    this.app.tools.replaceNamespace(MCP_TOOL_PREFIX, tools);
  }
  async close(): Promise<void> { await this.synchronizeQueue.catch(() => {}); await this.manager.dispose(); }
}
