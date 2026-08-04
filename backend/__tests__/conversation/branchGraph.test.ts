/**
 * BranchGraph 纯函数单测（第五阶段 BR-08）。
 *
 * 覆盖：insertNode / rerollCandidate / editCandidate / activateChild / switchActivePath /
 * activePath / rebuildActivePath / childrenIndex / validate / 候选摘要。
 */

import {
    activateChild,
    activePath,
    childrenIndex,
    collectDeletedNodes,
    createEmptyBranchGraph,
    editCandidate,
    importLinearHistory,
    insertNode,
    isDeletedNodeExpired,
    pruneDeletedNodes,
    rebuildActivePath,
    removeCandidateSummary,
    removeSubtree,
    renameBranchLabel,
    rerollCandidate,
    restoreNode,
    softDeleteNode,
    switchActivePath,
    upsertCandidateSummary,
    validate,
} from '../../modules/conversation/branch/BranchGraph';
import {
    BranchError,
    ConversationBranchGraph,
    ConversationBranchNode,
} from '../../modules/conversation/branch/types';

function node(id: string, parentId: string | null, overrides: Partial<ConversationBranchNode> = {}): ConversationBranchNode {
    return {
        id,
        parentId,
        role: 'user',
        parts: [{ text: id }],
        kind: 'normal',
        createdAt: 1000,
        ...overrides,
    };
}

/** 线性图：root → u → a（u、a 均为激活子，尾 = a） */
function linearGraph(): ConversationBranchGraph {
    let g = createEmptyBranchGraph();
    g = insertNode(g, node('root', null, { createdAt: 1 }));
    g = insertNode(g, node('u', 'root', { role: 'user', createdAt: 2 }));
    g = insertNode(g, node('a', 'u', { role: 'model', createdAt: 3 }));
    return g;
}

function expectBranchError(fn: () => unknown, code: string): void {
    try {
        fn();
        throw new Error('expected BranchError to be thrown');
    } catch (error) {
        if (error instanceof BranchError) {
            expect(error.code).toBe(code);
            return;
        }
        throw error;
    }
}

describe('createEmptyBranchGraph', () => {
    test('返回空图：version=1、root/tail 为 null、无节点、镜像为 null、摘要为空', () => {
        const g = createEmptyBranchGraph();
        expect(g.version).toBe(1);
        expect(g.rootNodeId).toBeNull();
        expect(g.activeTailNodeId).toBeNull();
        expect(g.nodes).toEqual({});
        expect(g.activeChildId).toBeNull();
        expect(g.candidateSummaries).toEqual([]);
    });
});

describe('insertNode', () => {
    test('空图插入根节点：设置 rootNodeId、尾指针，镜像为 null', () => {
        const g = insertNode(createEmptyBranchGraph(), node('root', null, { createdAt: 1 }));
        expect(g.rootNodeId).toBe('root');
        expect(g.activeTailNodeId).toBe('root');
        expect(g.activeChildId).toBeNull();
        expect(g.nodes['root']).toMatchObject({ id: 'root', parentId: null });
    });

    test('插入子节点：父节点 activeChildId 指向新节点，尾指针更新，镜像同步', () => {
        const g = insertNode(linearGraph(), node('a2', 'u', { role: 'model', createdAt: 4 }));
        expect(g.nodes['u'].activeChildId).toBe('a2');
        expect(g.activeTailNodeId).toBe('a2');
        // 根节点的激活子仍是 u，镜像不变
        expect(g.activeChildId).toBe('u');
        expect(g.nodes['root'].activeChildId).toBe('u');
    });

    test('setActive:false 时不切换父节点 activeChildId，且尾指针不变（新节点不在活跃路径上）', () => {
        const base = linearGraph();
        const g = insertNode(base, node('a2', 'u', { createdAt: 4 }), { setActive: false });
        expect(g.nodes['u'].activeChildId).toBe('a');
        expect(g.activeTailNodeId).toBe('a');
        expect(g.nodes['a2']).toBeTruthy(); // 节点已入图，仅未激活
    });

    test('父节点不存在 → NODE_NOT_FOUND', () => {
        expectBranchError(() => insertNode(linearGraph(), node('x', 'ghost', {})), 'NODE_NOT_FOUND');
    });

    test('重复节点 ID → INVALID_BRANCH_RELATION', () => {
        expectBranchError(() => insertNode(linearGraph(), node('a', 'u', {})), 'INVALID_BRANCH_RELATION');
    });

    test('节点是自身父节点 → INVALID_BRANCH_RELATION', () => {
        expectBranchError(() => insertNode(linearGraph(), node('self', 'self', {})), 'INVALID_BRANCH_RELATION');
    });

    test('已有根时再插根 → INVALID_BRANCH_RELATION（单根）', () => {
        expectBranchError(() => insertNode(linearGraph(), node('root2', null, {})), 'INVALID_BRANCH_RELATION');
    });

    test('无根时插子节点 → INVALID_BRANCH_RELATION', () => {
        // 父节点存在但 rootNodeId 尚未建立（半初始化图）
        const rootless = { ...createEmptyBranchGraph(), nodes: { root: node('root', null) } };
        expectBranchError(() => insertNode(rootless, node('x', 'root', {})), 'INVALID_BRANCH_RELATION');
    });

    test('向已删除节点挂子节点 → INVALID_BRANCH_RELATION', () => {
        let g = linearGraph();
        g = { ...g, nodes: { ...g.nodes, u: { ...g.nodes['u'], deleted: true } } };
        expectBranchError(() => insertNode(g, node('x', 'u', {})), 'INVALID_BRANCH_RELATION');
    });

    test('深树插入不改变兄弟分支的激活状态', () => {
        let g = linearGraph();
        g = insertNode(g, node('b', 'u', { role: 'model', createdAt: 4 }));
        g = insertNode(g, node('u2', 'root', { role: 'user', createdAt: 5 }));
        expect(g.nodes['root'].activeChildId).toBe('u2');
        expect(g.activeChildId).toBe('u2');
        expect(g.nodes['u'].activeChildId).toBe('b');
        expect(g.nodes['a']).toBeTruthy(); // 旧候选保留
    });
});

