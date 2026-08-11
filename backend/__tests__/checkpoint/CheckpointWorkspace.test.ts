import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
    CheckpointPathError,
    createRuntimeWorkspaceRoots,
    createWorkspaceRootId,
    createWorkspaceScopedPath,
    createWorkspaceSnapshot,
    normalizeSafeCheckpointPath,
    parseWorkspaceScopedPath,
    resolvePathInsideRoot,
    resolveSafePathInsideRoot,
    validateWorkspaceSnapshot
} from '../../modules/checkpoint';

/**
 * CheckpointWorkspace 测试
 *
 * 覆盖：
 * - 工作区根身份生成（稳定、大小写归一、去重）
 * - 工作区指纹快照
 * - 存档记录与当前工作区集合的匹配校验
 * - 存档相对路径安全校验（空路径、绝对路径、`..` 越界）
 * - 工作区作用域路径的编码与解析
 * - 真实文件系统上的路径边界（`..`、符号链接）
 */

const sampleInputs = [
    { name: 'alpha', uri: 'file:///a/workspace', fsPath: '/a/workspace' },
    { name: 'beta', uri: 'file:///b/workspace', fsPath: '/b/workspace' }
];

describe('createWorkspaceRootId', () => {
    test('is stable for the same uri', () => {
        expect(createWorkspaceRootId('file:///a/workspace')).toBe(createWorkspaceRootId('file:///a/workspace'));
    });

    test('normalizes trailing slashes and backslashes', () => {
        expect(createWorkspaceRootId('file:///a/workspace/')).toBe(createWorkspaceRootId('file:///a/workspace'));
        expect(createWorkspaceRootId('file:///a/workspace/')).toBe(createWorkspaceRootId('file:///a/workspace'));
    });

    test('produces the expected ws_ prefixed shape', () => {
        const id = createWorkspaceRootId('file:///a/workspace');
        expect(id).toMatch(/^ws_[a-f0-9]{16}$/);
    });

    test('case-folds uri case on case-insensitive filesystems (win32/darwin)', () => {
        const upper = createWorkspaceRootId('file:///A/Workspace');
        const lower = createWorkspaceRootId('file:///a/workspace');
        if (process.platform === 'win32' || process.platform === 'darwin') {
            // Windows / macOS 默认大小写不敏感：同一目录不同大小写的 URI 必须同 rootId
            expect(upper).toBe(lower);
        } else {
            // POSIX：大小写敏感，不同大小写视为不同目录
            expect(upper).not.toBe(lower);
        }
    });
});

describe('createRuntimeWorkspaceRoots', () => {
    test('assigns stable ids and normalizes uris', () => {
        const roots = createRuntimeWorkspaceRoots(sampleInputs);
        expect(roots).toHaveLength(2);
        expect(roots.every(root => /^ws_[a-f0-9]{16}$/.test(root.id))).toBe(true);
        expect(roots.map(root => root.uri)).not.toContain('file:///a/workspace/');
    });

    test('throws on duplicate root identities', () => {
        const inputs = [
            { name: 'one', uri: 'file:///same/root', fsPath: '/x/root' },
            { name: 'two', uri: 'file:///same/root/', fsPath: '/y/root' }
        ];
        expect(() => createRuntimeWorkspaceRoots(inputs)).toThrow(/Duplicate workspace root identity/);
    });

    test('resolves fsPath to an absolute path', () => {
        const roots = createRuntimeWorkspaceRoots([{ name: 'a', uri: 'file:///a', fsPath: 'relative/dir' }]);
        expect(path.isAbsolute(roots[0].fsPath)).toBe(true);
    });
});

