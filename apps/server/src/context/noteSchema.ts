export const NOTE_KINDS = ['constraint', 'decision', 'observation', 'hypothesis', 'task', 'lesson', 'procedure', 'state'] as const;
export const NOTE_RELATIONS = ['requires', 'supports', 'contradicts', 'applies_to', 'supersedes'] as const;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const id = { type: 'string', minLength: 1, maxLength: 200 };
const time = { type: 'integer', description: 'UTC Unix 毫秒；没有明确时间依据时省略。' };

/** 模型声明与逐条校验共用约束，批量调用的入口只检查数组边界。 */
export const NOTE_ENTRY_SCHEMA = object({
  key: { type: 'string', minLength: 1, maxLength: 80, description: '本批唯一；state 用固定 key 更新当前状态，并自动保留旧版本。' },
  kind: { type: 'string', enum: NOTE_KINDS },
  text: { type: 'string', minLength: 1, maxLength: 4000, description: '保留条件、否定、决定理由和仍未解决的问题。' },
  about: { type: 'array', maxItems: 16, items: id, description: '相关任务、文件、符号或主题。' },
  sources: {
    type: 'array', minItems: 1, maxItems: 8,
    items: object({
      messageId: { ...id, description: '历史 ID、last_user、last_assistant、last_tool_result 或 tool:<调用 ID>；省略时沿用本条笔记上一项来源，首项必填。' },
      quote: { type: 'string', minLength: 1, maxLength: 4000, description: '可选，原文中唯一的逐字摘录；偏移可用于 context_history(read)。' },
    }),
  },
  relations: {
    type: 'array', maxItems: 32,
    items: object({
      kind: { type: 'string', enum: NOTE_RELATIONS,
        description: '本条依赖目标、支持目标、与目标冲突、适用于目标或取代目标。' },
      target: { ...id, description: '笔记 ID 或 key；@key 优先引用本批条目，也可引用先前批次。key 有多个有效候选时返回候选 ID。' },
    }, ['kind', 'target']),
  },
  validFrom: time,
  validTo: time,
  eventAt: time,
}, ['key', 'kind', 'text', 'sources']);