describe('rerollCandidate', () => {
    test('同一父节点下新增候选并切换 activeChildId，旧候选保留', () => {
        const g = rerollCandidate(linearGraph(), 'u', node('b', 'u', { role: 'model', createdAt: 4 }));
        expect(g.nodes['u'].activeChildId).toBe('b');
        expect(g.activeTailNodeId).toBe('b');
        expect(g.nodes['a']).toBeTruthy(); // 旧回答保留
        expect(activePath(g)).toEqual(['root', 'u', 'b']);
    });

    test('kind 缺省为 reroll', () => {
        const g = rerollCandidate(linearGraph(), 'u', node('b', 'u', { createdAt: 4 }));
        expect(g.nodes['b'].kind).toBe('reroll');
    });

    test('reroll 后旧候选的子树仍存在', () => {
        let g = linearGraph();
        g = insertNode(g, node('a2', 'a', { createdAt: 4 })); // 旧候选 a 有子树
        g = rerollCandidate(g, 'u', node('b', 'u', { createdAt: 5 }));
        expect(g.nodes['a2']).toBeTruthy();
        expect(g.nodes['a'].activeChildId).toBe('a2');
    });
});

describe('editCandidate', () => {
    test('kind 缺省为 edit，且切换 activeChildId，旧子树保留', () => {
        const g = editCandidate(linearGraph(), 'root', node('u2', 'root', { role: 'user', createdAt: 4 }));
        expect(g.nodes['u2'].kind).toBe('edit');
        expect(g.nodes['root'].activeChildId).toBe('u2');
        expect(g.nodes['u']).toBeTruthy();
        expect(g.nodes['a']).toBeTruthy();
        expect(activePath(g)).toEqual(['root', 'u2']);
    });
});

describe('activateChild', () => {
    test('切换父节点 activeChildId，尾指针更新到子树的活跃尾', () => {
        let g = linearGraph();
        g = insertNode(g, node('a2', 'u', { role: 'model', createdAt: 4 }));
        g = activateChild(g, 'u', 'a');
        expect(g.nodes['u'].activeChildId).toBe('a');
        expect(g.activeTailNodeId).toBe('a');
    });

    test('目标不是直接子节点 → INVALID_BRANCH_RELATION', () => {
        expectBranchError(() => activateChild(linearGraph(), 'root', 'a'), 'INVALID_BRANCH_RELATION');
    });

    test('父节点不存在 → NODE_NOT_FOUND', () => {
        expectBranchError(() => activateChild(linearGraph(), 'ghost', 'a'), 'NODE_NOT_FOUND');
    });

    test('子节点不存在 → NODE_NOT_FOUND', () => {
        expectBranchError(() => activateChild(linearGraph(), 'u', 'ghost'), 'NODE_NOT_FOUND');
    });

    test('激活已删除节点 → INVALID_BRANCH_RELATION', () => {
        let g = linearGraph();
        g = { ...g, nodes: { ...g.nodes, a: { ...g.nodes['a'], deleted: true } } };
        expectBranchError(() => activateChild(g, 'u', 'a'), 'INVALID_BRANCH_RELATION');
    });
});

describe('activePath', () => {
    test('空图 → []', () => {
        expect(activePath(createEmptyBranchGraph())).toEqual([]);
    });

    test('线性图 → [root, u, a]', () => {
        expect(activePath(linearGraph())).toEqual(['root', 'u', 'a']);
    });

    test('reroll 后取激活候选路径', () => {
        const g = rerollCandidate(linearGraph(), 'u', node('b', 'u', { role: 'model', createdAt: 4 }));
        expect(activePath(g)).toEqual(['root', 'u', 'b']);
    });

    test('activeTailNodeId 为 null 时沿 activeChildId 走到链尾', () => {
        const g = linearGraph();
        g.activeTailNodeId = null;
        expect(activePath(g)).toEqual(['root', 'u', 'a']);
    });

    test('尾不可达 → BRANCH_STORAGE_CORRUPT', () => {
        const g: ConversationBranchGraph = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: 'b',
            nodes: {
                root: { ...node('root', null), activeChildId: 'a' },
                a: node('a', 'root'),
                b: node('b', 'a'), // b 是 a 的子节点但未被激活
            },
            activeChildId: 'a',
            candidateSummaries: [],
        };
        expectBranchError(() => activePath(g), 'BRANCH_STORAGE_CORRUPT');
    });

    test('activeChildId 链成环 → BRANCH_STORAGE_CORRUPT', () => {
        const g: ConversationBranchGraph = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: null, // 尾为 null 时才会走到环上（到达尾会提前结束）
            nodes: {
                root: { ...node('root', null), activeChildId: 'a' },
                a: { ...node('a', 'root'), activeChildId: 'root' },
            },
            activeChildId: 'a',
            candidateSummaries: [],
        };
        expectBranchError(() => activePath(g), 'BRANCH_STORAGE_CORRUPT');
    });
});

describe('rebuildActivePath', () => {
    test('目标为叶子 → [root, u, a]', () => {
        expect(rebuildActivePath(linearGraph(), 'a')).toEqual(['root', 'u', 'a']);
    });

    test('目标为中间节点且其下有激活子树 → 延伸到子树尾', () => {
        let g = linearGraph();
        g = insertNode(g, node('a2', 'a', { role: 'model', createdAt: 4 }));
        expect(rebuildActivePath(g, 'a')).toEqual(['root', 'u', 'a', 'a2']);
    });

    test('目标在非活跃分支：沿 parentId 向上、沿 activeChildId 向下', () => {
        let g = linearGraph();
        g = rerollCandidate(g, 'u', node('b', 'u', { role: 'model', createdAt: 4 }));
        g = insertNode(g, node('a2', 'a', { role: 'model', createdAt: 5 })); // 旧候选 a 的子树
        expect(rebuildActivePath(g, 'a')).toEqual(['root', 'u', 'a', 'a2']);
    });

    test('目标不存在 → NODE_NOT_FOUND', () => {
        expectBranchError(() => rebuildActivePath(linearGraph(), 'ghost'), 'NODE_NOT_FOUND');
    });
});

