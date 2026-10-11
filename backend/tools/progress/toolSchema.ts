import type { PropertySchema } from '../toolSchema';
import { TODO_ITEM_SCHEMA } from '../shared/todoSchema';
import { PROGRESS_LOG_TYPES, PROGRESS_PHASES, PROGRESS_RISK_STATUSES, PROGRESS_STATUSES } from './schema';

// 只复用创建与更新参数的共同形状；路径说明、必填字段和更新语义留在各工具声明中。
export const PROGRESS_TOOL_PROPERTIES = {
  status: { description: '项目状态。', type: 'string', enum: [...PROGRESS_STATUSES] },
  phase: { description: '项目阶段。', type: 'string', enum: [...PROGRESS_PHASES] },
  currentFocus: { description: '当前的工作重点。', type: 'string' },
  latestConclusion: { description: '最新结论。', type: 'string' },
  currentBlocker: { description: '当前的阻塞问题。', type: 'string' },
  nextAction: { description: '下一步行动。', type: 'string' },
  activeArtifacts: {
    type: 'object',
    description: '当前关联的设计、计划和审查文档路径。',
    properties: {
      design: { description: '设计文档路径。', type: 'string' },
      plan: { description: '计划文档路径。', type: 'string' },
      review: { description: '审查文档路径。', type: 'string' },
    },
  },
  todos: { description: '当前 TODO 快照。', type: 'array', items: TODO_ITEM_SCHEMA },
  risks: {
    type: 'array',
    description: '风险清单。',
    items: {
      type: 'object',
      properties: {
        id: { description: '风险 ID。', type: 'string' },
        title: { description: '风险标题。', type: 'string' },
        status: { description: '风险状态。', type: 'string', enum: [...PROGRESS_RISK_STATUSES] },
        description: { description: '风险说明。', type: 'string' },
      },
      required: ['id', 'title', 'status', 'description'],
    },
  },
} satisfies Record<string, PropertySchema>;

export const PROGRESS_LOG_APPEND_SCHEMA = {
  type: 'array',
  description: '要追加的日志条目。',
  items: {
    type: 'object',
    properties: {
      type: { description: '日志类型。', type: 'string', enum: [...PROGRESS_LOG_TYPES] },
      refId: { description: '可选的关联 ID，例如里程碑 ID。', type: 'string' },
      message: { description: '日志内容。', type: 'string' },
    },
    required: ['type', 'message'],
  },
} satisfies PropertySchema;
