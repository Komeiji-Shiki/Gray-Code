import { memoryEngineFixture } from '../__fixtures__/memoryEngine';
import { createEngineeringLogTool } from '../../tools/memory/engineeringLog';
import type { MemoryEngine } from '../../modules/memory/MemoryEngine';
import { DEFAULT_MEMORY_CONFIG } from '../../modules/memory/types';

let memory: Awaited<ReturnType<typeof memoryEngineFixture>>;
/**
 * engineering_log config 操作的作用域路由回归测试：
 * 1. 无工作区：读取全局配置（success + 默认值）
 * 2. 工作区已初始化：读取全局共享配置（config 全局共享一份，数据仍按工作区隔离）
 * 3. 工作区未初始化 + 纯读：回退显示全局配置并标注 workspaceNotInitialized，不创建作用域
 * 4. 工作区未初始化 + 有更新参数：初始化工作区并写入共享配置（全局实例读到同一值）
 * 5. workspaceUri 不可解析 + 纯读：报 "workspace URI could not be resolved"（不静默回退全局）
 * 6. 全局实例未初始化 + 无工作区：报 "MemoryManager is not initialized."
 */

async function configTool(args: Record<string, unknown>, activeWorkspaceUri?: string): Promise<any> {
    const tool = createEngineeringLogTool(memory.host);
    return await tool.handler(
        { ...args, action: 'config' },
        activeWorkspaceUri ? { activeWorkspaceUri } as any : undefined
    ) as any;
}

describe('engineering_log config 操作的作用域路由', () => {
    let globalMm: MemoryEngine;

    beforeEach(async () => {
        memory = await memoryEngineFixture();
        globalMm = memory.engine;
    });

    afterEach(async () => {
        await memory.cleanup();
    });

    test('无工作区：读取全局配置', async () => {
        const res = await configTool({});
        expect(res.success).toBe(true);
        expect(res.data.workspaceNotInitialized).toBeUndefined();
        expect(res.data.config).toEqual(DEFAULT_MEMORY_CONFIG);
    });

    test('工作区已初始化：读取全局共享配置（工作区写入后全局读到同一值）', async () => {
        // 先通过带更新参数调用初始化工作区宿主并写入共享配置。
        const wsUri = memory.workspaceUri;
        const upd = await configTool({ entryChars: 290 }, wsUri);
        expect(upd.success).toBe(true);
        expect(upd.data.config.entryChars).toBe(290);

        // 再只读：显示的是共享配置（290），且不标注未初始化
        const res = await configTool({}, wsUri);
        expect(res.success).toBe(true);
        expect(res.data.workspaceNotInitialized).toBeUndefined();
        expect(res.data.config.entryChars).toBe(290);

        // 不同作用域通过同一配置端口读取账号共享参数。
        expect((await globalMm.loadConfig()).entryChars).toBe(290);
    });

    test('工作区未初始化 + 纯读：回退全局配置并标注，不创建作用域', async () => {
        const wsUri = memory.workspaceUri;
        const res = await configTool({}, wsUri);
        expect(res.success).toBe(true);
        expect(res.data.workspaceNotInitialized).toBe(true);
        expect(res.data.config).toEqual(DEFAULT_MEMORY_CONFIG);
        expect(res.data.text).toContain('showing global config');
        // 只读配置请求不能要求宿主创建工作区。
        expect(memory.hasWorkspace()).toBe(false);
    });

    test('工作区未初始化 + 有更新参数：初始化工作区并写共享配置', async () => {
        const wsUri = memory.workspaceUri;
        const res = await configTool({ entryChars: 290 }, wsUri);
        expect(res.success).toBe(true);
        expect(res.data.config.entryChars).toBe(290);
        // 写入请求允许宿主初始化工作区。
        expect(memory.hasWorkspace()).toBe(true);
        // 全局实例重新读取后取得同一值。
        expect((await globalMm.loadConfig()).entryChars).toBe(290);
    });

    test('全局与工作区实例共享 entryChars 配置（双向同步）', async () => {
        // 全局 updateConfig 后，工作区实例 loadConfig/getConfig 读到同一值
        await globalMm.updateConfig({ entryChars: 800 });
        const wsUri = memory.workspaceUri;
        const wsMm = await memory.host.getMemoryManagerForWorkspace(wsUri);
        expect(wsMm).not.toBeNull();
        // 工作区 init() 不得覆盖已存在的共享 config（仍为 800，而非默认 280）
        expect((await wsMm!.loadConfig()).entryChars).toBe(800);
        expect(wsMm!.getConfig().entryChars).toBe(800);
        // 反向：工作区实例 updateConfig 后，全局实例 loadConfig 读到同一值
        await wsMm!.updateConfig({ entryChars: 900 });
        expect((await globalMm.loadConfig()).entryChars).toBe(900);
        expect(globalMm.getConfig().entryChars).toBe(900);
    });

    test('workspaceUri 不可解析 + 纯读：报 URI 解析失败，不静默回退', async () => {
        const res = await configTool({}, 'file:///bad%');
        expect(res.success).toBe(false);
        expect(res.error).toContain('workspace URI could not be resolved');
    });

    test('全局实例未初始化 + 无工作区：报 MemoryManager is not initialized', async () => {
        memory.setGlobalAvailable(false);
        const res = await configTool({});
        expect(res.success).toBe(false);
        expect(res.error).toContain('MemoryManager is not initialized');
    });
});