describe('switchActivePath', () => {
    test('深树切换：更新所有祖先 activeChildId，尾更新到目标子树尾', () => {
        let g = linearGraph();
        // root 下第二分支 u2 → b1
        g = insertNode(g, node('u2', 'root', { role: 'user', createdAt: 4 }));
        g = insertNode(g, node('b1', 'u2', { role: 'model', createdAt: 5 }));
        g = switchActivePath(g, 'u2');
        expect(g.nodes['root'].activeChildId).toBe('u2');
        expect(g.activeChildId).toBe('u2');
        expect(g.activeTailNodeId).toBe('b1');
        expect(activePath(g)).toEqual(['root', 'u2', 'b1']);
        // 原分支的激活状态不受影响
        expect(g.nodes['u'].activeChildId).toBe('a');
    });

    test('切换到旧候选 a（含子树）→ 路径含其子树尾', () => {
        let g = linearGraph();
        g = rerollCandidate(g, 'u', node('b', 'u', { role: 'model', createdAt: 4 }));
        g = insertNode(g, node('a2', 'a', { role: 'model', createdAt: 5 }));
        g = switchActivePath(g, 'a');
        expect(g.activeTailNodeId).toBe('a2');
        expect(activePath(g)).toEqual(['root', 'u', 'a', 'a2']);
    });

    test('目标不存在 → NODE_NOT_FOUND', () => {
        expectBranchError(() => switchActivePath(linearGraph(), 'ghost'), 'NODE_NOT_FOUND');
    });

    test('目标已删除 → BRANCH_OPERATION_CONFLICT（业务冲突，非损坏）', () => {
        let g = linearGraph();
        g = { ...g, nodes: { ...g.nodes, a: { ...g.nodes['a'], deleted: true } } };
        expectBranchError(() => switchActivePath(g, 'a'), 'BRANCH_OPERATION_CONFLICT');
    });

    test('目标到 root 的 parentId 链上有软删祖先 → BRANCH_OPERATION_CONFLICT（R8c-P2）', () => {
        // 旧数据：父节点已软删但其 live 子孙仍存在（级联软删落地前的遗留状态）
        let g = linearGraph();
        g = insertNode(g, node('u2', 'root', { role: 'user', createdAt: 4 }), { setActive: false, updateTail: false });
        g = insertNode(g, node('c', 'u2', { role: 'model', createdAt: 5 }), { setActive: true, updateTail: false });
        g = insertNode(g, node('c1', 'c', { role: 'model', createdAt: 6 }), { setActive: true, updateTail: false });
        // 手工把祖先 c 标记为已软删（模拟旧数据：只有分支头被软删，子孙 c1 仍是 live）
        g = { ...g, nodes: { ...g.nodes, c: { ...g.nodes['c'], deleted: true, deletedAt: 1 } } };
        expectBranchError(() => switchActivePath(g, 'c1'), 'BRANCH_OPERATION_CONFLICT');
        // 目标自身已软删同样走冲突（与上面目标删除测试一致）
        expectBranchError(() => switchActivePath(g, 'c'), 'BRANCH_OPERATION_CONFLICT');
    });

    test('目标不在 rootNodeId 之下 → BRANCH_STORAGE_CORRUPT', () => {
        const g: ConversationBranchGraph = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: 'root',
            nodes: {
                root: node('root', null),
                orphan: node('orphan', null), // 第二个根（损坏图）
            },
            activeChildId: null,
            candidateSummaries: [],
        };
        expectBranchError(() => switchActivePath(g, 'orphan'), 'BRANCH_STORAGE_CORRUPT');
    });
});

describe('childrenIndex', () => {
    test('按 parentId 分组，子列表按 createdAt 升序（含已删除节点）', () => {
        let g = linearGraph();
        g = rerollCandidate(g, 'u', node('b', 'u', { role: 'model', createdAt: 5 }));
        g = insertNode(g, node('a_del', 'u', { role: 'model', createdAt: 4, deleted: true }));
        g = insertNode(g, node('u2', 'root', { role: 'user', createdAt: 6 }));
        const index = childrenIndex(g);
        expect(index.get('u')).toEqual(['a', 'a_del', 'b']);
        expect(index.get('root')).toEqual(['u', 'u2']);
        expect(index.get('a')).toBeUndefined();
    });
});

