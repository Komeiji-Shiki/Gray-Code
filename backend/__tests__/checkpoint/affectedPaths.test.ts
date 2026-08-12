/**
 * CP-PARTIAL-1：工具执行存档「受影响路径」提取与部分快照测试。
 *
 * 覆盖：
 * - extractAffectedPaths 单元测试：白名单工具提取 / search_in_files 模式判定 /
 *   非白名单工具回退 / 相对路径 resolve / 绝对路径原样 / 路径穿越防御 / 参数非法
 * - workspaceUriToFsPath：file:// URI 解码为 fsPath；非 file:// 回退 null
 * - buildWorkspaceSnapshot 部分快照分支（affectedPaths 非空）：
 *   只哈希受影响路径 / 不存在 → unreadable / 忽略规则 → excluded /
 *   previous 复用 / 空目录 / 多根归属 / 越界路径跳过 / 缺省保持全量
 * - 链路透传（createToolLoopHarness）：批次检查点 options 携带 affectedPaths（去重），
 *   批内含副作用不可知工具时回退全量（不传 affectedPaths）
 */
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
    buildWorkspaceSnapshot,
    createRuntimeWorkspaceRoots,
    createWorkspaceScopedPath,
    type SnapshotBuildOptions
} from '../../modules/checkpoint';
import { createTempWorkspace } from '../__fixtures__/checkpointFixtures';
import { createToolLoopHarness } from '../__fixtures__/harnessFixtures';
import {
    extractAffectedPaths,
    workspaceUriToFsPath
} from '../../modules/checkpoint/affectedPaths';
import type { CheckpointRecord } from '../../modules/checkpoint';

async function writeFile(rootDir: string, relativePath: string, content: string = ''): Promise<void> {
    const fullPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
}

function md5(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex');
}

describe('extractAffectedPaths', () => {
    const root = path.resolve('/ws');

    test('白名单工具提取 args.path（相对路径 resolve 到工作区根）', () => {
        for (const name of ['write_file', 'apply_diff', 'insert_code', 'delete_code', 'delete_file', 'create_directory']) {
            expect(extractAffectedPaths(name, { path: 'src/a.ts' }, root))
                .toEqual([path.resolve(root, 'src/a.ts')]);
        }
    });

    test('search_in_files：replace 模式提取 path，search 模式/缺省模式返回 null', () => {
        expect(extractAffectedPaths('search_in_files', { mode: 'replace', path: 'src/a.ts' }, root))
            .toEqual([path.resolve(root, 'src/a.ts')]);
        expect(extractAffectedPaths('search_in_files', { mode: 'search', path: 'src/a.ts' }, root)).toBeNull();
        expect(extractAffectedPaths('search_in_files', { path: 'src/a.ts' }, root)).toBeNull();
    });

    test('非白名单工具（execute_command/read_file 等）→ null', () => {
        expect(extractAffectedPaths('execute_command', { command: 'ls' }, root)).toBeNull();
        expect(extractAffectedPaths('read_file', { path: 'a.ts' }, root)).toBeNull();
        expect(extractAffectedPaths('list_files', {}, root)).toBeNull();
        expect(extractAffectedPaths('get_symbols', { path: 'a.ts' }, root)).toBeNull();
        expect(extractAffectedPaths('subagents', {}, root)).toBeNull();
    });

    test('绝对路径原样保留（resolve 规范化）', () => {
        const abs = path.join(root, 'sub', 'a.ts');
        expect(extractAffectedPaths('write_file', { path: abs }, root)).toEqual([abs]);
    });

    test('路径穿越防御：../ 逃逸工作区根 → null', () => {
        expect(extractAffectedPaths('write_file', { path: '../escape.ts' }, root)).toBeNull();
        expect(extractAffectedPaths('write_file', { path: 'sub/../../escape.ts' }, root)).toBeNull();
        expect(extractAffectedPaths('write_file', { path: path.join(root, '..', 'escape.ts') }, root)).toBeNull();
    });

    test('路径边界：兄弟前缀目录（/ws-outside）不属于工作区根（/ws）→ null', () => {
        const sibling = path.join(path.dirname(root), 'ws-outside', 'a.ts');
        expect(extractAffectedPaths('write_file', { path: sibling }, root)).toBeNull();
    });

    test('args.path 非字符串/为空/缺失 → null', () => {
        expect(extractAffectedPaths('write_file', { path: 123 }, root)).toBeNull();
        expect(extractAffectedPaths('write_file', { path: '' }, root)).toBeNull();
        expect(extractAffectedPaths('write_file', {}, root)).toBeNull();
        expect(extractAffectedPaths('write_file', undefined, root)).toBeNull();
        expect(extractAffectedPaths('write_file', null, root)).toBeNull();
    });

    test('workspaceUriToFsPath：file:// 解码为 fsPath；非 file:// 返回 null', () => {
        expect(workspaceUriToFsPath('')).toBeNull();
        expect(workspaceUriToFsPath('vscode-remote://server/path')).toBeNull();
        if (process.platform === 'win32') {
            expect(workspaceUriToFsPath('file:///C%3A/Users/test%20ws')).toBe('C:\\Users\\test ws');
            expect(workspaceUriToFsPath('file:///C:/Users/test')).toBe('C:\\Users\\test');
        } else {
            expect(workspaceUriToFsPath('file:///home/user/ws')).toBe('/home/user/ws');
        }
    });
});

