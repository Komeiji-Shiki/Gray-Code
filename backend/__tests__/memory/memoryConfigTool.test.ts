/**
 * memory_config 工具作用域路由回归测试：
 * 1. 无工作区：读取全局配置（success + 默认值）
 * 2. 工作区已初始化：读取全局共享配置（config 全局共享一份，数据仍按工作区隔离）
 * 3. 工作区未初始化 + 纯读：回退显示全局配置并标注 workspaceNotInitialized，不创建目录（无磁盘副作用）
 * 4. 工作区未初始化 + 有更新参数：创建工作区目录并写入全局共享配置（全局实例读到同一值）
 * 5. workspaceUri 不可解析 + 纯读：报 "workspace URI could not be resolved"（不静默回退全局）
 * 6. 全局实例未初始化 + 无工作区：报 "MemoryManager is not initialized."
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
    MemoryManager,
    setGlobalMemoryManager,
    setWorkspaceMemoryBaseDir,
    setGlobalMemoryConfigPath,
    getMemoryManagerForWorkspace,
    DEFAULT_MEMORY_CONFIG,
} from '../../modules/memory';
import { createMemoryConfigTool } from '../../tools/memory/memory_config';

function uriOf(fsPath: string): string {
    return 'file:///' + fsPath.replace(/\\/g, '/');
}

async function configTool(args: Record<string, unknown>, activeWorkspaceUri?: string): Promise<any> {
    const tool = createMemoryConfigTool();
    return await tool.handler(
        args,
        activeWorkspaceUri ? { activeWorkspaceUri } as any : undefined
    ) as any;
}

describe('memory_config 工具作用域路由', () => {
    let globalDir: string;
    let wsBaseDir: string;
    let globalMm: MemoryManager;

    beforeEach(() => {
        globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cfg-global-'));
        wsBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-cfg-ws-base-'));
        globalMm = new MemoryManager(globalDir);
        setGlobalMemoryManager(globalMm);
        setWorkspaceMemoryBaseDir(wsBaseDir);
        // 配置全局统一：所有作用域共享 <globalDir>/config（与 initMemoryManager 行为一致）
        setGlobalMemoryConfigPath(path.join(globalDir, 'config'));
    });

    afterEach(() => {
        setGlobalMemoryManager(null);
        setWorkspaceMemoryBaseDir(null);
        setGlobalMemoryConfigPath(null);
        for (const dir of [globalDir, wsBaseDir]) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('无工作区：读取全局配置', async () => {
        const res = await configTool({});
        expect(res.success).toBe(true);
        expect(res.data.workspaceNotInitialized).toBeUndefined();
        expect(res.data.config).toEqual(DEFAULT_MEMORY_CONFIG);
    });

    test('工作区已初始化：读取全局共享配置（工作区写入后全局读到同一值）', async () => {
        // 先通过带更新参数调用初始化工作区记忆目录并写入共享配置
        const wsUri = uriOf(path.join(os.tmpdir(), 'mm-cfg-ws-inited'));
        const upd = await configTool({ entryChars: 290 }, wsUri);
        expect(upd.success).toBe(true);
        expect(upd.data.config.entryChars).toBe(290);

        // 再只读：显示的是共享配置（290），且不标注未初始化
        const res = await configTool({}, wsUri);
        expect(res.success).toBe(true);
        expect(res.data.workspaceNotInitialized).toBeUndefined();
        expect(res.data.config.entryChars).toBe(290);

        // 配置全局共享：全局实例从同一份 config 文件读到 290（不再是各自独立默认值）
        expect((await globalMm.loadConfig()).entryChars).toBe(290);
    });

    test('工作区未初始化 + 纯读：回退全局配置并标注，不创建目录', async () => {
        const wsUri = uriOf(path.join(os.tmpdir(), 'mm-cfg-ws-absent'));
        const res = await configTool({}, wsUri);
        expect(res.success).toBe(true);
        expect(res.data.workspaceNotInitialized).toBe(true);
        expect(res.data.config).toEqual(DEFAULT_MEMORY_CONFIG);
        expect(res.data.text).toContain('showing global config');
        // 无磁盘副作用：baseDir 下不应出现任何工作区子目录
        expect(fs.readdirSync(wsBaseDir)).toHaveLength(0);
    });

    test('工作区未初始化 + 有更新参数：创建工作区目录并写全局共享配置', async () => {
        const wsUri = uriOf(path.join(os.tmpdir(), 'mm-cfg-ws-create'));
        const res = await configTool({ entryChars: 290 }, wsUri);
        expect(res.success).toBe(true);
        expect(res.data.config.entryChars).toBe(290);
        // 工作区目录已创建（baseDir 下出现 hash 子目录）
        expect(fs.readdirSync(wsBaseDir).length).toBeGreaterThan(0);
        // 配置写入全局共享 config 文件：全局实例 loadConfig 读到同一值
        expect((await globalMm.loadConfig()).entryChars).toBe(290);
    });

    test('全局与工作区实例共享 entryChars 配置（双向同步）', async () => {
        // 全局 updateConfig 后，工作区实例 loadConfig/getConfig 读到同一值
        await globalMm.updateConfig({ entryChars: 800 });
        const wsUri = uriOf(path.join(os.tmpdir(), 'mm-cfg-ws-shared'));
        const wsMm = await getMemoryManagerForWorkspace(wsUri);
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
        setGlobalMemoryManager(null);
        const res = await configTool({});
        expect(res.success).toBe(false);
        expect(res.error).toContain('MemoryManager is not initialized');
    });
});
