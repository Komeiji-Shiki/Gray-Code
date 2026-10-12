import { MESSAGE_NAMES, type MessageName } from './protocolNames';

// ============ 3. per-message payload schema（04#6） ============

/**
 * 轻量手写 payload 校验框架（零运行时依赖，纯函数，不 import 任何项目代码）。
 *
 * 背景（04#6）：MessageHandler 入参是 `data: any`，协议文件此前只统一了消息名，
 * 没有 payload 形状定义；各 handler 各自手写校验且口径不一（有的只判 object、
 * 有的逐字段 typeof、有的完全透传）。这里提供「per-message schema + 校验函数」，
 * 供 MessageRouter.route() 在入口处统一校验（失败回 INVALID_DATA），handler 内只保留
 * 业务校验。
 *
 * 兼容性约定：
 * - 只覆盖「结构已能确认」的消息；拿不准的消息用 looseObject（仅要求是普通对象）
 *   或干脆不登记（route() 会跳过统一校验，保持 handler 既有内部校验）。
 * - object 的字段默认「可选」；必填字段用 field.required(...) 标记。
 * - 额外字段一律放行（object 只校验已声明字段），避免前端多带字段被误拒。
 */

/** 校验结果：通过，或失败（失败带错误路径列表）。 */
export type SchemaValidationResult = { ok: true } | { ok: false; errors: string[] };

/** 单个字段 / 整段 payload 的形状描述（零依赖手写 schema）。 */
export type PayloadSchema =
  | { kind: 'any' }
  | { kind: 'looseObject' }
  | { kind: 'string'; allowEmpty?: boolean }
  | { kind: 'number'; integer?: boolean; min?: number; max?: number; allowMinusOne?: boolean }
  | { kind: 'boolean' }
  | { kind: 'object'; fields?: Record<string, FieldSchema> }
  | { kind: 'array'; item?: PayloadSchema };

/** 对象字段描述：在 PayloadSchema 之上增加「是否必须存在」语义。 */
export type FieldSchema = PayloadSchema & { required?: boolean };

/** 一条消息的 schema 校验函数 + 语义元数据。 */
export type MessageSchema = {
  validate: (data: unknown) => SchemaValidationResult;
  /** 非阻塞 fire-and-forget 元数据（与 NON_BLOCKING_MESSAGE_TYPES 同语义，渐进收敛用） */
  nonBlocking?: boolean;
  /** 前端超时豁免元数据（与 UNBOUNDED_REQUEST_TYPES 同语义，渐进收敛用） */
  unbounded?: boolean;
};

/** 构建 schema 时的可选元数据（nonBlocking / unbounded 与两份慢消息名单对应）。 */
export type MessageSchemaMeta = {
  nonBlocking?: boolean;
  unbounded?: boolean;
};

/** per-message schema 映射：未收录的消息在 route() 跳过统一校验。 */
export type MessageSchemaMap = Partial<Record<MessageName, MessageSchema>>;

function schemaOk(): SchemaValidationResult {
  return { ok: true };
}