describe('buildWorkspaceSnapshot - CP-PARTIAL-1 部分快照分支', () => {
    function makeRoots(rootDir: string, name = 'ws') {
        return createRuntimeWorkspaceRoots([
            { name, uri: `file:///${rootDir.replace(/\\/g, '/')}`, fsPath: rootDir }
        ]);
    }

    test('只传受影响路径 → fileHashes 只含这些路径（工作区其他文件不在结果中）', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'a.ts', 'AAA');
            await writeFile(rootDir, 'b.ts', 'BBB');
            await writeFile(rootDir, 'c.ts', 'CCC');

            const roots = makeRoots(rootDir);
            const result = await buildWorkspaceSnapshot({
                roots,
                affectedPaths: [path.join(rootDir, 'a.ts'), path.join(rootDir, 'b.ts')]
            });

            const root = roots[0];
            expect(result.fileHashes).toEqual({
                [createWorkspaceScopedPath(root.id, 'a.ts')]: md5('AAA'),
                [createWorkspaceScopedPath(root.id, 'b.ts')]: md5('BBB')
            });
            expect(result.fileHashes[createWorkspaceScopedPath(root.id, 'c.ts')]).toBeUndefined();
            expect(result.roots[0]).toMatchObject({ rootId: root.id, fileCount: 2 });
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('受影响路径不存在（ENOENT）→ unreadable，不进 fileHashes', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'a.ts', 'AAA');

            const roots = makeRoots(rootDir);
            const missing = path.join(rootDir, 'gone.ts');
            const result = await buildWorkspaceSnapshot({ roots, affectedPaths: [missing] });

            const scoped = createWorkspaceScopedPath(roots[0].id, 'gone.ts');
            expect(result.unreadable).toEqual([{ scopedPath: scoped, reason: 'unreadable' }]);
            // unreadable 同样进入 excluded（与全量分支一致，EX-09）
            expect(result.excluded).toContainEqual({ path: scoped, reason: 'unreadable' });
            expect(result.fileHashes[scoped]).toBeUndefined();
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('受影响路径被忽略规则排除 → excluded（reason=custom），不进 fileHashes', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'debug.log', 'log');
            await writeFile(rootDir, 'src/a.ts', 'code');

            const roots = makeRoots(rootDir);
            const result = await buildWorkspaceSnapshot({
                roots,
                customIgnorePatterns: ['*.log'],
                affectedPaths: [path.join(rootDir, 'debug.log'), path.join(rootDir, 'src', 'a.ts')]
            });

            const logScoped = createWorkspaceScopedPath(roots[0].id, 'debug.log');
            expect(result.excluded).toContainEqual(
                expect.objectContaining({ path: logScoped, reason: 'custom', source: 'custom' })
            );
            expect(result.fileHashes[logScoped]).toBeUndefined();
            expect(result.fileHashes[createWorkspaceScopedPath(roots[0].id, 'src/a.ts')]).toBe(md5('code'));
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('previous 复用生效（stat 未变时复用上一快照哈希，不重复读盘）', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'a.ts', 'stable content');

            const roots = makeRoots(rootDir);
            const scoped = createWorkspaceScopedPath(roots[0].id, 'a.ts');

            const first = await buildWorkspaceSnapshot({ roots, affectedPaths: [path.join(rootDir, 'a.ts')] });
            expect(first.fileHashes[scoped]).toBe(md5('stable content'));

            // 伪造 previous 哈希 + 真实 stat（stat 未变 → 应直接复用伪造值，证明没重新读盘）
            const fakeHash = 'f'.repeat(32);
            const fakePrevious: SnapshotBuildOptions['previous'] = {
                fileHashes: { [scoped]: fakeHash },
                fileStats: {
                    [scoped]: {
                        mtimeMs: first.fileStats[scoped].mtimeMs,
                        size: first.fileStats[scoped].size,
                        mtimeNs: first.fileStats[scoped].mtimeNs
                    }
                }
            };
            const second = await buildWorkspaceSnapshot({
                roots,
                affectedPaths: [path.join(rootDir, 'a.ts')],
                previous: fakePrevious
            });
            expect(second.fileHashes[scoped]).toBe(fakeHash);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('目录受影响路径：仅空目录进 emptyDirs（非空目录不递归，其内文件单独处理）', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await fs.mkdir(path.join(rootDir, 'empty'), { recursive: true });
            await fs.mkdir(path.join(rootDir, 'nonempty'), { recursive: true });
            await writeFile(rootDir, 'nonempty/x.txt', 'x');

            const roots = makeRoots(rootDir);
            const result = await buildWorkspaceSnapshot({
                roots,
                affectedPaths: [
                    path.join(rootDir, 'empty'),
                    path.join(rootDir, 'nonempty'),
                    path.join(rootDir, 'nonempty', 'x.txt')
                ]
            });

            expect(result.emptyDirs).toContain(createWorkspaceScopedPath(roots[0].id, 'empty'));
            expect(result.emptyDirs).not.toContain(createWorkspaceScopedPath(roots[0].id, 'nonempty'));
            expect(result.fileHashes[createWorkspaceScopedPath(roots[0].id, 'nonempty/x.txt')]).toBe(md5('x'));
            expect(result.roots[0].fileCount).toBe(1);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('多根：受影响路径按所属根分别统计', async () => {
        const rootA = await createTempWorkspace();
        const rootB = await createTempWorkspace();
        try {
            await writeFile(rootA, 'a.txt', 'AAA');
            await writeFile(rootB, 'b.txt', 'BBB');

            const roots = createRuntimeWorkspaceRoots([
                { name: 'A', uri: `file:///${rootA.replace(/\\/g, '/')}`, fsPath: rootA },
                { name: 'B', uri: `file:///${rootB.replace(/\\/g, '/')}`, fsPath: rootB }
            ]);
            const rootAInfo = roots.find(root => root.name === 'A')!;
            const rootBInfo = roots.find(root => root.name === 'B')!;
            const result = await buildWorkspaceSnapshot({
                roots,
                affectedPaths: [path.join(rootA, 'a.txt'), path.join(rootB, 'b.txt')]
            });

            expect(result.fileHashes[createWorkspaceScopedPath(rootAInfo.id, 'a.txt')]).toBe(md5('AAA'));
            expect(result.fileHashes[createWorkspaceScopedPath(rootBInfo.id, 'b.txt')]).toBe(md5('BBB'));
            const statA = result.roots.find(r => r.rootId === rootAInfo.id)!;
            const statB = result.roots.find(r => r.rootId === rootBInfo.id)!;
            expect(statA.fileCount).toBe(1);
            expect(statB.fileCount).toBe(1);
        } finally {
            await fs.rm(rootA, { recursive: true, force: true });
            await fs.rm(rootB, { recursive: true, force: true });
        }
    });

    test('不在任何工作区根内的受影响路径被跳过（不影响其他路径）', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'a.ts', 'AAA');

            const roots = makeRoots(rootDir);
            const outside = path.join(path.dirname(rootDir), 'outside-dir', 'x.ts');
            const result = await buildWorkspaceSnapshot({
                roots,
                affectedPaths: [outside, path.join(rootDir, 'a.ts')]
            });

            expect(result.fileHashes[createWorkspaceScopedPath(roots[0].id, 'a.ts')]).toBe(md5('AAA'));
            expect(result.roots[0].fileCount).toBe(1);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('缺省 affectedPaths（undefined / 空数组）保持全量扫描（既有行为不变）', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'a.ts', 'AAA');
            await writeFile(rootDir, 'b.ts', 'BBB');

            const roots = makeRoots(rootDir);
            const full = await buildWorkspaceSnapshot({ roots });
            expect(Object.keys(full.fileHashes)).toHaveLength(2);

            const emptyAffected = await buildWorkspaceSnapshot({ roots, affectedPaths: [] });
            expect(Object.keys(emptyAffected.fileHashes)).toHaveLength(2);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });
});