describe('createWorkspaceSnapshot / validateWorkspaceSnapshot', () => {
    test('fingerprint is stable across calls for the same roots', () => {
        const roots = createRuntimeWorkspaceRoots(sampleInputs);
        const first = createWorkspaceSnapshot(roots);
        const second = createWorkspaceSnapshot(roots);
        expect(first.workspaceFingerprint).toBe(second.workspaceFingerprint);
        expect(first.workspaceRoots).toHaveLength(2);
    });

    test('accepts a checkpoint that matches the current workspace', () => {
        const current = createRuntimeWorkspaceRoots(sampleInputs);
        const snapshot = createWorkspaceSnapshot(current);
        const result = validateWorkspaceSnapshot(snapshot.workspaceRoots, snapshot.workspaceFingerprint, current);
        expect(result).toMatchObject({ valid: true });
    });

    test('rejects checkpoints without workspace identity', () => {
        const current = createRuntimeWorkspaceRoots(sampleInputs);
        const result = validateWorkspaceSnapshot(undefined, undefined, current);
        expect(result).toMatchObject({ valid: false, code: 'WORKSPACE_IDENTITY_MISSING' });
    });

    test('rejects when a recorded root is missing from the current workspace', () => {
        const current = createRuntimeWorkspaceRoots(sampleInputs);
        const snapshot = createWorkspaceSnapshot(current);
        const reduced = createRuntimeWorkspaceRoots([sampleInputs[0]]);
        const result = validateWorkspaceSnapshot(snapshot.workspaceRoots, snapshot.workspaceFingerprint, reduced);
        expect(result).toMatchObject({ valid: false, code: 'WORKSPACE_MISMATCH' });
        if (!result.valid) {
            const betaId = current.find(root => root.name === 'beta')!.id;
            expect(result.missingRootIds).toEqual([betaId]);
        }
    });

    test('rejects when the current workspace has extra roots', () => {
        const current = createRuntimeWorkspaceRoots(sampleInputs);
        const snapshot = createWorkspaceSnapshot(current);
        const extended = createRuntimeWorkspaceRoots([...sampleInputs, { name: 'c', uri: 'file:///c/workspace', fsPath: '/c/workspace' }]);
        const result = validateWorkspaceSnapshot(snapshot.workspaceRoots, snapshot.workspaceFingerprint, extended);
        expect(result).toMatchObject({ valid: false, code: 'WORKSPACE_MISMATCH' });
        if (!result.valid) {
            expect(result.unexpectedRootIds).toHaveLength(1);
        }
    });

    test('rejects when the same root id maps to a different uri', () => {
        const current = createRuntimeWorkspaceRoots(sampleInputs);
        const snapshot = createWorkspaceSnapshot(current);
        const moved = createRuntimeWorkspaceRoots([
            { name: 'alpha', uri: 'file:///moved/workspace', fsPath: '/moved/workspace' },
            sampleInputs[1]
        ]);
        const result = validateWorkspaceSnapshot(snapshot.workspaceRoots, snapshot.workspaceFingerprint, moved);
        expect(result).toMatchObject({ valid: false, code: 'WORKSPACE_MISMATCH' });
    });

    test('rejects when the recorded fingerprint is corrupted', () => {
        const current = createRuntimeWorkspaceRoots(sampleInputs);
        const snapshot = createWorkspaceSnapshot(current);
        const result = validateWorkspaceSnapshot(snapshot.workspaceRoots, 'deadbeef', current);
        expect(result).toMatchObject({ valid: false, code: 'WORKSPACE_MISMATCH' });
    });
});

describe('normalizeSafeCheckpointPath', () => {
    test('rejects empty and null-byte paths', () => {
        expect(() => normalizeSafeCheckpointPath('')).toThrow(CheckpointPathError);
        expect(() => normalizeSafeCheckpointPath('a\0b')).toThrow(CheckpointPathError);
    });

    test('allows whitespace-only paths as legal relative names', () => {
        // 全空格在文件系统中是合法文件名（Linux 允许），且不会造成路径越界。
        expect(normalizeSafeCheckpointPath('   ')).toBe('   ');
    });

    test('rejects absolute paths', () => {
        expect(() => normalizeSafeCheckpointPath('/etc/passwd')).toThrow(CheckpointPathError);
        expect(() => normalizeSafeCheckpointPath('C:\\windows\\system32')).toThrow(CheckpointPathError);
    });

    test('rejects parent traversal', () => {
        expect(() => normalizeSafeCheckpointPath('../outside')).toThrow(CheckpointPathError);
        expect(() => normalizeSafeCheckpointPath('a/../../outside')).toThrow(CheckpointPathError);
    });

    test('normalizes backslashes and collapses dots and slashes', () => {
        expect(normalizeSafeCheckpointPath('src\\main.ts')).toBe('src/main.ts');
        expect(normalizeSafeCheckpointPath('./src//main.ts')).toBe('src/main.ts');
    });
});