function schemaFail(path: string, expected: string): SchemaValidationResult {
  return { ok: false, errors: [`${path}: expected ${expected}`] };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePayloadValue(value: unknown, schema: PayloadSchema, path: string): SchemaValidationResult {
  switch (schema.kind) {
    case 'any':
      return schemaOk();
    case 'looseObject':
      return isPlainRecord(value) ? schemaOk() : schemaFail(path, 'object');
    case 'string': {
      if (typeof value !== 'string') return schemaFail(path, 'string');
      if (schema.allowEmpty === false && value.length === 0) {
        return schemaFail(path, 'non-empty string');
      }
      return schemaOk();
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return schemaFail(path, 'finite number');
      }
      if (schema.allowMinusOne && value === -1) return schemaOk();
      if (schema.integer && !Number.isInteger(value)) return schemaFail(path, 'integer');
      if (schema.min !== undefined && value < schema.min) return schemaFail(path, `number >= ${schema.min}`);
      if (schema.max !== undefined && value > schema.max) return schemaFail(path, `number <= ${schema.max}`);
      return schemaOk();
    }
    case 'boolean':
      return typeof value === 'boolean' ? schemaOk() : schemaFail(path, 'boolean');
    case 'object': {
      if (!isPlainRecord(value)) return schemaFail(path, 'object');
      if (schema.fields) {
        for (const key of Object.keys(schema.fields)) {
          const fieldSchema = schema.fields[key];
          const has = Object.prototype.hasOwnProperty.call(value, key);
          const fieldValue = value[key];
          const fieldPath = `${path}.${key}`;
          if (fieldSchema.required) {
            if (!has) return schemaFail(fieldPath, 'required field');
            const result = validatePayloadValue(fieldValue, fieldSchema, fieldPath);
            if (!result.ok) return result;
          } else if (has && fieldValue !== undefined) {
            const result = validatePayloadValue(fieldValue, fieldSchema, fieldPath);
            if (!result.ok) return result;
          }
        }
      }
      return schemaOk();
    }
    case 'array': {
      if (!Array.isArray(value)) return schemaFail(path, 'array');
      if (schema.item) {
        for (let i = 0; i < value.length; i++) {
          const result = validatePayloadValue(value[i], schema.item, `${path}[${i}]`);
          if (!result.ok) return result;
        }
      }
      return schemaOk();
    }
    default:
      return schemaOk();
  }
}

function compilePayloadSchema(schema: PayloadSchema): (data: unknown) => SchemaValidationResult {
  return (data) => validatePayloadValue(data, schema, 'data');
}

/** 字段级 schema 构建器（用于 payload.object({ ... }) 的字段定义）。 */
export const field = {
  any(): FieldSchema {
    return { kind: 'any' };
  },
  looseObject(): FieldSchema {
    return { kind: 'looseObject' };
  },
  string(options?: { allowEmpty?: boolean }): FieldSchema {
    return { kind: 'string', ...(options ?? {}) };
  },
  number(options?: { integer?: boolean; min?: number; max?: number; allowMinusOne?: boolean }): FieldSchema {
    return { kind: 'number', ...(options ?? {}) };
  },
  boolean(): FieldSchema {
    return { kind: 'boolean' };
  },
  object(fields?: Record<string, FieldSchema>): FieldSchema {
    return { kind: 'object', fields };
  },
  array(item?: PayloadSchema): FieldSchema {
    return { kind: 'array', item };
  },
  /** 标记字段为必填（缺失时校验失败）。 */
  required(schema: FieldSchema): FieldSchema {
    return { ...schema, required: true } as FieldSchema;
  },
};

/** 整段 payload schema 构建器。 */
export const payload = {
  any(meta?: MessageSchemaMeta): MessageSchema {
    return { validate: () => schemaOk(), ...meta };
  },
  looseObject(meta?: MessageSchemaMeta): MessageSchema {
    return { validate: compilePayloadSchema({ kind: 'looseObject' }), ...meta };
  },
  object(fields?: Record<string, FieldSchema>, meta?: MessageSchemaMeta): MessageSchema {
    return { validate: compilePayloadSchema({ kind: 'object', fields }), ...meta };
  },
  string(options?: { allowEmpty?: boolean }, meta?: MessageSchemaMeta): MessageSchema {
    return { validate: compilePayloadSchema({ kind: 'string', ...(options ?? {}) }), ...meta };
  },
  number(options?: { integer?: boolean; min?: number; max?: number; allowMinusOne?: boolean }, meta?: MessageSchemaMeta): MessageSchema {
    return { validate: compilePayloadSchema({ kind: 'number', ...(options ?? {}) }), ...meta };
  },
  boolean(meta?: MessageSchemaMeta): MessageSchema {
    return { validate: compilePayloadSchema({ kind: 'boolean' }), ...meta };
  },
  array(item?: PayloadSchema, meta?: MessageSchemaMeta): MessageSchema {
    return { validate: compilePayloadSchema({ kind: 'array', item }), ...meta };
  },
};

