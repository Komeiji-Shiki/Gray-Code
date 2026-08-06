/**
 * memory_wake / memory_recall 工具双作用域（全局 + 工作区）回归测试：
 * 1. 无工作区：wake 只输出全局段（行为与旧版一致）
 * 2. 有工作区且工作区有记忆：输出包含全局段 + 工作区段（带标注）
 * 3. 有工作区但工作区无记忆：只输出全局段
 * 4. 全局与工作区记忆互不干扰（wake 两段各含自己的内容）
 * 5. 双作用域都为空：输出 No memories yet
 * 6. memory_recall 合并两个作用域的命中结果并标注来源
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
    MemoryManager,
    setGlobalMemoryManager,
    setWorkspaceMemoryBaseDir,
    getMemoryManagerForWorkspace,
} from '../../modules/memory';
import { createMemoryWakeTool } from '../../tools/memory/memory_wake';
import { createMemoryRecallTool } from '../../tools/memory/memory_recall';

function uriOf(fsPath: string): string {
    return 'file:///' + fsPath.replace(/\\/g, '/');
}

async function wake(activeWorkspaceUri?: string): Promise<any> {
    const tool = createMemoryWakeTool();
    return await tool.handler(
        {},
        activeWorkspaceUri ? { activeWorkspaceUri } as any : undefined
    ) as any;
}

/** 带参数的 wake 调用（part/snapshotT 续读场景） */
async function wakeWith(args: Record<string, unknown>, activeWorkspaceUri?: string): Promise<any> {
    const tool = createMemoryWakeTool();
    return await tool.handler(
        args,
        activeWorkspaceUri ? { activeWorkspaceUri } as any : undefined
    ) as any;
}

async function recall(regex: string, activeWorkspaceUri?: string): Promise<any> {
    const tool = createMemoryRecallTool();
    return await tool.handler(
        { regex },
        activeWorkspaceUri ? { activeWorkspaceUri } as any : undefined
    ) as any;
}