describe('createWorkspaceScopedPath / parseWorkspaceScopedPath', () => {
    test('round-trips a relative path through a scoped path', () => {
        const roots = createRuntimeWorkspaceRoots(sampleInputs);
        const scoped = createWorkspaceScopedPath(roots[0].id, 'src/main.ts');
        const parsed = parseWorkspaceScopedPath(scoped, roots);
        expect(parsed.root.id).toBe(roots[0].id);
        expect(parsed.relativePath).toBe('src/main.ts');
    });

    test('rejects an unknown root id when parsing', () => {
        const roots = createRuntimeWorkspaceRoots([sampleInputs[0]]);
        expect(() => parseWorkspaceScopedPath('ws_ffffffffffffffff/x.ts', roots))
            .toThrow(CheckpointPathError);
    });

    test('rejects malformed root ids when creating', () => {
        expect(() => createWorkspaceScopedPath('../evil', 'x.ts')).toThrow(CheckpointPathError);
        expect(() => createWorkspaceScopedPath('ws_short', 'x.ts')).toThrow(CheckpointPathError);
    });
});

describe('resolvePathInsideRoot', () => {
    test('resolves a normal relative path inside the root', () => {
        const target = resolvePathInsideRoot('/root/dir', 'src/main.ts');
        expect(target).toBe(path.resolve('/root/dir/src/main.ts'));
    });

    test('rejects paths that escape the root', () => {
        expect(() => resolvePathInsideRoot('/root/dir', '../../etc/passwd')).toThrow(CheckpointPathError);
    });
});

describe('resolveSafePathInsideRoot (real filesystem)', () => {
    let rootDir: string;

    beforeEach(async () => {
        rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-cp-workspace-'));
    });

    afterEach(async () => {
        await fs.rm(rootDir, { recursive: true, force: true });
    });

    async function writeFile(relativePath: string, content: string = ''): Promise<void> {
        const fullPath = path.join(rootDir, relativePath);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, content, 'utf-8');
    }

    test('returns the resolved path for an existing file', async () => {
        await writeFile('src/main.ts', 'export {}');
        const target = await resolveSafePathInsideRoot(rootDir, 'src/main.ts');
        expect(target).toBe(path.join(rootDir, 'src', 'main.ts'));
    });

    test('returns the resolved path when the file does not exist yet', async () => {
        const target = await resolveSafePathInsideRoot(rootDir, 'new/dir/file.ts');
        expect(target).toBe(path.join(rootDir, 'new', 'dir', 'file.ts'));
    });

    test('rejects traversal through an existing symlink', async () => {
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-cp-outside-'));
        try {
            const linkPath = path.join(rootDir, 'link');
            try {
                await fs.symlink(outsideDir, linkPath, 'dir');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') {
                    // Windows 上创建符号链接可能需要权限，跳过该用例。
                    return;
                }
                throw error;
            }

            await expect(resolveSafePathInsideRoot(rootDir, 'link/secret.txt'))
                .rejects
                .toMatchObject({ code: 'CHECKPOINT_PATH_SYMLINK' });
        } finally {
            await fs.rm(outsideDir, { recursive: true, force: true });
        }
    });

    test('rejects traversal through a symlink that points back into the root', async () => {
        await writeFile('real/file.txt', 'data');
        const linkPath = path.join(rootDir, 'alias');
        try {
            await fs.symlink(path.join(rootDir, 'real'), linkPath, 'dir');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') {
                return;
            }
            throw error;
        }

        await expect(resolveSafePathInsideRoot(rootDir, 'alias/file.txt'))
            .rejects
            .toMatchObject({ code: 'CHECKPOINT_PATH_SYMLINK' });
    });
});
