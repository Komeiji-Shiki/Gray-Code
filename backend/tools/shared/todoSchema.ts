import type { PropertySchema } from '../toolSchema';

// 会话 TODO、计划和进度共用条目形状；各领域的归一化和校验规则仍由调用方决定。
export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const;

export const TODO_STATUS_SCHEMA = {
  type: 'string',
  enum: [...TODO_STATUSES],
} satisfies PropertySchema;

export const TODO_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    content: { type: 'string' },
    status: TODO_STATUS_SCHEMA,
  },
  required: ['id', 'content', 'status'],
} satisfies PropertySchema;