describe('CP-PARTIAL-1 链路透传（ToolIterationLoopService 批次检查点）', () => {
    const config = { type: 'custom', toolMode: 'function_call', model: 'test-model' } as never;

    function makeTool(name: string) {
        return {
            declaration: {
                name,
                description: `${name} stub`,
                parameters: { type: 'object', properties: {}, required: [] }
            },
            handler: async () => ({ success: true, data: { output: 'ok' } })
        };
    }

    function seedCheckpointRecords(checkpointService: { createToolExecutionCheckpoint: jest.Mock }) {
        let seq = 0;
        checkpointService.createToolExecutionCheckpoint.mockImplementation(
            async (_cid: string, messageIndex: number, toolName: string, phase: 'before' | 'after') => ({
                id: `cp-${phase}-${++seq}`,
                conversationId: _cid,
                messageIndex,
                toolName,
                phase,
                timestamp: Date.now(),
                backupDir: 'backup',
                fileCount: 0,
                contentHash: 'h'
            } as CheckpointRecord)
        );
    }

    async function collectOutputs(service: ReturnType<typeof createToolLoopHarness>['service'], options: Record<string, unknown>) {
        const outputs: unknown[] = [];
        for await (const output of service.runToolLoop({
            conversationId: 'conv-cp-partial',
            configId: 'cfg-1',
            config,
            maxIterations: 2,
            ...options
        })) {
            outputs.push(output);
        }
        return outputs;
    }

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('纯主循环批次：before/after 选项透传受影响路径（同一路径去重）', async () => {
        const applyTool = makeTool('apply_diff');
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            yield { delta: [{ functionCall: { id: 'call_1', name: 'apply_diff', args: { path: 'a.ts' } } }] };
            yield { delta: [{ functionCall: { id: 'call_2', name: 'apply_diff', args: { path: 'a.ts' } } }] };
            yield { delta: [{ functionCall: { id: 'call_3', name: 'apply_diff', args: { path: 'b.ts' } } }] };
            yield { delta: [], done: true };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service, conversationManager, checkpointService } = createToolLoopHarness(channelManager, {
            getTool: () => applyTool
        });
        seedCheckpointRecords(checkpointService);
        // 注入工作区 URI（harness 默认 getMetadata 返回 null = 未绑定工作区）
        (conversationManager.getMetadata as jest.Mock).mockResolvedValue({ workspaceUri: 'file:///C:/test-ws' });

        await collectOutputs(service, {});

        expect(checkpointService.createToolExecutionCheckpoint).toHaveBeenCalledTimes(2);
        const cpCalls = (checkpointService.createToolExecutionCheckpoint as jest.Mock).mock.calls;
        expect(cpCalls[0][2]).toBe('tool_batch');
        expect(cpCalls[1][2]).toBe('tool_batch');
        const workspaceRootFsPath = workspaceUriToFsPath('file:///C:/test-ws')!;
        const expected = [path.resolve(workspaceRootFsPath, 'a.ts'), path.resolve(workspaceRootFsPath, 'b.ts')];
        // 去重：两个 apply_diff 同一路径只保留一次；before/after 都透传
        expect(cpCalls[0][5].affectedPaths).toEqual(expected);
        expect(cpCalls[1][5].affectedPaths).toEqual(expected);
    });

    test('批内含副作用不可知工具（execute_command）→ 回退全量（options 不传 affectedPaths）', async () => {
        const tools: Record<string, ReturnType<typeof makeTool>> = {
            write_file: makeTool('write_file'),
            execute_command: makeTool('execute_command')
        };
        async function* stream() {
            yield { delta: [{ text: 'hello' }] };
            yield { delta: [{ functionCall: { id: 'call_1', name: 'write_file', args: { path: 'a.ts' } } }] };
            yield { delta: [{ functionCall: { id: 'call_2', name: 'execute_command', args: { command: 'x' } } }] };
            yield { delta: [], done: true };
        }
        const channelManager = { generate: jest.fn().mockReturnValue(stream()) };
        const { service, conversationManager, checkpointService } = createToolLoopHarness(channelManager, {
            getTool: (name?: string) => tools[name ?? ''] ?? makeTool('stub')
        });
        seedCheckpointRecords(checkpointService);
        (conversationManager.getMetadata as jest.Mock).mockResolvedValue({ workspaceUri: 'file:///C:/test-ws' });

        await collectOutputs(service, {});

        // 任一工具无法确定 → 整批回退全量：after（全部工具已知后创建）的 options 不含 affectedPaths
        const cpCalls = (checkpointService.createToolExecutionCheckpoint as jest.Mock).mock.calls;
        const afterCall = cpCalls.find(c => c[3] === 'after');
        expect(afterCall).toBeDefined();
        expect(afterCall![5]).not.toHaveProperty('affectedPaths');
        expect(afterCall![5].batchToolNames).toEqual(
            expect.arrayContaining(['write_file', 'execute_command'])
        );
    });
});