describe('memory 工具双作用域（全局 + 工作区）', () => {
    let globalDir: string;
    let wsBaseDir: string;
    let wsDir: string;
    let globalMm: MemoryManager;

    beforeEach(() => {
        globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-global-'));
        wsBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ws-base-'));
        wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ws-'));
        globalMm = new MemoryManager(globalDir);
        setWorkspaceMemoryBaseDir(wsBaseDir);
    });

    afterEach(() => {
        setGlobalMemoryManager(null);
        setWorkspaceMemoryBaseDir(null);
        for (const dir of [globalDir, wsBaseDir, wsDir]) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('无工作区：wake 只输出全局段（行为与旧版一致）', async () => {
        await globalMm.init();
        await globalMm.note('global-memory-alpha');
        setGlobalMemoryManager(globalMm);

        const result = await wake();
        expect(result.success).toBe(true);
        expect(result.data.text).toContain('global-memory-alpha');
        expect(result.data.text).not.toContain('Workspace memory');
        expect(result.data.workspace).toBeUndefined();
        expect(result.data.totalMemories).toBe(1);
    });

    it('有工作区且工作区有记忆：输出包含全局段 + 工作区段（带标注）', async () => {
        await globalMm.init();
        await globalMm.note('global-memory-alpha');
        setGlobalMemoryManager(globalMm);

        const wsMm = await getMemoryManagerForWorkspace(uriOf(wsDir));
        await wsMm!.note('workspace-memory-beta');

        const result = await wake(uriOf(wsDir));
        expect(result.success).toBe(true);
        expect(result.data.text).toContain('--- Global memory ---');
        expect(result.data.text).toContain('global-memory-alpha');
        expect(result.data.text).toContain('--- Workspace memory (');
        expect(result.data.text).toContain('workspace-memory-beta');
        expect(result.data.workspace).toEqual({ uri: uriOf(wsDir), totalMemories: 1 });
    });

    it('有工作区但工作区无记忆：只输出全局段', async () => {
        await globalMm.init();
        await globalMm.note('global-memory-alpha');
        setGlobalMemoryManager(globalMm);

        // 触发工作区 manager 惰性创建（无记忆）
        const wsMm = await getMemoryManagerForWorkspace(uriOf(wsDir));
        expect(wsMm).not.toBeNull();
        expect(await wsMm!.totalEntries()).toBe(0);

        const result = await wake(uriOf(wsDir));
        expect(result.success).toBe(true);
        expect(result.data.text).toContain('global-memory-alpha');
        expect(result.data.text).not.toContain('Workspace memory');
        expect(result.data.workspace).toEqual({ uri: uriOf(wsDir), totalMemories: 0 });
    });

    it('全局与工作区记忆互不干扰：wake 两段各含自己的内容', async () => {
        await globalMm.init();
        await globalMm.note('global-memory-alpha');
        setGlobalMemoryManager(globalMm);

        const wsMm = await getMemoryManagerForWorkspace(uriOf(wsDir));
        await wsMm!.note('workspace-memory-beta');

        const result = await wake(uriOf(wsDir));
        expect(result.success).toBe(true);

        // 按段首标注切开，校验两段内容互不混入
        const [globalSection, wsSection] = result.data.text.split('--- Workspace memory (');
        expect(globalSection).toContain('global-memory-alpha');
        expect(globalSection).not.toContain('workspace-memory-beta');
        expect(wsSection).toContain('workspace-memory-beta');
        expect(wsSection).not.toContain('global-memory-alpha');
    });

    it('双作用域都为空：输出 No memories yet', async () => {
        await globalMm.init();
        setGlobalMemoryManager(globalMm);

        const result = await wake(uriOf(wsDir));
        expect(result.success).toBe(true);
        expect(result.data.text).toContain('No memories yet');
        expect(result.data.text).toContain('You are awake.');
    });

    it('memory_recall 合并全局与工作区命中并标注来源', async () => {
        await globalMm.init();
        await globalMm.note('shared-topic-aaa');
        setGlobalMemoryManager(globalMm);

        const wsMm = await getMemoryManagerForWorkspace(uriOf(wsDir));
        await wsMm!.note('shared-topic-bbb');

        const result = await recall('shared-topic', uriOf(wsDir));
        expect(result.success).toBe(true);
        expect(result.data.text).toContain('--- Global memory ---');
        expect(result.data.text).toContain('shared-topic-aaa');
        // 工作区段头与 wake 一致：带文件夹名（--- Workspace memory (name) ---）
        expect(result.data.text).toContain('--- Workspace memory (');
        expect(result.data.text).toContain('shared-topic-bbb');
        expect(result.data.totalHits).toBe(2);

        // 无工作区时只搜全局
        const globalOnly = await recall('shared-topic');
        expect(globalOnly.data.text).toContain('--- Global memory ---');
        expect(globalOnly.data.text).not.toContain('--- Workspace memory ---');
        expect(globalOnly.data.totalHits).toBe(1);
    });

    it('跨作用域 snapshotT 不匹配：续读时工作区用自身总数重试，内容不丢', async () => {
        await globalMm.init();
        // 缩小分页（每 part 2 行）便于构造多段：全局 5 条 → 3 段，工作区 4 条 → 2 段
        await globalMm.updateConfig({ partLines: 2 });
        for (let i = 0; i < 5; i++) await globalMm.note(`gl-${i}`);
        setGlobalMemoryManager(globalMm);

        const wsMm = await getMemoryManagerForWorkspace(uriOf(wsDir));
        await wsMm!.updateConfig({ partLines: 2 });
        for (let i = 0; i < 4; i++) await wsMm!.note(`ws-${i}`);

        // 模型沿用全局快照总数（5）续读 part=2；工作区实际只有 4 条 → T= 不匹配，
        // 不应被误判为「已读完」而跳过——用工作区自身总数重试后 part 2 内容不丢
        const result = await wakeWith({ part: 2, snapshotT: 5 }, uriOf(wsDir));
        expect(result.success).toBe(true);

        // 全局 part 2 正常返回
        expect(result.data.text).toContain('gl-2');
        expect(result.data.text).toContain('gl-3');
        // 工作区 part 2 仍在输出中（未被当作已读完跳过）
        expect(result.data.text).toContain('--- Workspace memory (');
        expect(result.data.text).toContain('ws-2');
        expect(result.data.text).toContain('ws-3');

        // 顶层元数据为两段合并口径
        expect(result.data.totalMemories).toBe(9);
        expect(result.data.totalParts).toBe(5); // 3（全局）+ 2（工作区）
        expect(result.data.part).toBe(2);
        expect(result.data.awake).toBe(false);
    });

    it('两段都未完：续读提示带 nextPart（共用 part 推进）', async () => {
        await globalMm.init();
        await globalMm.updateConfig({ partLines: 2 });
        for (let i = 0; i < 5; i++) await globalMm.note(`gl-${i}`);
        setGlobalMemoryManager(globalMm);

        const wsMm = await getMemoryManagerForWorkspace(uriOf(wsDir));
        await wsMm!.updateConfig({ partLines: 2 });
        for (let i = 0; i < 4; i++) await wsMm!.note(`ws-${i}`);

        const result = await wake(uriOf(wsDir));
        expect(result.success).toBe(true);
        // 两段各自的第 1 部分都输出了，且都未读完 → 提示 nextPart=2
        expect(result.data.text).toContain('gl-0');
        expect(result.data.text).toContain('ws-0');
        expect(result.data.text).toContain('Not awake yet. Run: memory_wake part=2');
        expect(result.data.awake).toBe(false);
        expect(result.data.totalMemories).toBe(9);
    });

    it('压缩提示带作用域标注（[Global]/[Workspace]）', async () => {
        await globalMm.init();
        await globalMm.note('g-alpha');
        await globalMm.note('g-beta');
        setGlobalMemoryManager(globalMm);

        const wsMm = await getMemoryManagerForWorkspace(uriOf(wsDir));
        await wsMm!.note('w-alpha');
        await wsMm!.note('w-beta');

        const result = await wake(uriOf(wsDir));
        expect(result.success).toBe(true);
        expect(result.data.text).toContain('You are awake.');
        expect(result.data.text).toContain('[Global] Compress:');
        expect(result.data.text).toContain('[Workspace] Compress:');
        // data.pendingCompression 合并两段提示文本（带作用域标注）
        expect(result.data.pendingCompression?.prompt).toContain('[Global] Compress:');
        expect(result.data.pendingCompression?.prompt).toContain('[Workspace] Compress:');
    });

    it('只读 wake 不创建工作区记忆目录（createIfMissing=false）', async () => {
        await globalMm.init();
        await globalMm.note('global-only');
        setGlobalMemoryManager(globalMm);

        // 工作区目录从未被创建（不调用 getMemoryManagerForWorkspace）
        expect(fs.readdirSync(wsBaseDir)).toHaveLength(0);

        const result = await wake(uriOf(wsDir));
        expect(result.success).toBe(true);
        // 只读 wake 不应创建目录 / scope.json
        expect(fs.readdirSync(wsBaseDir)).toHaveLength(0);
        // 输出只有全局段，且没有工作区元信息
        expect(result.data.text).toContain('global-only');
        expect(result.data.text).not.toContain('Workspace memory');
        expect(result.data.workspace).toBeUndefined();
        expect(result.data.totalMemories).toBe(1);
    });
});