describe('validate', () => {
    test('合法图 → valid true，无问题', () => {
        const result = validate(linearGraph());
        expect(result.valid).toBe(true);
        expect(result.issues).toEqual([]);
    });

    test('reroll 后的图合法', () => {
        let g = linearGraph();
        g = rerollCandidate(g, 'u', node('b', 'u', { role: 'model', createdAt: 4 }));
        g = insertNode(g, node('a2', 'a', { role: 'model', createdAt: 5 }));
        expect(validate(g).valid).toBe(true);
    });

    test('parentId 指向缺失节点 → NODE_NOT_FOUND', () => {
        const g: ConversationBranchGraph = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: 'root',
            nodes: {
                root: { ...node('root', null), activeChildId: 'a' },
                a: node('a', 'ghost'),
            },
            activeChildId: 'a',
            candidateSummaries: [],
        };
        const result = validate(g);
        expect(result.valid).toBe(false);
        expect(result.issues.some(i => i.code === 'NODE_NOT_FOUND' && i.message.includes('parentId'))).toBe(true);
    });

    test('parentId 链成环 → INVALID_BRANCH_RELATION', () => {
        const g: ConversationBranchGraph = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: 'root',
            nodes: {
                root: node('root', null),
                a: node('a', 'b'),
                b: node('b', 'a'),
            },
            activeChildId: null,
            candidateSummaries: [],
        };
        const result = validate(g);
        expect(result.valid).toBe(false);
        expect(result.issues.some(i => i.code === 'INVALID_BRANCH_RELATION' && i.message.includes('cycle'))).toBe(true);
    });

    test('activeChildId 不是直接子节点 → INVALID_BRANCH_RELATION', () => {
        const g: ConversationBranchGraph = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: 'root',
            nodes: {
                root: { ...node('root', null), activeChildId: 'a' },
                u: node('u', 'root'),
                a: node('a', 'u'),
            },
            activeChildId: 'a',
            candidateSummaries: [],
        };
        const result = validate(g);
        expect(result.valid).toBe(false);
        expect(result.issues.some(i => i.code === 'INVALID_BRANCH_RELATION' && i.message.includes('direct child'))).toBe(true);
    });

    test('activeChildId 指向缺失节点 → NODE_NOT_FOUND', () => {
        const g: ConversationBranchGraph = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: 'root',
            nodes: {
                root: { ...node('root', null), activeChildId: 'ghost' },
            },
            activeChildId: 'ghost',
            candidateSummaries: [],
        };
        const result = validate(g);
        expect(result.issues.some(i => i.code === 'NODE_NOT_FOUND' && i.message.includes('activeChildId'))).toBe(true);
    });

    test('activeChildId 指向已删除节点 → INVALID_BRANCH_RELATION', () => {
        const g: ConversationBranchGraph = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: 'a',
            nodes: {
                root: { ...node('root', null), activeChildId: 'a' },
                a: { ...node('a', 'root'), deleted: true },
            },
            activeChildId: 'a',
            candidateSummaries: [],
        };
        const result = validate(g);
        expect(result.issues.some(i => i.code === 'INVALID_BRANCH_RELATION' && i.message.includes('deleted'))).toBe(true);
    });

    test('activeTailNodeId 不可达 → BRANCH_STORAGE_CORRUPT', () => {
        const g: ConversationBranchGraph = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: 'ghost',
            nodes: {
                root: { ...node('root', null), activeChildId: 'a' },
                a: node('a', 'root'),
            },
            activeChildId: 'a',
            candidateSummaries: [],
        };
        const result = validate(g);
        expect(result.issues.some(i => i.code === 'BRANCH_STORAGE_CORRUPT' && i.message.includes('not reachable'))).toBe(true);
    });

    test('graph.activeChildId 镜像不一致 → BRANCH_STORAGE_CORRUPT', () => {
        const g = linearGraph();
        g.activeChildId = 'wrong-mirror';
        const result = validate(g);
        expect(result.issues.some(i => i.code === 'BRANCH_STORAGE_CORRUPT' && i.message.includes('mirror'))).toBe(true);
    });

    test('单节点图（仅 root，无子节点）→ validate 通过（root.activeChildId undefined 与镜像 null 等价）', () => {
        const g = createEmptyBranchGraph();
        g.rootNodeId = 'root';
        g.activeTailNodeId = 'root';
        g.nodes = { root: node('root', null) };
        const result = validate(g);
        expect(result.valid).toBe(true);
        expect(result.issues).toEqual([]);
    });

    test('多根（第二个 parentId 为 null 的节点）→ INVALID_BRANCH_RELATION', () => {
        const g: ConversationBranchGraph = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: 'root',
            nodes: {
                root: node('root', null),
                other: node('other', null),
            },
            activeChildId: null,
            candidateSummaries: [],
        };
        const result = validate(g);
        expect(result.issues.some(i => i.code === 'INVALID_BRANCH_RELATION' && i.message.includes('multiple root'))).toBe(true);
    });

    test('候选摘要引用缺失节点 → BRANCH_STORAGE_CORRUPT', () => {
        const g = linearGraph();
        g.candidateSummaries = [{ nodeId: 'ghost', parentId: null, kind: 'normal', createdAt: 1, preview: 'x' }];
        const result = validate(g);
        expect(result.issues.some(i => i.code === 'BRANCH_STORAGE_CORRUPT' && i.message.includes('summary'))).toBe(true);
    });

    test('graph.version 与 BRANCH_GRAPH_VERSION 不符 → BRANCH_STORAGE_CORRUPT（BG-1）', () => {
        const g = linearGraph();
        g.version = 2; // 未来版本
        const result = validate(g);
        expect(result.valid).toBe(false);
        expect(result.issues.some(i => i.code === 'BRANCH_STORAGE_CORRUPT' && i.message.includes('version'))).toBe(true);

        const old = linearGraph();
        old.version = 0; // 非法/旧版本
        expect(validate(old).issues.some(i => i.code === 'BRANCH_STORAGE_CORRUPT' && i.message.includes('version'))).toBe(true);
    });

    test('activeTailNodeId 不是活跃链终端（指向中间节点）→ BRANCH_STORAGE_CORRUPT（BG-2）', () => {
        const g: ConversationBranchGraph = {
            version: 1,
            rootNodeId: 'root',
            activeTailNodeId: 'a', // 中间节点，链实际终端是 b
            nodes: {
                root: { ...node('root', null), activeChildId: 'a' },
                a: { ...node('a', 'root'), activeChildId: 'b' },
                b: node('b', 'a'),
            },
            activeChildId: 'a',
            candidateSummaries: [],
        };
        const result = validate(g);
        expect(result.valid).toBe(false);
        expect(result.issues.some(i => i.code === 'BRANCH_STORAGE_CORRUPT' && i.message.includes('terminal'))).toBe(true);
    });

    test('rootNodeId 为 null 但 activeTailNodeId 非空 → BRANCH_STORAGE_CORRUPT（BG-2）', () => {
        const g = { ...createEmptyBranchGraph(), activeTailNodeId: 'ghost' };
        const result = validate(g);
        expect(result.issues.some(i => i.code === 'BRANCH_STORAGE_CORRUPT' && i.message.includes('rootNodeId is null'))).toBe(true);
    });
});

