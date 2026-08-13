/**
 * 分支图内存缓存（拆分自 BranchService.ts 的模块级缓存）。
 *
 * 主历史每次 append 都在会话写锁内「读 branches.json → 改 → 原子写回」，
 * 读图路径（分支切换 / usageStats / Monitor）也无缓存；大图反复读改写是磁盘 IO 热路径。
 * 这里按分支文件完整路径（baseDir + conversationId，天然区分多工作区/多数据目录）做短 TTL 缓存：
 * - 写入（validateAndSave / saveBranchGraph）成功后回填快照，deleteConversationBranch 失效；
 * - 读取命中返回缓存的只读引用（不再 structuredClone 整张图——大图含工具结果，深拷贝是
 *   工具循环每次迭代的主要开销）；读侧约定只读：调用方需要修改必须先自行拷贝
 *   （webview 富化响应前浅拷贝，见 BranchHandlers.enrichGraphWorkspaceInfo）；
 * - 写路径（loadGraphCached）与缓存条目共享同一对象，但全部图变更函数（insertNode /
 *   updateNodeContent / switchActivePath 等）均为纯函数（内部 cloneGraph），不会原地修改
 *   共享条目；validateAndSave 落盘后以快照重新回填（写侧独立克隆契约不变）；
 * - 每次命中前 stat 文件（mtime + size，与 storage.readSegmentCached 同模式）：文件被
 *   仓储之外的路径直接改写（测试/外部工具）时缓存自动失效重读，不依赖 TTL 过期；
 * - 损坏/缺失态不缓存（错误降级路径保持原语义）。
 */

import * as fsp from 'fs/promises';
import type { BranchGraphRepository } from './BranchGraphRepository';
import type { ConversationBranchGraph } from './types';

const BRANCH_GRAPH_CACHE_TTL_MS = 60_000;
/** 分支图缓存条目上限（会话数）：超限按最久未访问淘汰（与 ConversationManager 的 LRU 同模式） */
const BRANCH_GRAPH_CACHE_CAPACITY = 200;

interface BranchGraphCacheEntry {
    graph: ConversationBranchGraph;
    expiresAt: number;
    mtimeMs: number | null;
    size: number | null;
}

const branchGraphCache = new Map<string, BranchGraphCacheEntry>();

export function getBranchGraphCacheKey(repository: BranchGraphRepository, conversationId: string): string {
    return repository.getBranchesFilePath(conversationId);
}

function statBranchesFile(filePath: string): Promise<{ mtimeMs: number | null; size: number | null }> {
    return fsp.stat(filePath)
        .then(st => ({ mtimeMs: st.mtimeMs, size: st.size }))
        .catch(() => ({ mtimeMs: null, size: null }));
}

/** LRU 触碰 + 容量淘汰（与 ConversationManager.touchCache 同模式） */
function touchBranchGraphCache(key: string): void {
    const value = branchGraphCache.get(key);
    if (value !== undefined) {
        branchGraphCache.delete(key);
        branchGraphCache.set(key, value);
    }
    if (branchGraphCache.size > BRANCH_GRAPH_CACHE_CAPACITY) {
        const oldest = branchGraphCache.keys().next().value;
        if (oldest !== undefined) {
            branchGraphCache.delete(oldest);
        }
    }
}

/**
 * 命中返回缓存图的只读引用（不再深拷贝）；过期 / 文件被外部改写 / 未命中返回 null。
 * 调用方必须保持只读纪律（图变更函数均为纯函数，不会破坏该契约）。
 */
export async function getBranchGraphCached(key: string): Promise<ConversationBranchGraph | null> {
    const entry = branchGraphCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        branchGraphCache.delete(key);
        return null;
    }
    const stat = await statBranchesFile(key);
    if (stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size) {
        // 文件在缓存后被仓储之外的路径改写：缓存陈旧，失效后走磁盘重读
        branchGraphCache.delete(key);
        return null;
    }
    touchBranchGraphCache(key);
    return entry.graph;
}

/** 写入成功后回填快照（并刷新 TTL）；存快照防止调用方后续修改污染缓存 */
export async function setBranchGraphCached(key: string, graph: ConversationBranchGraph): Promise<void> {
    const stat = await statBranchesFile(key);
    branchGraphCache.set(key, {
        graph: structuredClone(graph),
        expiresAt: Date.now() + BRANCH_GRAPH_CACHE_TTL_MS,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
    });
    touchBranchGraphCache(key);
}

/** 删除单个缓存条目（deleteConversationBranch 失效用） */
export function deleteBranchGraphCached(key: string): void {
    branchGraphCache.delete(key);
}

/** 供测试/诊断清理分支图缓存（可选按会话，不传清空全部） */
export function invalidateBranchGraphCache(conversationId?: string): void {
    if (!conversationId) {
        branchGraphCache.clear();
        return;
    }
    for (const key of branchGraphCache.keys()) {
        if (key.endsWith(`/${conversationId}/branches.json`) || key.endsWith(`\\${conversationId}\\branches.json`)) {
            branchGraphCache.delete(key);
        }
    }
}
