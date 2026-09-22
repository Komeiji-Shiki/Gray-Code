import { createHash } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import type { ActorIdentity, AgentDefinition, ToolDeclaration, ToolEffect, ToolOutcome, WorkspaceDefinition, UserQuestion, QuestionRequest, ModelInput, ApprovalChoice, ApprovalDecision } from '@graycode/contracts';

export interface ToolContext {
  runId: string;
  /** 由运行器提供，不能由模型参数覆盖。 */
  conversationId?: string;
  toolCallId?: string;
  /** 保存当前工具批次的迭代号，用于持久化副作用去重。 */
  iteration?: number;
  /** 本次调用已由用户确认，文件审阅无需再次询问同一操作。 */
  approvedByToolConfirmation?: boolean;
  /** 派发子任务时继承本次捕获的配置与工具集合，不从模型参数取得权限。 */
  agent?: AgentDefinition;
  modelSelection?: Pick<ModelInput, 'providerId' | 'modelOverride' | 'reasoningEffort'>;
  actorId: string;
  /** 已在执行入口确认的账号；内部宿主直接使用，避免重复解析。 */
  actor?: ActorIdentity;
  fileWriteGrants?: Array<{ path: string; recursive: boolean }>;
  /** 工具的目标策略要求额外确认时，复用当前调用的审批记录。 */
  requestApproval?: (reason: string) => Promise<boolean>;
  /** 外部代理的每个权限请求分别确认，保留上游选项身份，不复用整次工具的确认结果。 */
  requestPermission?: (reason: string, choices: ApprovalChoice[], signal?: AbortSignal) => Promise<ApprovalDecision>;
  workspace?: WorkspaceDefinition;
  signal: AbortSignal;
  askUser: (questions: UserQuestion[]) => Promise<QuestionRequest>;
  progress: (value: Record<string, unknown>) => void;
}
export interface RuntimeTool {
  declaration: ToolDeclaration;
  /** 模型声明经过兼容转换时，执行前仍使用原始 Schema 校验参数。 */
  validationSchema?: ToolDeclaration['parameters'];
  /** 明确独立的读取允许同批并行；实际效果仍须全部属于只读。该标记不进入模型声明。 */
  parallelRead?: boolean;
  /** Pure classification. Must not read files, contact a service, or create a snapshot. */
  effects: (args: Record<string, unknown>) => ToolEffect[];
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolOutcome>;
}
export interface ToolCatalog {
  version: string;
  declarations: ToolDeclaration[];
  entries: ReadonlyMap<string, { tool: RuntimeTool; validate: ValidateFunction }>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}

/** Tool selection belongs to agent configuration, never to the current speaker's role. */
export class RuntimeToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();
  private readonly validator = new Ajv({ strict: false, allErrors: false, validateFormats: false });
  private readonly validators = new Map<string, { schema: string; validate: ValidateFunction }>();

  /** 宿主可为实际执行提供上下文，声明和效果分类保持纯函数。 */
  constructor(private readonly decorate?: (tool: RuntimeTool) => RuntimeTool) {}
  diagnostics() { return { registeredTools: this.tools.size, compiledToolSchemas: this.validators.size }; }

  register(tool: RuntimeTool): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.declaration.name)) throw new Error('Invalid tool name.');
    if (this.tools.has(tool.declaration.name)) throw new Error(`Tool already registered: ${tool.declaration.name}`);
    this.tools.set(tool.declaration.name, { ...(this.decorate?.(tool) ?? tool), declaration: structuredClone(tool.declaration),
      ...(tool.validationSchema ? { validationSchema: structuredClone(tool.validationSchema) } : {}) });
  }

  catalog(names: string[], overrides?: ReadonlyMap<string, RuntimeTool>): ToolCatalog {
    const declarations: ToolDeclaration[] = [];
    const validationSchemas: Record<string, unknown> = {};
    const entries = new Map<string, { tool: RuntimeTool; validate: ValidateFunction }>();
    for (const name of [...new Set(names)].sort()) {
      const override = overrides?.get(name);
      const tool = override ? this.decorate?.(override) ?? override : this.tools.get(name);
      if (tool && tool.declaration.name !== name) throw new Error('工具替换名称不匹配。');
      if (!tool) throw new Error(`Configured tool is unavailable: ${name}`);
      const declaration = canonical(tool.declaration) as ToolDeclaration;
      declarations.push(declaration);
      const parameters = tool.validationSchema ? canonical(tool.validationSchema) as ToolDeclaration['parameters'] : declaration.parameters;
      if (tool.validationSchema) validationSchemas[name] = parameters;
      const schema = JSON.stringify(parameters);
      let cached = this.validators.get(name);
      if (cached?.schema !== schema) {
        const validate = this.validator.compile(parameters);
        // Ajv 按对象身份缓存；由工具名和声明内容管理复用，避免每次目录快照积累一个 schema。
        this.validator.removeSchema(parameters);
        cached = { schema, validate };
        this.validators.set(name, cached);
      }
      entries.set(name, { tool, validate: cached.validate });
    }
    const fingerprint = Object.keys(validationSchemas).length ? { declarations, validationSchemas } : declarations;
    return { declarations, entries, version: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex') };
  }

  declarations(): ToolDeclaration[] { return [...this.tools.values()].map(tool => structuredClone(tool.declaration)); }

  /** New runs see refreshed discovery; existing runs retain their captured declarations. */
  replaceNamespace(prefix: string, tools: RuntimeTool[]): void {
    if (!prefix || tools.some(tool => !tool.declaration.name.startsWith(prefix))) throw new Error('Invalid tool namespace replacement.');
    const next = new RuntimeToolRegistry(this.decorate);
    for (const tool of tools) next.register(tool);
    for (const name of this.tools.keys()) if (name.startsWith(prefix)) this.tools.delete(name);
    for (const name of this.validators.keys()) if (name.startsWith(prefix)) this.validators.delete(name);
    for (const [name, tool] of next.tools) this.tools.set(name, tool);
  }
}

export function authorizeEffects(actor: ActorIdentity, effects: ToolEffect[], workspace?: WorkspaceDefinition, toolName?: string): string | null {
  if (actor.revoked) return 'This account has been revoked.';
  if (workspace && actor.role !== 'owner' && actor.workspaceIds !== '*' && !actor.workspaceIds.includes(workspace.id)) return 'This account cannot use the selected workspace.';
  if (actor.role === 'owner') return null;
  if (toolName?.startsWith('mcp__') && actor.mcpTools !== undefined)
    return actor.mcpTools.includes(toolName) ? null : 'This MCP tool is not allowed for this account.';
  if (actor.role === 'guest' && effects.some(effect => effect !== 'public_read')) return 'Ordinary members may only use public information tools.';
  if (effects.some(effect => !actor.effects.includes(effect))) return 'This operation is outside the account grant.';
  return null;
}

export function needsApproval(agent: AgentDefinition, toolName: string, effects: ToolEffect[]): boolean {
  const rule = agent.toolApproval?.[toolName];
  if (rule === 'ask') return true;
  if (rule === 'auto') return false;
  if (effects.some(effect => ['data_delete', 'high_risk', 'administration', 'external_send'].includes(effect))) return true;
  return agent.approvalMode === 'all_mutations' && effects.some(effect => !['public_read', 'workspace_read'].includes(effect));
}