describe('候选摘要 upsertCandidateSummary / removeCandidateSummary', () => {
    test('upsert 新增与覆盖', () => {
        let g = createEmptyBranchGraph();
        g = upsertCandidateSummary(g, { nodeId: 'a', parentId: 'root', kind: 'reroll', createdAt: 1, preview: '第一版' });
        g = upsertCandidateSummary(g, { nodeId: 'a', parentId: 'root', kind: 'reroll', createdAt: 2, preview: '第二版' });
        expect(g.candidateSummaries).toHaveLength(1);
        expect(g.candidateSummaries![0]).toMatchObject({ nodeId: 'a', preview: '第二版', createdAt: 2 });
    });

    test('remove 删除指定摘要', () => {
        let g = createEmptyBranchGraph();
        g = upsertCandidateSummary(g, { nodeId: 'a', parentId: 'root', kind: 'reroll', createdAt: 1, preview: 'x' });
        g = upsertCandidateSummary(g, { nodeId: 'b', parentId: 'root', kind: 'reroll', createdAt: 2, preview: 'y' });
        g = removeCandidateSummary(g, 'a');
        expect(g.candidateSummaries!.map(s => s.nodeId)).toEqual(['b']);
    });
});

describe('importLinearHistory（MIG-01 / BR-09 线性导入）', () => {
    test('线性历史导入：kind=imported、parentId 线性链接、活跃路径=全量、validate 通过', () => {
        const history = [
            { role: 'user', parts: [{ text: 'q1' }], id: 'u1', parentId: null, timestamp: 100 },
            { role: 'model', parts: [{ text: 'a1' }], id: 'm1', parentId: 'u1', timestamp: 200 },
            { role: 'user', parts: [{ text: 'q2' }], id: 'u2', parentId: 'm1', timestamp: 300 },
        ] as any;
        const g = importLinearHistory(history);
        expect(g.rootNodeId).toBe('u1');
        expect(g.activeTailNodeId).toBe('u2');
        expect(activePath(g)).toEqual(['u1', 'm1', 'u2']);
        expect(Object.values(g.nodes).every(n => n.kind === 'imported')).toBe(true);
        expect(g.nodes['u1']!.parentId).toBeNull();
        expect(g.nodes['m1']!.parentId).toBe('u1');
        expect(g.nodes['u2']!.parentId).toBe('m1');
        expect(validate(g).valid).toBe(true);
    });

    test('functionResponse 不独立成节点（决策 8）：parts 合并进前一个模型节点，后续 parentId 不悬空', () => {
        const history = [
            { role: 'user', parts: [{ text: 'q1' }], id: 'u1', parentId: null, timestamp: 100 },
            { role: 'model', parts: [{ functionCall: { id: 't1', name: 'toolA', args: {} } }], id: 'm1', parentId: 'u1', timestamp: 200 },
            { role: 'user', parts: [{ functionResponse: { id: 't1', name: 'toolA', response: { success: true } } }], id: 'fr1', parentId: 'm1', timestamp: 300, isFunctionResponse: true },
            { role: 'user', parts: [{ text: 'q2' }], id: 'u2', parentId: 'fr1', timestamp: 400 },
        ] as any;
        const g = importLinearHistory(history);
        // 不出现 fr1 节点
        expect(g.nodes['fr1']).toBeUndefined();
        // functionResponse parts 并入 m1
        expect(g.nodes['m1']!.parts).toHaveLength(2);
        expect(g.nodes['m1']!.parts![1]).toMatchObject({ functionResponse: { id: 't1' } });
        // u2 的 parentId 指向 m1（fr1 被吸收，不产生悬空引用）
        expect(g.nodes['u2']!.parentId).toBe('m1');
        expect(activePath(g)).toEqual(['u1', 'm1', 'u2']);
        expect(validate(g).valid).toBe(true);
    });

    test('连续多条 functionResponse 依次累积进同一模型节点', () => {
        const history = [
            { role: 'user', parts: [{ text: 'q' }], id: 'u1', parentId: null, timestamp: 1 },
            { role: 'model', parts: [{ text: 'calling' }], id: 'm1', parentId: 'u1', timestamp: 2 },
            { role: 'user', parts: [{ functionResponse: { id: 't1', response: { success: true } } }], id: 'f1', parentId: 'm1', timestamp: 3, isFunctionResponse: true },
            { role: 'user', parts: [{ functionResponse: { id: 't2', response: { success: true } } }], id: 'f2', parentId: 'f1', timestamp: 4, isFunctionResponse: true },
        ] as any;
        const g = importLinearHistory(history);
        expect(g.nodes['m1']!.parts).toHaveLength(3);
        expect(g.nodes['m1']!.parts![1]).toMatchObject({ functionResponse: { id: 't1' } });
        expect(g.nodes['m1']!.parts![2]).toMatchObject({ functionResponse: { id: 't2' } });
        expect(validate(g).valid).toBe(true);
    });

    test('消息无 id 时用确定性兜底 id；空历史 → 空图', () => {
        const g = importLinearHistory([
            { role: 'user', parts: [{ text: 'x' }] },
            { role: 'model', parts: [{ text: 'y' }] },
        ] as any);
        expect(Object.keys(g.nodes)).toEqual(['imported-0', 'imported-1']);
        expect(validate(g).valid).toBe(true);

        const empty = importLinearHistory([]);
        expect(empty.rootNodeId).toBeNull();
        expect(empty.nodes).toEqual({});
        expect(activePath(empty)).toEqual([]);
    });

    test('createdAt 沿消息顺序严格递增：相同 timestamp 也按序 +1（候选排序稳定）', () => {
        const g = importLinearHistory([
            { role: 'user', parts: [{ text: 'q1' }], id: 'u1', parentId: null, timestamp: 100 },
            { role: 'model', parts: [{ text: 'a1' }], id: 'm1', parentId: 'u1', timestamp: 100 },
            { role: 'user', parts: [{ text: 'q2' }], id: 'u2', parentId: 'm1', timestamp: 100 },
        ] as any);
        const createdAt = Object.values(g.nodes).map(n => n.createdAt);
        for (let i = 1; i < createdAt.length; i++) {
            expect(createdAt[i]).toBeGreaterThan(createdAt[i - 1]);
        }
        expect(createdAt).toEqual([100, 101, 102]);
        expect(validate(g).valid).toBe(true);
    });

    test('首条消息为 functionResponse（无前驱节点）→ console.warn 记录丢弃，不建节点（M-4）', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const g = importLinearHistory([
                { role: 'user', parts: [{ functionResponse: { id: 't1', name: 'toolA', response: { success: true } } }], id: 'fr0', timestamp: 1, isFunctionResponse: true },
                { role: 'user', parts: [{ text: 'q1' }], id: 'u1', parentId: null, timestamp: 2 },
            ] as any);
            // 首条 functionResponse 被丢弃且记录原因；后续正常消息成为根节点
            expect(g.nodes['fr0']).toBeUndefined();
            expect(g.rootNodeId).toBe('u1');
            expect(warnSpy).toHaveBeenCalled();
            const message = warnSpy.mock.calls.map(c => String(c[0])).join(' ');
            expect(message).toMatch(/functionResponse/);
            expect(message).toMatch(/no preceding node/);
            expect(validate(g).valid).toBe(true);
        } finally {
            warnSpy.mockRestore();
        }
    });
});

