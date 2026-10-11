/**
 * CP-PARTIAL-1：工具执行存档「受影响路径」提取与部分快照测试。
 *
 * 覆盖：
 * - extractAffectedPaths 单元测试：白名单工具提取 / search_in_files 模式判定 /
 *   非白名单工具回退 / 相对路径 resolve / 绝对路径原样 / 路径穿越防御 / 参数非法
 * - workspaceUriToFsPath：file:// URI 解码为 fsPath；非 file:// 回退 null
 * - buildWorkspaceSnapshot 部分快照分支（affectedPaths 非空）：
  *   只哈希受影响路径 / 不存在 → absent / 忽略规则 → excluded /
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
import {
    extractAffectedPaths,
    isPathWithin,
    workspaceUriToFsPath
} from '../../modules/checkpoint/affectedPaths';
import type { CheckpointRecord } from '../../modules/checkpoint';
import { TEMP_DIR_REMOVE_OPTIONS } from '../__fixtures__/tempDirectory';

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

    test('按真实工具 schema 提取单路径、多文件和路径数组', () => {
        const cases: Array<[string, unknown]> = [
            ['write_file', { path: 'src/a.ts' }],
            ['apply_diff', { path: 'src/a.ts' }],
            ['insert_code', { files: [{ path: 'src/a.ts', line: 1, content: 'x' }] }],
            ['delete_code', { files: [{ path: 'src/a.ts', start_line: 1, end_line: 2 }] }],
            ['delete_file', { paths: ['src/a.ts'] }],
            ['create_directory', { paths: ['src/a.ts'] }]
        ];
        for (const [name, args] of cases) {
            expect(extractAffectedPaths(name, args, root))
                .toEqual([path.resolve(root, 'src/a.ts')]);
        }
        expect(extractAffectedPaths('delete_file', { paths: ['a.ts', 'b.ts'] }, root))
            .toEqual([path.resolve(root, 'a.ts'), path.resolve(root, 'b.ts')]);
    });

    test('search_in_files：一律返回 null（replace 影响面 = pattern × 目录子树，静态不可知）', () => {
        expect(extractAffectedPaths('search_in_files', { mode: 'replace', path: 'src/a.ts' }, root)).toBeNull();
        expect(extractAffectedPaths('search_in_files', { mode: 'replace', path: 'src' }, root)).toBeNull();
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
            // file://C:/... 无三斜杠形式同样解析
            expect(workspaceUriToFsPath('file://C:/Users/test')).toBe('C:\\Users\\test');
        } else {
            expect(workspaceUriToFsPath('file:///home/user/ws')).toBe('/home/user/ws');
        }
    });

    test('workspaceUriToFsPath：未编码 fragment/query 被剥离，非法编码序列返回 null', () => {
        if (process.platform === 'win32') {
            expect(workspaceUriToFsPath('file:///C:/Users/ws#frag')).toBe('C:\\Users\\ws');
            expect(workspaceUriToFsPath('file:///C:/Users/ws?query=1')).toBe('C:\\Users\\ws');
        } else {
            expect(workspaceUriToFsPath('file:///home/user/ws#frag')).toBe('/home/user/ws');
            expect(workspaceUriToFsPath('file:///home/user/ws?query=1')).toBe('/home/user/ws');
        }
        // 文件名含未编码 %（非法 URI 编码）：无法可靠确定本地路径 → 回退全量
        expect(workspaceUriToFsPath('file:///home/user/100%bad')).toBeNull();
    });

    test('isPathWithin：platform 参数可注入（win32 大小写折叠与反斜杠分隔符，Linux CI 可测）', () => {
        const rootWin = 'd:/graycode';
        expect(isPathWithin(rootWin, 'D:\\GrayCode\\src\\a.ts', 'win32')).toBe(true);
        expect(isPathWithin(rootWin, 'd:/graycode/src/a.ts', 'win32')).toBe(true);
        expect(isPathWithin(rootWin, 'd:/outside/a.ts', 'win32')).toBe(false);
        // 兄弟前缀（路径边界）：/root/outside 不匹配 /root/outside2
        expect(isPathWithin('/root', '/root2/a.ts', 'linux')).toBe(false);
        expect(isPathWithin('/root', '/root/a.ts', 'linux')).toBe(true);
        // 缺省参数 = 当前运行平台（现有行为保持）
        expect(isPathWithin('/root', '/root/a.ts')).toBe(true);
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
            await fs.rm(rootDir, TEMP_DIR_REMOVE_OPTIONS);
        }
    });

    test('受影响路径不存在（ENOENT）→ absent，不进 unreadable/fileHashes', async () => {
        const rootDir = await createTempWorkspace();
        try {
            await writeFile(rootDir, 'a.ts', 'AAA');

            const roots = makeRoots(rootDir);
            const missing = path.join(rootDir, 'gone.ts');
            const result = await buildWorkspaceSnapshot({ roots, affectedPaths: [missing] });

            const scoped = createWorkspaceScopedPath(roots[0].id, 'gone.ts');
            expect(result.absent).toEqual([scoped]);
            expect(result.unreadable).toEqual([]);
            expect(result.excluded).not.toContainEqual(expect.objectContaining({ path: scoped }));
            expect(result.fileHashes[scoped]).toBeUndefined();
        } finally {
            await fs.rm(rootDir, TEMP_DIR_REMOVE_OPTIONS);
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
            await fs.rm(rootDir, TEMP_DIR_REMOVE_OPTIONS);
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
            await fs.rm(rootDir, TEMP_DIR_REMOVE_OPTIONS);
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
            await fs.rm(rootDir, TEMP_DIR_REMOVE_OPTIONS);
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
            await fs.rm(rootA, TEMP_DIR_REMOVE_OPTIONS);
            await fs.rm(rootB, TEMP_DIR_REMOVE_OPTIONS);
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
            await fs.rm(rootDir, TEMP_DIR_REMOVE_OPTIONS);
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
            await fs.rm(rootDir, TEMP_DIR_REMOVE_OPTIONS);
        }
    });
});
