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
        setGlobalMemoryManager(null as any);
        setWorkspaceMemoryBaseDir(null as any);
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
        expect(result.data.text).toContain('--- Workspace memory ---');
        expect(result.data.text).toContain('shared-topic-bbb');
        expect(result.data.totalHits).toBe(2);

        // 无工作区时只搜全局
        const globalOnly = await recall('shared-topic');
        expect(globalOnly.data.text).toContain('--- Global memory ---');
        expect(globalOnly.data.text).not.toContain('--- Workspace memory ---');
        expect(globalOnly.data.totalHits).toBe(1);
    });
});