describe('TREE-09 软删除 / 恢复 / 重命名 / 修剪（纯函数）', () => {
    /** 线性图：root → u → a（活跃），并在 u 下追加非活跃候选 b 与 b 的子树 b2 */
    function branchedGraph(): ConversationBranchGraph {
        let g = linearGraph(); // root → u → a
        g = rerollCandidate(g, 'u', node('b', 'u', { role: 'model', createdAt: 4 }));
        g = insertNode(g, node('b2', 'b', { role: 'user', createdAt: 5 }), { setActive: false, updateTail: false });
        return g;
    }

    /** 使 b 变为非活跃（活跃子切回 a）并返回图 */
    function makeBInactive(g: ConversationBranchGraph): ConversationBranchGraph {
        return activateChild(g, 'u', 'a');
    }

    describe('isDeletedNodeExpired', () => {
        test('deleted + 超过保留期 → true；未超过 → false', () => {
            const now = 1000;
            const expired = { id: 'x', parentId: null, role: 'user' as const, parts: [], kind: 'normal' as const, createdAt: 100, deleted: true, deletedAt: 100 };
            expect(isDeletedNodeExpired(expired, now, 30)).toBe(false); // 900ms < 30 天
            expect(isDeletedNodeExpired(expired, now + 30 * 24 * 60 * 60 * 1000, 30)).toBe(true);
        });

        test('deletedAt 缺失（遗留软删）→ createdAt 兜底；两者都缺失 → 不过期', () => {
            const now = 1000;
            const legacy = { id: 'x', parentId: null, role: 'user' as const, parts: [], kind: 'normal' as const, createdAt: 100, deleted: true };
            expect(isDeletedNodeExpired(legacy, now + 30 * 24 * 60 * 60 * 1000, 30)).toBe(true);
            expect(isDeletedNodeExpired(legacy, now, 30)).toBe(false);
            const noDates = { id: 'y', parentId: null, role: 'user' as const, parts: [], kind: 'normal' as const, deleted: true } as any;
            expect(isDeletedNodeExpired(noDates, now + 10 ** 12, 30)).toBe(false);
        });

        test('未删除 / retentionDays<=0 → 永不过期', () => {
            const alive = { id: 'x', parentId: null, role: 'user' as const, parts: [], kind: 'normal' as const, createdAt: 100, deleted: false };
            expect(isDeletedNodeExpired(alive, 10 ** 12, 30)).toBe(false);
            const deleted = { ...alive, deleted: true, deletedAt: 1 };
            expect(isDeletedNodeExpired(deleted, 10 ** 12, 0)).toBe(false);
            expect(isDeletedNodeExpired(deleted, 10 ** 12, -1)).toBe(false);
        });
    });

    describe('softDeleteNode / restoreNode', () => {
        test('软删非活跃候选：deleted + deletedAt；摘要同步；父节点活跃子不受影响', () => {
            let g = makeBInactive(branchedGraph());
            g = upsertCandidateSummary(g, { nodeId: 'b', parentId: 'u', kind: 'reroll', createdAt: 4, preview: 'b' });
            const next = softDeleteNode(g, 'b', { deletedAt: 500 });
            expect(next.nodes['b'].deleted).toBe(true);
            expect(next.nodes['b'].deletedAt).toBe(500);
            expect(next.nodes['u'].activeChildId).toBe('a'); // 非活跃子删除不影响父活跃指针
            expect(next.candidateSummaries!.find(s => s.nodeId === 'b')!.deleted).toBe(true);
            expect(next.candidateSummaries!.find(s => s.nodeId === 'b')!.deletedAt).toBe(500);
            expect(validate(next).valid).toBe(true);
        });

        test('软删非活跃分支上被父节点指向的子节点：清空父 activeChildId（validate 不变量）', () => {
            // 构造非活跃分支：root → u2（非活跃），u2.activeChildId = c
            let g = linearGraph(); // root → u → a（活跃）
            g = insertNode(g, node('u2', 'root', { role: 'user', createdAt: 4 }), { setActive: false, updateTail: false });
            g = insertNode(g, node('c', 'u2', { role: 'model', createdAt: 5 }), { setActive: true, updateTail: false });
            expect(g.nodes['u2'].activeChildId).toBe('c');
            expect(activePath(g)).toEqual(['root', 'u', 'a']); // c 不在活跃路径上

            const next = softDeleteNode(g, 'c', { deletedAt: 1 });
            expect(next.nodes['c'].deleted).toBe(true);
            expect(next.nodes['u2'].activeChildId).toBeNull(); // 清空指针
            expect(validate(next).valid).toBe(true);
            expect(activePath(next)).toEqual(['root', 'u', 'a']); // 活跃路径不受影响
        });

        test('R8c-P1 级联软删整棵子树：子孙 deleted/deletedAt 同步，子树内 activeChildId 清空，validate 通过', () => {
            // u2（非活跃）→ c（激活）→ c1（激活）：删除分支头 c 必须级联软删 c1
            let g = linearGraph();
            g = insertNode(g, node('u2', 'root', { role: 'user', createdAt: 4 }), { setActive: false, updateTail: false });
            g = insertNode(g, node('c', 'u2', { role: 'model', createdAt: 5 }), { setActive: true, updateTail: false });
            g = insertNode(g, node('c1', 'c', { role: 'model', createdAt: 6 }), { setActive: true, updateTail: false });
            expect(g.nodes['c'].activeChildId).toBe('c1');

            const next = softDeleteNode(g, 'c', { deletedAt: 100 });
            expect(next.nodes['c'].deleted).toBe(true);
            expect(next.nodes['c'].deletedAt).toBe(100);
            expect(next.nodes['c1'].deleted).toBe(true); // 子孙同步软删（不再 live）
            expect(next.nodes['c1'].deletedAt).toBe(100);
            expect(next.nodes['c1'].parts).toEqual([{ text: 'c1' }]); // 内容保留（可恢复）
            expect(next.nodes['c'].activeChildId).toBeNull(); // 子树内指针清空（validate 不变量）
            expect(next.nodes['u2'].activeChildId).toBeNull(); // 父节点指针清空
            expect(collectDeletedNodes(next).sort()).toEqual(['c', 'c1']);
            expect(validate(next).valid).toBe(true);
            expect(activePath(next)).toEqual(['root', 'u', 'a']);
        });

        test('R8c-P1 级联软删保留已有 deletedAt（幂等语义：首次删除时间不变）', () => {
            let g = makeBInactive(branchedGraph());
            // 手工标记子孙 b2 已软删（旧数据），再级联软删分支头 b
            g = { ...g, nodes: { ...g.nodes, b2: { ...g.nodes['b2'], deleted: true, deletedAt: 42 } } };
            const next = softDeleteNode(g, 'b', { deletedAt: 500 });
            expect(next.nodes['b'].deletedAt).toBe(500);
            expect(next.nodes['b2'].deletedAt).toBe(42); // 子孙已有删除时间不被覆盖
            expect(validate(next).valid).toBe(true);
        });

        test('软删活跃路径上的节点 → BRANCH_OPERATION_CONFLICT', () => {
            const g = branchedGraph(); // b 是当前活跃子
            expectBranchError(() => softDeleteNode(g, 'b', {}), 'BRANCH_OPERATION_CONFLICT');
            expectBranchError(() => softDeleteNode(g, 'root', {}), 'BRANCH_OPERATION_CONFLICT');
        });

        test('软删缺失节点 → NODE_NOT_FOUND；restore 恢复后 deleted/deletedAt/摘要标记清除；重复软删幂等', () => {
            let g = makeBInactive(branchedGraph());
            expectBranchError(() => softDeleteNode(g, 'ghost', {}), 'NODE_NOT_FOUND');
            g = upsertCandidateSummary(g, { nodeId: 'b', parentId: 'u', kind: 'reroll', createdAt: 4, preview: 'b' });
            const once = softDeleteNode(g, 'b', { deletedAt: 100 });
            const twice = softDeleteNode(once, 'b', { deletedAt: 999 });
            expect(twice.nodes['b'].deletedAt).toBe(100); // 幂等：保留首次删除时间

            const restored = restoreNode(twice, 'b');
            expect(restored.nodes['b'].deleted).toBeUndefined();
            expect(restored.nodes['b'].deletedAt).toBeUndefined();
            expect(restored.candidateSummaries!.find(s => s.nodeId === 'b')!.deleted).toBeUndefined();
            expect(restored.candidateSummaries!.find(s => s.nodeId === 'b')!.deletedAt).toBeUndefined();
            expect(validate(restored).valid).toBe(true);
            // 未删除节点 restore 幂等
            expect(restoreNode(restored, 'b')).toBe(restored);
        });

        test('R8c-P1 restoreNode 级联恢复整棵子树：子孙 deleted/deletedAt 清除，摘要同步，validate 通过', () => {
            let g = makeBInactive(branchedGraph());
            g = upsertCandidateSummary(g, { nodeId: 'b', parentId: 'u', kind: 'reroll', createdAt: 4, preview: 'b' });
            const deleted = softDeleteNode(g, 'b', { deletedAt: 100 });
            expect(collectDeletedNodes(deleted).sort()).toEqual(['b', 'b2']); // 级联：整棵子树已软删

            const restored = restoreNode(deleted, 'b');
            expect(restored.nodes['b'].deleted).toBeUndefined();
            expect(restored.nodes['b2'].deleted).toBeUndefined();
            expect(restored.nodes['b2'].deletedAt).toBeUndefined();
            expect(restored.nodes['b2'].parts).toEqual([{ text: 'b2' }]); // 内容完整
            expect(restored.candidateSummaries!.find(s => s.nodeId === 'b')!.deleted).toBeUndefined();
            expect(collectDeletedNodes(restored)).toEqual([]);
            expect(validate(restored).valid).toBe(true);
        });
    });

    describe('renameBranchLabel', () => {
        test('只改 label（节点 + 摘要同步），contents 不动；空 label / 超长 → INVALID_BRANCH_RELATION', () => {
            let g = branchedGraph();
            g = upsertCandidateSummary(g, { nodeId: 'b', parentId: 'u', kind: 'reroll', createdAt: 4, preview: 'b' });
            const next = renameBranchLabel(g, 'b', '  我的分支  ');
            expect(next.nodes['b'].label).toBe('我的分支'); // trim
            expect(next.candidateSummaries!.find(s => s.nodeId === 'b')!.label).toBe('我的分支');
            expect(next.nodes['b'].parts).toEqual([{ text: 'b' }]); // contents 未动
            expect(validate(next).valid).toBe(true);

            expectBranchError(() => renameBranchLabel(g, 'b', '   '), 'INVALID_BRANCH_RELATION');
            expectBranchError(() => renameBranchLabel(g, 'b', 'x'.repeat(201)), 'INVALID_BRANCH_RELATION');
            expectBranchError(() => renameBranchLabel(g, 'ghost', 'x'), 'NODE_NOT_FOUND');
        });
    });

    describe('collectDeletedNodes', () => {
        test('R8c-P1 级联软删分支头后计数含整棵子树', () => {
            let g = makeBInactive(branchedGraph());
            g = softDeleteNode(g, 'b', { deletedAt: 1 }); // 级联：b2 一并软删
            expect(collectDeletedNodes(g).sort()).toEqual(['b', 'b2']);
        });
    });

    describe('pruneDeletedNodes / removeSubtree', () => {
        test('R8c-P1 过期分支头级联软删后 prune 物理清理整棵子树（无需逐个软删子孙）', () => {
            let g = makeBInactive(branchedGraph());
            g = upsertCandidateSummary(g, { nodeId: 'b', parentId: 'u', kind: 'reroll', createdAt: 4, preview: 'b' });
            g = upsertCandidateSummary(g, { nodeId: 'a', parentId: 'u', kind: 'reroll', createdAt: 3, preview: 'a' });
            const deletedAt = 1000;
            const now = deletedAt + 31 * 24 * 60 * 60 * 1000; // 31 天后（> 30 天保留期）
            // 只软删分支头 b：级联保证子孙 b2 已一并软删（prune 前 b2 内容可整体恢复）
            g = softDeleteNode(g, 'b', { deletedAt });

            const { graph: next, prunedNodeIds } = pruneDeletedNodes(g, { now, retentionDays: 30 });
            expect(prunedNodeIds.sort()).toEqual(['b', 'b2']);
            expect(next.nodes['b']).toBeUndefined();
            expect(next.nodes['b2']).toBeUndefined();
            expect(next.nodes['a']).toBeTruthy();
            expect(next.candidateSummaries!.find(s => s.nodeId === 'b')).toBeUndefined();
            expect(next.candidateSummaries!.find(s => s.nodeId === 'a')).toBeTruthy();
            expect(validate(next).valid).toBe(true);
            expect(activePath(next)).toEqual(['root', 'u', 'a']);
        });

        test('未过期软删节点保留；retentionDays=0 永不过期', () => {
            let g = makeBInactive(branchedGraph());
            g = softDeleteNode(g, 'b', { deletedAt: Date.now() });
            const r1 = pruneDeletedNodes(g, { now: Date.now(), retentionDays: 30 });
            expect(r1.prunedNodeIds).toEqual([]);
            expect(r1.graph.nodes['b']).toBeTruthy();
            const r2 = pruneDeletedNodes(g, { now: Date.now() + 10 ** 12, retentionDays: 0 });
            expect(r2.prunedNodeIds).toEqual([]);
        });

        test('removeSubtree：物理移除指定节点及其子树（不要求过期）', () => {
            let g = makeBInactive(branchedGraph());
            g = upsertCandidateSummary(g, { nodeId: 'b', parentId: 'u', kind: 'reroll', createdAt: 4, preview: 'b' });
            const { graph: next, prunedNodeIds } = removeSubtree(g, 'b');
            expect(prunedNodeIds.sort()).toEqual(['b', 'b2']);
            expect(next.nodes['b']).toBeUndefined();
            expect(next.nodes['b2']).toBeUndefined();
            expect(next.candidateSummaries!.find(s => s.nodeId === 'b')).toBeUndefined();
            expect(validate(next).valid).toBe(true);
            expectBranchError(() => removeSubtree(g, 'ghost'), 'NODE_NOT_FOUND');
        });

        test('prune 清理 exportedFrom / exportedRefs 引用；根节点被删时清空 root/tail/镜像', () => {
            let g = makeBInactive(branchedGraph());
            g = { ...g, exportedFrom: { conversationId: 'src', nodeId: 'b' }, exportedRefs: [{ targetConversationId: 't1', nodeId: 'b', exportedAt: 1 }, { targetConversationId: 't2', nodeId: 'a', exportedAt: 2 }] };
            const deletedAt = 1000;
            const now = deletedAt + 31 * 24 * 60 * 60 * 1000;
            g = softDeleteNode(g, 'b', { deletedAt }); // 级联：b2 一并软删
            const { graph: next } = pruneDeletedNodes(g, { now, retentionDays: 30 });
            expect(next.exportedFrom).toBeUndefined();
            expect(next.exportedRefs).toEqual([{ targetConversationId: 't2', nodeId: 'a', exportedAt: 2 }]);
            expect(validate(next).valid).toBe(true);

            // 根节点被删：root/tail/镜像清空（节点全删后为空图）
            let single = createEmptyBranchGraph();
            single = insertNode(single, node('root', null, { createdAt: 1 }));
            // 单节点图：root 即活跃路径 → softDeleteNode 会拒绝；直接手工标记（模拟遗留数据）
            single = { ...single, nodes: { root: { ...single.nodes['root'], deleted: true, deletedAt } } };
            const pruned = pruneDeletedNodes(single, { now, retentionDays: 30 });
            expect(pruned.graph.rootNodeId).toBeNull();
            expect(pruned.graph.activeTailNodeId).toBeNull();
            expect(pruned.graph.activeChildId).toBeNull();
            expect(validate(pruned.graph).valid).toBe(true);
        });
    });
});
