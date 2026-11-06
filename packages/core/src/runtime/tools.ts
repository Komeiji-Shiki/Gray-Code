import { createHash } from 'node:crypto';
import { toolSchemaValidators, type CompiledToolSchema } from './toolSchemaValidation';
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
  /** 宿主只在实际等待文件审查时报告生命周期；运行状态和事件仍由运行器管理。 */
  onDiffReview?: (review: { diffId: string; path: string; status: 'pending' | 'accepted' | 'rejected' | 'cancelled' }) => Promise<void>;
  workspace?: WorkspaceDefinition;
  signal: AbortSignal;
  /** 本次运行的按需工具完整声明，由运行器从捕获的目录提供。 */
  deferredTools?: ToolCatalog['deferred'];
  /** 仅由运行器设置，后台宿主据此把终态返回原始调用。 */
  nativeAsync?: boolean;
  /** 原生异步调用经过运行器接管后的句柄，供宿主返回正确的等待入口；不取自普通工具参数。 */
  nativeTaskHandle?: string;
  askUser: (questions: UserQuestion[]) => Promise<QuestionRequest>;
  progress: (value: Record<string, unknown>) => void;
}
export interface RuntimeTool {
  declaration: ToolDeclaration;
  /** 模型声明经过兼容转换时，执行前仍使用原始 Schema 校验参数。 */
  validationSchema?: ToolDeclaration['parameters'];
  /** 宿主提供纯参数规范化；在校验、效果分类和审批前执行，警告随结果返回。 */
  normalizeArgs?: (args: Record<string, unknown>) => { args: Record<string, unknown>; warnings: string[] };
  /**
   * 按操作参与审批的名称：合并工具继承旧工具的审批项，混合读写工具区分写操作。
   * auto/ask 以工具本名的显式规则优先；任一名称上的 deny 都会拒绝执行。分类不得读取外部状态。
   */
  approvalName?: (args: Record<string, unknown>) => string;
  /** 明确独立的读取允许同批并行；混合工具可按参数纯分类，实际效果与审批仍限制并行。 */
  parallelRead?: boolean | ((args: Record<string, unknown>) => boolean);
  /** 同一响应中连续的此类调用一起启动；容量与排队由工具自身的并发控制负责，不受只读批次上限约束。 */
  concurrentDispatch?: boolean;
  /** 支持待完成调用的生命周期；实际执行仍经过完整授权和审批。 */
  nativeAsync?: boolean;
  /** 只在实际启用原生异步时补充模型侧的生命周期约束。 */
  nativeAsyncDescription?: string;
  /** 原生模式的参数说明可以替换原回执语义，参数类型与执行校验保持不变。 */
  nativeAsyncParameterDescriptions?: Record<string, string>;
  /** Pure classification. Must not read files, contact a service, or create a snapshot. */
  effects: (args: Record<string, unknown>) => ToolEffect[];
  /** 执行复用规范化后的参数；需要修改时由工具局部复制，保留模型调用和审批参数。 */
  execute: (args: Readonly<Record<string, unknown>>, context: ToolContext) => Promise<ToolOutcome>;
}
export interface ToolCatalog {
  version: string;
  declarations: ToolDeclaration[];
  entries: ReadonlyMap<string, { tool: RuntimeTool } & CompiledToolSchema>;
  /** 按需工具的完整声明：declarations 里只放固定占位，校验和执行仍用 entries 里的真实工具。 */
  deferred?: ReadonlyMap<string, ToolDeclaration>;
  /**
   * 仍然声明但当前不能调用的工具及原因。锁定只改变能否执行，不改变声明形态，解锁前后 tools 数组不变；
   * entries 仍保留真实工具，原生异步等按工具属性生成的声明也保持一致。
   */
  locked?: ReadonlyMap<string, string>;
}

/** 宿主准备提示词时给出的目录形态：本回合固定按需的工具，以及其中暂不能调用的工具和原因。 */
export interface ToolLoadingHints {
  deferred?: readonly string[];
  locked?: Readonly<Record<string, string>>;
}

export const TOOL_SEARCH_NAME = 'tool_search';

/**
 * 按需工具在请求里的固定声明，内容只取决于名称。模型加载工具时定义作为工具结果追加进消息，
 * tools 数组逐字节不变，前缀缓存不受影响。参数表保持宽松，真实校验在执行入口完成。
 */
function deferredToolDeclaration(name: string): ToolDeclaration {
  return canonical({ name, description: `On-demand tool. Call ${TOOL_SEARCH_NAME} first to get its parameters.`,
    parameters: { type: 'object', properties: {}, additionalProperties: true } }) as ToolDeclaration;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(canonical));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])));
  }
  return value;
}

