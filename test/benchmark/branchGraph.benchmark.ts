/**
 * MIG-09 基准 ③：大量分支（100 候选的分支图操作）。
 *
 * 覆盖生产模块：BranchGraph 纯函数（insertNode / rerollCandidate /
 * upsertCandidateSummary / activePath / validate / switchActivePath）。
 * 纯 CPU/内存基准，无磁盘 IO。
 *
 * R8e-FIX 修正：
 * - F4：reroll 压力段结束后保留 220 节点图，后续 validate / activePath / switch 均在该
 *   220 节点图上测量（原实现丢弃 reroll 结果，后续只跑 120 节点图）；
 * - F5：新增深链段——单一候选下连续 append 100 个子节点，再 switchActivePath 激活整条
 *   深链，让 activePath / switchActivePath 承受 100+ 层深度（原活跃路径深度仅 2）；
 * - F8：循环类测项计时前预跑 2 次（JIT 预热）；一次性建图段含预热开销（注释说明）。
 *
 * 运行方式（仓库根目录；命令中的 glob 见 test/benchmark/README.md）：
 *   npx jest --config jest.backend.config.js --testMatch <glob> --runInBand --testTimeout 600000
 */
import {
    activePath,
    createEmptyBranchGraph,
    insertNode,
    rerollCandidate,
    switchActivePath,
    upsertCandidateSummary,
    validate,
} from '../../backend/modules/conversation/branch/BranchGraph';
import type { ConversationBranchGraph, ConversationBranchNode } from '../../backend/modules/conversation/branch/types';
import { printHarnessBanner, printMetric, printSection, withTiming } from './benchmarkHarness';

jest.setTimeout(600000);

const BASE_MESSAGES = 20; // 10 user + 10 model 的线性基线
const CANDIDATE_COUNT = 100; // 10 个用户父节点 × 各 10 候选（与 BranchService 每父节点 10 候选上限一致）
const OPS = 100; // 每个操作重复次数
const DEEP_COUNT = 100; // 深链段：单一候选下连续 append 的子节点数

function makeNode(id: string, parentId: string | null, role: 'user' | 'model', kind: ConversationBranchNode['kind'] = 'normal'): ConversationBranchNode {
    return {
        id,
        parentId,
        role,
        parts: [{ text: `${id} content` }],
        kind,
        createdAt: Date.now(),
        timestamp: Date.now(),
        modelVersion: role === 'model' ? 'benchmark-model' : undefined,
    };
}