/**
 * 已确认结构的消息 schema 映射（渐进覆盖）。
 *
 * 未收录的消息（流式消息、以及结构尚不完全确定的普通消息）在 route() 跳过统一校验，
 * 继续沿用各 handler 内部既有的手写校验，保证既有合法消息 100% 兼容。
 */
export const MESSAGE_SCHEMAS: MessageSchemaMap = {
  // ---- MCP（McpHandlers）----
  [MESSAGE_NAMES.validateMcpServerId]: payload.object({
    id: field.required(field.string()),
    excludeId: field.string(),
  }),
  [MESSAGE_NAMES.createMcpServer]: payload.object({
    input: field.required(field.looseObject()),
    customId: field.string(),
  }),
  [MESSAGE_NAMES.updateMcpServer]: payload.object({
    serverId: field.required(field.string()),
    updates: field.required(field.looseObject()),
  }),
  [MESSAGE_NAMES.deleteMcpServer]: payload.object({
    serverId: field.required(field.string()),
  }),
  [MESSAGE_NAMES.connectMcpServer]: payload.object({
    serverId: field.required(field.string()),
  }),
  [MESSAGE_NAMES.disconnectMcpServer]: payload.object({
    serverId: field.required(field.string()),
  }),
  [MESSAGE_NAMES.setMcpServerEnabled]: payload.object({
    serverId: field.required(field.string()),
    enabled: field.required(field.boolean()),
  }),

  // ---- 设置（SettingsHandlers）----
  [MESSAGE_NAMES.updateSettings]: payload.object({
    settings: field.required(field.looseObject()),
  }),
  [MESSAGE_NAMES.updateProxySettings]: payload.object({
    proxySettings: field.required(field.looseObject()),
  }),

  // ---- 子代理（SubAgentsHandlers）----
  [MESSAGE_NAMES['subagents.create']]: payload.object({
    type: field.required(field.string()),
    name: field.required(field.string()),
    description: field.string(),
    systemPrompt: field.string(),
    channel: field.any(),
    tools: field.any(),
    // 与 webview/handlers/SubAgentsHandlers.ts 原 optionalBoundedNumber 口径一致：
    // 整数、1..上限、允许 -1（无限制）。
    maxIterations: field.number({ integer: true, min: 1, max: 100_000, allowMinusOne: true }),
    maxRuntime: field.number({ integer: true, min: 1, max: 24 * 60 * 60 * 1000, allowMinusOne: true }),
    failureModeAfterRetries: field.string(),
    enabled: field.boolean(),
  }),
  [MESSAGE_NAMES['subagents.update']]: payload.object({
    type: field.required(field.string()),
    updates: field.required(field.looseObject()),
  }),
  [MESSAGE_NAMES['subagents.delete']]: payload.object({
    type: field.required(field.string()),
  }),
  // updateGlobalConfig 的字段校验语义复杂（非法值静默忽略 vs 报错混用），
  // 这里只收敛「顶层必须是对象」，字段级仍由 handler 保留业务校验。
  [MESSAGE_NAMES['subagents.updateGlobalConfig']]: payload.looseObject(),
  [MESSAGE_NAMES['subagents.pauseRun']]: payload.object({ runId: field.required(field.string()) }, { nonBlocking: true }),
  [MESSAGE_NAMES['subagents.resumeRun']]: payload.object({ runId: field.required(field.string()) }, { nonBlocking: true }),
  [MESSAGE_NAMES['subagents.exitRun']]: payload.object({ runId: field.required(field.string()), reason: field.string() }, { nonBlocking: true }),
  [MESSAGE_NAMES['subagents.openMonitor']]: payload.object({
    runId: field.string(),
    conversationId: field.string(),
  }),
};

/**
 * 在 route() 入口对单条消息做统一 payload 校验。
 *
 * @param type 消息名（MESSAGE_NAMES 的值）
 * @param data 原始 payload
 * @returns 未登记 schema 的消息一律返回 { ok: true }（跳过校验）
 */
export function validateMessagePayload(type: string, data: unknown): SchemaValidationResult {
  const schema = (MESSAGE_SCHEMAS as Record<string, MessageSchema | undefined>)[type];
  return schema ? schema.validate(data) : { ok: true };
}
