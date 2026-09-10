import * as fs from 'node:fs/promises';
import path from 'node:path';
import { importLegacyHistory } from '@graycode/core';
import { fixture, message, metadata } from './fixtures';
import { convertBranch } from '../../../apps/server/src/migration/service';
import { materializeBranch, readBranches } from '../../../apps/server/src/conversations/branches';
import { activePath, validate } from '../../../backend/modules/conversation/branch/BranchGraph';

describe('分支转换语义验收（B2）', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f.cleanup(); });

  function historyMessages() {
    return [
      { id: 'n0', role: 'user', parts: [{ text: 'hello' }], timestamp: 1000 },
      { id: 'n1', role: 'model', parts: [
        { functionCall: { id: 'call_1', name: 'search', args: { q: 'query' } }, thoughtSignature: ' exact-signature\n' },
      ], timestamp: 1001 },
      { id: 'fr1', role: 'user', isFunctionResponse: true, parts: [
        { functionResponse: { id: 'call_1', name: 'search', response: { success: true } } },
      ], timestamp: 1002 },
      { id: 'n3', role: 'model', parts: [{ text: 'done' }], timestamp: 1003 },
    ];
  }

  function legacyGraph() {
    const toolParts = [
      { functionCall: { id: 'call_1', name: 'search', args: { q: 'query' } }, thoughtSignature: ' exact-signature\n' },
      { functionResponse: { id: 'call_1', name: 'search', response: { success: true } } },
    ];
    return {
      version: 1,
      rootNodeId: 'n0',
      activeTailNodeId: 'n3',
      activeChildId: 'n1',
      candidateSummaries: [
        { nodeId: 'c1', parentId: 'n0', kind: 'reroll', createdAt: 4, preview: 'candidate' },
        { nodeId: 'd1', parentId: 'n1', kind: 'normal', createdAt: 5, preview: 'deleted', deleted: true, deletedAt: 6 },
      ],
      nodes: {
        n0: { id: 'n0', parentId: null, role: 'user', parts: [{ text: 'hello' }], kind: 'normal', createdAt: 1, timestamp: 1000, activeChildId: 'n1' },
        n1: {
          id: 'n1', parentId: 'n0', role: 'model', parts: toolParts, kind: 'normal', createdAt: 2, timestamp: 1001,
          modelVersion: 'test-model', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
          contentMetadata: { customKeep: '保留值' }, activeChildId: 'n3',
        },
        n3: { id: 'n3', parentId: 'n1', role: 'model', parts: [{ text: 'done' }], kind: 'normal', createdAt: 3, timestamp: 1003, activeChildId: null },
        c1: {
          id: 'c1', parentId: 'n0', role: 'model', parts: [
            { functionCall: { id: 'call_candidate', name: 'search', args: { q: 'other' } }, thoughtSignature: ' candidate-sig' },
          ], kind: 'reroll', createdAt: 4, timestamp: 1004, contentMetadata: { customKeep: '候选保留' }, activeChildId: null,
        },
        d1: {
          id: 'd1', parentId: 'n1', role: 'model', parts: [{ text: 'deleted branch' }], kind: 'normal',
          createdAt: 5, timestamp: 1005, activeChildId: null, deleted: true, deletedAt: 6,
        },
      },
    };
  }

  test('候选节点、删除标记与工具签名经转换后可被新版读取并重现活跃路径', async () => {
    const id = 'branchcase';
    const directory = path.join(f.source, 'conversations');
    await fs.writeFile(path.join(directory, `${id}.meta.json`), JSON.stringify(metadata(id)));
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify(historyMessages()));
    await fs.mkdir(path.join(directory, id), { recursive: true });
    const graph = legacyGraph();
    await fs.writeFile(path.join(directory, id, 'branches.json'), JSON.stringify(graph));
    const originalBranches = await fs.readFile(path.join(directory, id, 'branches.json'));

    const report = await importLegacyHistory(f.store, f.source, {
      convertBranch: (conversationId, value) => convertBranch(conversationId, value),
    });
    expect(report.issues).toEqual([]);
    expect(report.artifacts?.branches).toEqual([id]);
    // 源目录只读：分支 sidecar 字节不变。
    expect(await fs.readFile(path.join(directory, id, 'branches.json'))).toEqual(originalBranches);

    const stored = await f.store.getRecord('conversation-branches', id) as unknown;
    expect(stored).toBeTruthy();
    const state = stored as { version: number; graph: any; groups: Record<string, any[]> };
    expect(state.version).toBe(1);
    expect(state.graph.version).toBe(1);
    // 拓扑保留：候选与删除节点仍在图中，活跃指针不变。
    expect(Object.keys(state.graph.nodes).sort()).toEqual(['c1', 'd1', 'n0', 'n1', 'n3']);
    expect(state.graph.nodes.d1.deleted).toBe(true);
    expect(state.graph.nodes.c1.kind).toBe('reroll');
    expect(validate(state.graph).valid).toBe(true);
    expect(activePath(state.graph)).toEqual(['n0', 'n1', 'n3']);
    // 图节点按新版口径剥离正文，不重复存 bodies。
    expect(state.graph.nodes.n1.parts).toEqual([]);
    expect(state.graph.nodes.n1.contentMetadata).toBeUndefined();
    expect(state.graph.nodes.n1.usageMetadata).toBeUndefined();
    // groups 保留完整正文：工具调用 ID 与签名不丢失。
    expect(state.groups.n1[0].parts).toEqual([graph.nodes.n1.parts[0]]);
    expect(state.groups.n1[1]).toMatchObject({ role: 'user', isFunctionResponse: true, parts: [graph.nodes.n1.parts[1]] });
    expect(JSON.stringify(state.groups.n1)).toContain('call_1');
    expect(JSON.stringify(state.groups.n1)).toContain('exact-signature');
    expect(state.groups.c1[0].parts).toEqual(graph.nodes.c1.parts);
    expect(JSON.stringify(state.groups.c1)).toContain('call_candidate');
    expect(JSON.stringify(state.groups.c1)).toContain('candidate-sig');
    // contentMetadata 展平到消息顶层，分支标记不污染消息。
    expect((state.groups.n1[0] as any).customKeep).toBe('保留值');
    expect((state.groups.c1[0] as any).customKeep).toBe('候选保留');
    expect((state.groups.c1[0] as any).kind).toBeUndefined();
    expect((state.groups.c1[0] as any).activeChildId).toBeUndefined();
    expect((state.groups.c1[0] as any).deleted).toBeUndefined();
    // 候选摘要保留。
    expect(state.graph.candidateSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'c1' }),
      expect.objectContaining({ nodeId: 'd1', deleted: true }),
    ]));

    // 新版读取链：历史为权威，分支保留非活跃候选；活跃路径可物化。
    const conversationState = await f.store.readConversationState(id, [{ namespace: 'conversation-branches', id }]);
    const branches = readBranches(conversationState);
    expect(activePath(branches.graph)).toEqual(['n0', 'n1', 'n3']);
    const materialized = materializeBranch(branches);
    const ids = materialized.map(item => item.id);
    expect(ids).toEqual(expect.arrayContaining(['n0', 'n1', 'n3']));
    const modelWithCall = materialized.find(item => item.id === 'n1');
    expect(JSON.stringify(modelWithCall?.parts)).toContain('call_1');
    // 工具结果配对保留：同一候选组内含模型调用与结果。
    const group = branches.groups.n1;
    expect(JSON.stringify(group)).toContain('call_1');
  });

  test('非法分支图结构直接报错并记入迁移问题', async () => {
    const id = 'badbranch';
    await fs.writeFile(path.join(f.source, 'conversations', `${id}.meta.json`), JSON.stringify(metadata(id)));
    await fs.writeFile(path.join(f.source, 'conversations', `${id}.json`), JSON.stringify([message(0)]));
    await fs.mkdir(path.join(f.source, 'conversations', id), { recursive: true });
    await fs.writeFile(path.join(f.source, 'conversations', id, 'branches.json'), JSON.stringify({ version: 'x', nodes: {} }));
    const report = await importLegacyHistory(f.store, f.source, {
      conversationIds: [id],
      convertBranch: (conversationId, value) => convertBranch(conversationId, value),
    });
    expect(report.artifacts?.branches ?? []).toEqual([]);
    expect(report.issues.some(issue => issue.conversationId === id)).toBe(true);
  });
});