describe('MIG-09 基准 ③ 大量分支（100 候选）', () => {
    test('100 候选：建图 / reroll / activePath / validate / switch + 深链', async () => {
        printHarnessBanner();
        printSection('MIG-09 基准 ③ 分支图（基线 20 节点 + 100 候选，纯 CPU）');

        // ---- 0. 线性基线（20 节点）----
        let graph: ConversationBranchGraph = createEmptyBranchGraph();
        for (let i = 0; i < BASE_MESSAGES; i++) {
            const node = makeNode(`base_${i}`, i === 0 ? null : `base_${i - 1}`, i % 2 === 0 ? 'user' : 'model');
            graph = insertNode(graph, node, { setActive: true, updateTail: true });
        }
        // 10 个用户父节点（base_0, base_2, ..., base_18）
        const userParents = Array.from({ length: 10 }, (_, i) => `base_${i * 2}`);

        // ---- 1. 建 100 候选（每父节点 10 个）----
        // 一次性测量（F8 注）：单发调用含 JIT 预热开销，属该段固有成本，不计入任何 perOp 指标。
        const build = await withTiming(async () => {
            let g = graph;
            let count = 0;
            for (let c = 0; c < CANDIDATE_COUNT; c++) {
                const parentId = userParents[c % userParents.length];
                const node = makeNode(`cand_${c}`, parentId, 'model', 'reroll');
                g = rerollCandidate(g, parentId, node, { updateTail: true });
                g = upsertCandidateSummary(g, {
                    nodeId: node.id,
                    parentId,
                    kind: 'reroll',
                    createdAt: node.createdAt,
                    timestamp: node.timestamp,
                    modelVersion: node.modelVersion,
                    label: `候选 ${c}`,
                    preview: '',
                });
                count++;
            }
            return { graph: g, count };
        });
        graph = build.result.graph;
        expect(Object.keys(graph.nodes).length).toBe(BASE_MESSAGES + CANDIDATE_COUNT);
        printMetric({
            label: `建图：${CANDIDATE_COUNT} 候选（rerollCandidate+summary）`,
            ms: build.ms,
            heapDeltaMB: build.heapDeltaMB,
            data: { nodes: Object.keys(graph.nodes).length, candidates: CANDIDATE_COUNT },
        });

        // ---- 2. reroll ×100（新候选压入已有 100 候选的图）----
        // JIT 预热（F8）：计时前预跑 2 次（纯函数，结果丢弃）
        rerollCandidate(graph, userParents[0], makeNode('warm_r0', userParents[0], 'model', 'reroll'), { updateTail: true });
        rerollCandidate(graph, userParents[1], makeNode('warm_r1', userParents[1], 'model', 'reroll'), { updateTail: true });
        const reroll = await withTiming(async () => {
            let g = graph;
            for (let i = 0; i < OPS; i++) {
                const parentId = userParents[i % userParents.length];
                const node = makeNode(`reroll_run_${i}`, parentId, 'model', 'reroll');
                g = rerollCandidate(g, parentId, node, { updateTail: true });
            }
            return { graph: g, nodeCount: Object.keys(g.nodes).length };
        });
        graph = reroll.result.graph; // F4：保留 220 节点压力图，后续操作都在这张图上跑
        printMetric({
            label: `reroll ×${OPS}（每次新建候选并激活）`,
            ms: reroll.ms,
            heapDeltaMB: reroll.heapDeltaMB,
            data: { nodes: reroll.result.nodeCount, perOpMs: +(reroll.ms / OPS).toFixed(3) },
        });

        // ---- 3. activePath ×100（220 节点图；JIT 预热预跑 2 次）----
        activePath(graph);
        activePath(graph);
        const pathOp = await withTiming(async () => {
            let length = 0;
            for (let i = 0; i < OPS; i++) {
                length = activePath(graph).length;
            }
            return { pathLength: length };
        });
        printMetric({
            label: `activePath ×${OPS}`,
            ms: pathOp.ms,
            heapDeltaMB: pathOp.heapDeltaMB,
            data: { nodes: Object.keys(graph.nodes).length, pathLength: pathOp.result.pathLength, perOpMs: +(pathOp.ms / OPS).toFixed(3) },
        });

        // ---- 4. validate ×100（220 节点图；JIT 预热）----
        validate(graph);
        validate(graph);
        const validation = await withTiming(async () => {
            let valid = true;
            for (let i = 0; i < OPS; i++) {
                valid = validate(graph).valid;
            }
            return { valid };
        });
        expect(validation.result.valid).toBe(true);
        printMetric({
            label: `validate ×${OPS}`,
            ms: validation.ms,
            heapDeltaMB: validation.heapDeltaMB,
            data: { nodes: Object.keys(graph.nodes).length, perOpMs: +(validation.ms / OPS).toFixed(3) },
        });

        // ---- 5. switchActivePath ×100（两个候选间来回切换；220 节点图；JIT 预热）----
        switchActivePath(graph, 'cand_0');
        switchActivePath(graph, 'cand_1');
        const switchOp = await withTiming(async () => {
            let g = graph;
            const a = `cand_0`;
            const b = `cand_1`;
            for (let i = 0; i < OPS; i++) {
                g = switchActivePath(g, i % 2 === 0 ? a : b);
            }
            return { tail: g.activeTailNodeId };
        });
        printMetric({
            label: `switchActivePath ×${OPS}`,
            ms: switchOp.ms,
            heapDeltaMB: switchOp.heapDeltaMB,
            data: { perOpMs: +(switchOp.ms / OPS).toFixed(3) },
        });

        // ---- 6. 深链场景（F5）：单一候选下连续 append 子节点 → 深活跃路径 ----
        // 既有活跃路径深度仅 2（候选轮询挂 10 个 user 父节点，activeChildId 链收敛长度 2），
        // 深链段从当前活跃尾连续 append DEEP_COUNT 个节点，再用 switchActivePath 激活整条深链，
        // 让 activePath / switchActivePath 承受 100+ 层深度压力。
        const deepBuild = await withTiming(async () => {
            let g = graph;
            let parent = g.activeTailNodeId; // 当前活跃尾（reroll_run_99）
            for (let i = 0; i < DEEP_COUNT; i++) {
                const node = makeNode(`deep_${i}`, parent, i % 2 === 0 ? 'user' : 'model');
                g = insertNode(g, node, { setActive: true, updateTail: true });
                parent = node.id;
            }
            // 激活深链：switchActivePath 重建 root → 链尾 的 activeChildId 链
            g = switchActivePath(g, `deep_${DEEP_COUNT - 1}`);
            return { graph: g, pathLength: activePath(g).length };
        });
        graph = deepBuild.result.graph;
        const deepPathLength = deepBuild.result.pathLength;
        // 深链挂在当前活跃尾（reroll_run_90）下：活跃前缀 base_0 → reroll_run_90 共 2 节点 +
        // 深链 100 节点 = 102 层；断言 > 深链节点数即证明已激活为深路径。
        expect(deepPathLength).toBeGreaterThan(DEEP_COUNT);
        printMetric({
            label: `建深链 ${DEEP_COUNT} 节点并激活（insertNode+switch）`,
            ms: deepBuild.ms,
            heapDeltaMB: deepBuild.heapDeltaMB,
            data: { nodes: Object.keys(graph.nodes).length, pathLength: deepPathLength },
        });

        // 深链 activePath ×100（JIT 预热）
        activePath(graph);
        activePath(graph);
        const deepPathOp = await withTiming(async () => {
            let length = 0;
            for (let i = 0; i < OPS; i++) {
                length = activePath(graph).length;
            }
            return { pathLength: length };
        });
        expect(deepPathOp.result.pathLength).toBe(deepPathLength);
        printMetric({
            label: `activePath ×${OPS}（深链 ${DEEP_COUNT} 层）`,
            ms: deepPathOp.ms,
            heapDeltaMB: deepPathOp.heapDeltaMB,
            data: { pathLength: deepPathOp.result.pathLength, perOpMs: +(deepPathOp.ms / OPS).toFixed(3) },
        });

        // 深链 switchActivePath ×100（深链尾 ↔ 浅候选；JIT 预热）
        switchActivePath(graph, `deep_${DEEP_COUNT - 1}`);
        switchActivePath(graph, 'cand_0');
        const deepSwitchOp = await withTiming(async () => {
            let g = graph;
            for (let i = 0; i < OPS; i++) {
                g = switchActivePath(g, i % 2 === 0 ? `deep_${DEEP_COUNT - 1}` : 'cand_0');
            }
            return { tail: g.activeTailNodeId, pathLength: activePath(g).length };
        });
        printMetric({
            label: `switchActivePath ×${OPS}（深链 ${DEEP_COUNT} 层 ↔ 浅候选）`,
            ms: deepSwitchOp.ms,
            heapDeltaMB: deepSwitchOp.heapDeltaMB,
            data: { pathLength: deepSwitchOp.result.pathLength, perOpMs: +(deepSwitchOp.ms / OPS).toFixed(3) },
        });

        // ---- smoke 断言（校准：2026-08-04 R8e-FIX 实测全部 < 20ms；
        //      上限 1000ms ≈ 50×+，微操作用例防 CI 慢机误报）----
        expect(build.ms).toBeLessThan(1_000);
        expect(reroll.ms).toBeLessThan(1_000);
        expect(pathOp.ms).toBeLessThan(1_000);
        expect(validation.ms).toBeLessThan(1_000);
        expect(switchOp.ms).toBeLessThan(1_000);
        expect(deepBuild.ms).toBeLessThan(1_000);
        expect(deepPathOp.ms).toBeLessThan(1_000);
        expect(deepSwitchOp.ms).toBeLessThan(1_000);

        console.log(
            `\n  [smoke] build ${build.ms.toFixed(1)}ms / reroll×100 ${reroll.ms.toFixed(1)}ms / activePath×100 ${pathOp.ms.toFixed(1)}ms / validate×100 ${validation.ms.toFixed(1)}ms / switch×100 ${switchOp.ms.toFixed(1)}ms / deep(100层) ${deepBuild.ms.toFixed(1)}ms+${deepPathOp.ms.toFixed(1)}ms+${deepSwitchOp.ms.toFixed(1)}ms（上限 1000ms）→ OK`
        );
    });
});