interface ToolDefinitionSnapshot {
  id: number;
  declaration: ToolDeclaration;
  parameters: ToolDeclaration['parameters'];
  schema: string;
  separateValidation: boolean;
}

/** 供应方模式转换后只冻结新建结构，既有目录中的冻结 Schema 继续共享。 */
export function freezeToolDeclarations(declarations: ToolDeclaration[]): readonly Readonly<ToolDeclaration>[] {
  const freeze = (value: unknown): void => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  for (const declaration of declarations) freeze(declaration);
  return Object.freeze(declarations);
}

/** 校验器缓存与目录捕获共用同一份 Schema 规范化结果，替换时才能准确判断是否可以复用。 */
function validationParameters(tool: RuntimeTool, declaration?: ToolDeclaration): ToolDeclaration['parameters'] {
  if (tool.validationSchema) return canonical(tool.validationSchema) as ToolDeclaration['parameters'];
  return (declaration ?? canonical(tool.declaration) as ToolDeclaration).parameters;
}

/** Tool selection belongs to agent configuration, never to the current speaker's role. */
export class RuntimeToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();
  private readonly validators = new Map<string, { schema: string } & CompiledToolSchema>();
  private readonly definitions = new WeakMap<RuntimeTool, ToolDefinitionSnapshot>();
  private readonly overrideDefinitions = new Map<string, { fingerprint: string; definition: ToolDefinitionSnapshot }>();
  private readonly catalogs = new Map<string, Pick<ToolCatalog, 'declarations' | 'version' | 'deferred'>>();
  private nextDefinitionId = 0;

  /** 宿主可为实际执行提供上下文，声明和效果分类保持纯函数。 */
  constructor(private readonly decorate?: (tool: RuntimeTool) => RuntimeTool) {}
  diagnostics() { return { registeredTools: this.tools.size, compiledToolSchemas: this.validators.size }; }

  register(tool: RuntimeTool): void {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.declaration.name)) throw new Error('Invalid tool name.');
    if (this.tools.has(tool.declaration.name)) throw new Error(`Tool already registered: ${tool.declaration.name}`);
    this.tools.set(tool.declaration.name, { ...(this.decorate?.(tool) ?? tool), declaration: structuredClone(tool.declaration),
      ...(tool.validationSchema ? { validationSchema: structuredClone(tool.validationSchema) } : {}) });
  }

  private definition(tool: RuntimeTool, override: boolean): ToolDefinitionSnapshot {
    const stored = !override ? this.definitions.get(tool) : undefined;
    if (stored) return stored;
    const declaration = canonical(tool.declaration) as ToolDeclaration;
    const parameters = validationParameters(tool, declaration);
    const schema = JSON.stringify(parameters);
    // 运行时替换可以修改同一个对象，也可以每次返回新闭包；只复用声明，执行器仍取当前调用。
    const fingerprint = override ? JSON.stringify([declaration, tool.validationSchema ? parameters : null]) : '';
    const previous = override ? this.overrideDefinitions.get(declaration.name) : undefined;
    if (previous?.fingerprint === fingerprint) return previous.definition;
    const definition = { id: ++this.nextDefinitionId, declaration, parameters, schema, separateValidation: !!tool.validationSchema };
    if (override) this.overrideDefinitions.set(declaration.name, { fingerprint, definition });
    else this.definitions.set(tool, definition);
    return definition;
  }

  catalog(names: string[], overrides?: ReadonlyMap<string, RuntimeTool>, deferred?: ReadonlySet<string>,
    locked?: ReadonlyMap<string, string>): ToolCatalog {
    const definitions: ToolDefinitionSnapshot[] = [];
    const entries = new Map<string, { tool: RuntimeTool } & CompiledToolSchema>();
    for (const name of [...new Set(names)].sort()) {
      const override = overrides?.get(name);
      const tool = override ? this.decorate?.(override) ?? override : this.tools.get(name);
      if (tool && tool.declaration.name !== name) throw new Error('工具替换名称不匹配。');
      if (!tool) throw new Error(`Configured tool is unavailable: ${name}`);
      const definition = this.definition(tool, !!override);
      definitions.push(definition);
      const { parameters, schema } = definition;
      let cached = this.validators.get(name);
      if (cached?.schema !== schema) {
        let compiled: CompiledToolSchema;
        try { compiled = toolSchemaValidators.compile(parameters); }
        catch (error) { throw new Error(`${name} 的参数声明无效：${error instanceof Error ? error.message : String(error)}`); }
        cached = { schema, ...compiled };
        this.validators.set(name, cached);
      }
      entries.set(name, { tool, validate: cached.validate, normalizeArguments: cached.normalizeArguments });
    }
    const isDeferred = (definition: ToolDefinitionSnapshot) => deferred?.has(definition.declaration.name) === true;
    // 锁定不改变声明形态：常驻工具保留完整定义，按需工具保留占位，只是 tool_search 不提供锁定工具的定义。
    const isLocked = (definition: ToolDefinitionSnapshot) => locked?.has(definition.declaration.name) === true;
    const lockedEntries = definitions.filter(isLocked).map(definition => [definition.declaration.name, locked!.get(definition.declaration.name)!] as const);
    const lockedTools = lockedEntries.length ? { locked: new Map(lockedEntries) } : {};
    const key = definitions.map(definition => `${definition.id}${isDeferred(definition) ? 'd' : ''}${isLocked(definition) ? 'l' : ''}`).join(',');
    const previous = this.catalogs.get(key);
    if (previous) {
      this.catalogs.delete(key); this.catalogs.set(key, previous);
      return { ...previous, entries, ...lockedTools };
    }
    const declarations = definitions.map(definition => isDeferred(definition)
      ? deferredToolDeclaration(definition.declaration.name) : definition.declaration);
    const deferredDeclarations = definitions.filter(definition => isDeferred(definition) && !isLocked(definition))
      .map(definition => definition.declaration);
    const validationSchemas = Object.fromEntries(definitions.filter(definition => definition.separateValidation)
      .map(definition => [definition.declaration.name, definition.parameters]));
    const lockedNames = lockedEntries.map(([name]) => name);
    const fingerprint = Object.keys(validationSchemas).length || deferredDeclarations.length || lockedNames.length
      ? { declarations, ...(Object.keys(validationSchemas).length ? { validationSchemas } : {}),
        ...(deferredDeclarations.length ? { deferred: deferredDeclarations } : {}), ...(lockedNames.length ? { locked: lockedNames } : {}) }
      : declarations;
    // 捕获后的声明不可变，多个运行可以共享 Token 缓存；版本仍按原有内容与排序计算。
    Object.freeze(declarations);
    const catalog = { declarations, version: createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'),
      ...(deferredDeclarations.length ? { deferred: new Map(deferredDeclarations.map(declaration => [declaration.name, declaration])) } : {}) };
    this.catalogs.set(key, catalog);
    if (this.catalogs.size > 64) this.catalogs.delete(this.catalogs.keys().next().value!);
    return { ...catalog, entries, ...lockedTools };
  }

  /** 配置默认工具清单时只需要名称，避免复制随后不会使用的完整参数声明。 */
  names(): string[] { return [...this.tools.keys()]; }
  declarations(): ToolDeclaration[] { return [...this.tools.values()].map(tool => structuredClone(tool.declaration)); }

  /** New runs see refreshed discovery; existing runs retain their captured declarations. */
  replaceNamespace(prefix: string, tools: RuntimeTool[]): void {
    if (!prefix || tools.some(tool => !tool.declaration.name.startsWith(prefix))) throw new Error('Invalid tool namespace replacement.');
    const next = new RuntimeToolRegistry(this.decorate);
    for (const tool of tools) next.register(tool);
    for (const name of this.tools.keys()) if (name.startsWith(prefix)) this.tools.delete(name);
    // 发现刷新常常只改动命名空间里的少数工具：Schema 未变的校验器继续复用，避免整批重新编译；
    // 已移除或 Schema 变化的名称立即释放，catalog 也会按 Schema 字符串再次核对。
    for (const [name, cached] of this.validators) {
      if (!name.startsWith(prefix)) continue;
      const tool = next.tools.get(name);
      if (!tool || JSON.stringify(validationParameters(tool)) !== cached.schema) this.validators.delete(name);
    }
    for (const [name, tool] of next.tools) this.tools.set(name, tool);
    for (const name of this.overrideDefinitions.keys()) if (name.startsWith(prefix)) this.overrideDefinitions.delete(name);
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

export function needsApproval(agent: AgentDefinition, toolName: string, effects: ToolEffect[], legacyToolName?: string): boolean {
  const rule = agent.toolApproval?.[toolName] ?? (legacyToolName ? agent.toolApproval?.[legacyToolName] : undefined);
  if (rule === 'ask') return true;
  if (rule === 'auto') return false;
  if (effects.some(effect => ['data_delete', 'high_risk', 'administration', 'external_send'].includes(effect))) return true;
  return agent.approvalMode === 'all_mutations' && effects.some(effect => !['public_read', 'workspace_read'].includes(effect));
}
