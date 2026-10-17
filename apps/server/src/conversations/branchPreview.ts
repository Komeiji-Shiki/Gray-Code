import type { ValueProjection } from '@graycode/core';

/**
 * 分支预览投影清单。字段是手动列举的：给 ConversationBranchNode / PlatformMessage 增加
 * 展示字段时必须同步这里，否则预览会静默丢字段；附件、签名、回合快照等非展示内容不要加回来。
 */
export const BRANCH_PREVIEW_TEXT_LENGTH = 180;

/** 预览仍沿用分支重建算法，只读取身份、工具类别和展示字段。完整正文由变更路径读取。 */
export const BRANCH_MESSAGE_PROJECTION: ValueProjection = {
  fields: ['id', 'parentId', 'role', 'timestamp', 'modelVersion', 'requestKey', 'isFunctionResponse', 'parts'],
  omitBinary: true,
  properties: {
    parts: {
      items: {
        fields: ['text', 'functionCall', 'functionResponse'],
        properties: {
          text: { maxStringLength: BRANCH_PREVIEW_TEXT_LENGTH },
          functionCall: { fields: ['name', 'args'], properties: { args: { fields: ['action'] } } },
          // 旧记录可能只用结果片段表示工具响应，保留对象存在性供消息分组使用。
          functionResponse: { fields: [] },
        },
      },
    },
  },
};

/** 归档候选与主历史使用同一预览；图节点中的冗余正文和内部回合元数据不进入读取结果。 */
export const BRANCH_RECORD_PROJECTION: ValueProjection = {
  fields: ['version', 'graph', 'groups', 'pendingKind'],
  omitBinary: true,
  properties: {
    graph: {
      fields: ['version', 'rootNodeId', 'activeTailNodeId', 'activeChildId', 'nodes', 'candidateSummaries', 'exportedFrom', 'exportedRefs'],
      properties: {
        nodes: {
          values: {
            fields: ['id', 'parentId', 'role', 'parts', 'kind', 'createdAt', 'timestamp', 'modelVersion',
              'activeChildId', 'label', 'deleted', 'deletedAt', 'workspaceCheckpointId', 'workspaceState', 'exportedFrom'],
            properties: { parts: { items: { fields: [] } } },
          },
        },
        candidateSummaries: { items: { properties: { preview: { maxStringLength: BRANCH_PREVIEW_TEXT_LENGTH } } } },
      },
    },
    groups: { values: { items: BRANCH_MESSAGE_PROJECTION } },
  },
};
