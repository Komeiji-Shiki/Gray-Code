/**
 * McpManager 连接生命周期并发测试
 *
 * 覆盖：
 * - 并发 connect 复用 in-flight promise（避免第二个调用方"假成功"）
 * - 并发 connect 失败时所有调用方都收到错误（不出现假成功）
 * - disconnect 中止 in-flight connect，且旧连接失败不覆盖新连接状态（代际校验）
 * - 旧 client 的 exit/error 回调不删除、不覆盖新 client（代际校验）
 */
import { McpManager } from '../../modules/mcp/McpManager';
import { InMemoryMcpStorageAdapter } from '../../modules/mcp/storage';
import { StdioMcpClient } from '../../modules/mcp/StdioClient';

function makeTestInput(overrides: Record<string, any> = {}) {
    return {
        name: 'Race Server',
        transport: {
            type: 'stdio' as const,
            command: 'echo',
            args: ['hello'],
        },
        enabled: true,
        autoConnect: false,
        ...overrides,
    };
}

describe('McpManager connect lifecycle races', () => {
    let storage: InMemoryMcpStorageAdapter;
    let manager: McpManager;

    beforeEach(() => {
        storage = new InMemoryMcpStorageAdapter();
        manager = new McpManager(storage);
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        try {
            await manager.dispose();
        } catch {
            // 忽略清理失败
        }
    });

    async function createStdioServer(id: string): Promise<string> {
        await manager.initialize();
        return await manager.createServer(
            makeTestInput({
                name: id,
                // 使用 node REPL 作为命令：进程会持续存活直到被显式 kill，
                // 避免测试过程中真实进程自行退出干扰时序（代际校验本身能处理，但会增加不确定性）
                transport: { type: 'stdio', command: 'node', args: [] },
            }),
            id
        );
    }

    /** 等待 connect 调用推进到 in-flight（client 已注册且状态为 connecting） */
    async function waitForConnecting(id: string): Promise<void> {
        for (let i = 0; i < 50; i++) {
            if ((manager as any).clients.has(id) && manager.getServerStatus(id) === 'connecting') {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error(`connect did not reach connecting state for ${id}`);
    }

    // ==================== 并发 connect 复用 in-flight promise ====================

    it('should reuse the same in-flight connect promise for concurrent connect calls', async () => {
        const id = await createStdioServer('dedupe_srv');

        const connectSpy = jest.spyOn(StdioMcpClient.prototype, 'connect')
            .mockImplementation(() => new Promise(resolve => setTimeout(resolve, 20)));

        const p1 = manager.connect(id);
        const p2 = manager.connect(id);

        await Promise.all([p1, p2]);
        expect(connectSpy).toHaveBeenCalledTimes(1);
        expect(manager.getServerStatus(id)).toBe('connected');
    });

    it('should propagate connect failure to all concurrent callers (no fake success)', async () => {
        const id = await createStdioServer('fail_shared_srv');

        jest.spyOn(StdioMcpClient.prototype, 'connect')
            .mockImplementation(() => Promise.reject(new Error('server boom')));

        const p1 = manager.connect(id);
        const p2 = manager.connect(id);

        await expect(p1).rejects.toThrow('server boom');
        await expect(p2).rejects.toThrow('server boom');
        expect(manager.getServerStatus(id)).toBe('error');
    });

    // ==================== disconnect 期间旧连接失败不覆盖新连接 ====================

    it('should not let an old failed connect clobber a newer successful connection', async () => {
        const id = await createStdioServer('gen_srv');

        let rejectOld!: (e: Error) => void;
        let resolveNew!: () => void;
        const connectSpy = jest.spyOn(StdioMcpClient.prototype, 'connect');
        connectSpy.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
        connectSpy.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));

        // 连接 A 挂起
        const p1 = manager.connect(id);
        await waitForConnecting(id);

        // disconnect 中止 A
        await manager.disconnect(id);
        expect(manager.getServerStatus(id)).toBe('disconnected');

        // 连接 B 成功
        const p2 = manager.connect(id);
        await waitForConnecting(id);
        resolveNew();
        await p2;
        expect(manager.getServerStatus(id)).toBe('connected');

        // 旧连接 A 的失败回调晚到，不得覆盖 B 的状态
        rejectOld(new Error('late failure'));
        await expect(p1).rejects.toThrow('late failure');
        expect(manager.getServerStatus(id)).toBe('connected');
    });

    it('should ignore late exit/error events from an old client (must not delete the new client)', async () => {
        const id = await createStdioServer('late_exit_srv');

        let resolveNew!: () => void;
        const connectSpy = jest.spyOn(StdioMcpClient.prototype, 'connect');
        connectSpy.mockImplementationOnce(() => new Promise(() => {})); // A 永久挂起
        connectSpy.mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));

        const p1 = manager.connect(id);
        await waitForConnecting(id);

        // 抓住旧 client 引用
        const clients = (manager as any).clients as Map<string, any>;
        const clientA = clients.get(id);
        expect(clientA).toBeDefined();

        await manager.disconnect(id);

        // 新连接 B 成功
        const p2 = manager.connect(id);
        await waitForConnecting(id);
        const clientB = clients.get(id);
        expect(clientB).not.toBe(clientA);
        resolveNew();
        await p2;
        expect(clients.get(id)).toBe(clientB);
        expect(manager.getServerStatus(id)).toBe('connected');

        // 旧 client 的 exit/error 回调晚到：代际校验应使其无效
        clientA.emit('exit', 0, null);
        clientA.emit('error', new Error('old client error'));

        expect(clients.get(id)).toBe(clientB);
        expect(manager.getServerStatus(id)).toBe('connected');

        // p1 的 client.connect 被 mock 永久挂起，不会 settle；无需等待
        void p1;
    });
});
