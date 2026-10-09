import type { PropertySchema } from '../toolSchema';
import { TODO_ITEM_SCHEMA } from '../shared/todoSchema';
import { PROGRESS_LOG_TYPES, PROGRESS_PHASES, PROGRESS_RISK_STATUSES, PROGRESS_STATUSES } from './schema';

// 只复用创建与更新参数的共同形状；路径说明、必填字段和更新语义留在各工具声明中。
export const PROGRESS_TOOL_PROPERTIES = {
  status: { type: 'string', enum: [...PROGRESS_STATUSES] },
  phase: { type: 'string', enum: [...PROGRESS_PHASES] },
  currentFocus: { type: 'string' },
  latestConclusion: { type: 'string' },
  currentBlocker: { type: 'string' },
  nextAction: { type: 'string' },
  activeArtifacts: {
    type: 'object',
    properties: {
      design: { type: 'string' },
      plan: { type: 'string' },
      review: { type: 'string' },
    },
  },
  todos: { type: 'array', items: TODO_ITEM_SCHEMA },
  risks: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', enum: [...PROGRESS_RISK_STATUSES] },
        description: { type: 'string' },
      },
      required: ['id', 'title', 'status', 'description'],
    },
  },
} satisfies Record<string, PropertySchema>;

export const PROGRESS_LOG_APPEND_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...PROGRESS_LOG_TYPES] },
      refId: { type: 'string' },
      message: { type: 'string' },
    },
    required: ['type', 'message'],
  },
} satisfies PropertySchema;
