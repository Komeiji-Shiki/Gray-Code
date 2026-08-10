import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CheckpointIgnoreResolver, normalizeCheckpointPath } from '../../modules/checkpoint/CheckpointIgnoreResolver';

// M-6: 用哨兵目录名 `blocked` 模拟不可读目录（readdir 失败），其余路径走真实实现
jest.mock('fs/promises', () => {
    const actual = jest.requireActual('fs/promises') as typeof import('fs/promises');
    return {
        ...actual,
        readdir: jest.fn((dirPath: unknown, ...args: unknown[]) => {
            const isBlocked = String(dirPath).split(/[\\/]/).filter(Boolean).pop() === 'blocked';
            if (isBlocked) {
                const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
                error.code = 'EACCES';
                return Promise.reject(error);
            }
            return (actual.readdir as unknown as (...a: unknown[]) => Promise<unknown>)(dirPath, ...args);
        })
    };
});

import { createTempWorkspace } from '../__fixtures__/checkpointFixtures';

/**
 * CheckpointIgnoreResolver 测试
 *
 * 这些用例覆盖一些忽略语义：
 * - 根目录与嵌套目录的 `.gitignore` 作用域
 * - anchored / negation 规则
 * - Windows 风格自定义忽略模式
 * - `.gitignore` 不可用时的收敛行为
 */

/**
 * 在临时工作区中创建文件，自动补齐父目录。
 */
async function writeFile(rootDir: string, relativePath: string, content: string = ''): Promise<void> {
    const fullPath = path.join(rootDir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
}

/**
 * 返回 resolver 最终会纳入检查点的相对路径列表。
 *
 * 这里统一经过 `normalizeCheckpointPath`，确保断言不受平台路径分隔符影响。
 */
async function listTrackedPaths(rootDir: string, extraPatterns: string[] = []): Promise<string[]> {
    const resolver = new CheckpointIgnoreResolver(rootDir, extraPatterns);
    const { files } = await resolver.collectEntries();
    return files
        .map(filePath => normalizeCheckpointPath(path.relative(rootDir, filePath)))
        .sort();
}

describe('CheckpointIgnoreResolver', () => {
    test('ignores root and nested target directories while preserving tracked files', async () => {
        const rootDir = await createTempWorkspace();

        try {
            // 根目录规则 `target/` 应该匹配任意层级的同名目录。
            await writeFile(rootDir, '.gitignore', 'target/\n');
            await writeFile(rootDir, 'src/main.rs', 'fn main() {}\n');
            await writeFile(rootDir, 'target/debug/app.exe', 'binary');
            await writeFile(rootDir, 'nested/target/cache.txt', 'ignored');
            await writeFile(rootDir, 'nested/src/lib.rs', 'pub fn lib() {}\n');
            await writeFile(rootDir, '.git/HEAD', 'ref: refs/heads/main\n');
            await writeFile(rootDir, 'node_modules/pkg/index.js', 'module.exports = {}\n');

            await expect(listTrackedPaths(rootDir)).resolves.toEqual([
                '.gitignore',
                'nested/src/lib.rs',
                'src/main.rs'
            ]);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('respects anchored root-only directory rules', async () => {
        const rootDir = await createTempWorkspace();

        try {
            // `/target/` 只忽略根目录下的 target，不影响嵌套目录。
            await writeFile(rootDir, '.gitignore', '/target/\n');
            await writeFile(rootDir, 'target/root.txt', 'ignored');
            await writeFile(rootDir, 'nested/target/nested.txt', 'tracked');

            await expect(listTrackedPaths(rootDir)).resolves.toEqual([
                '.gitignore',
                'nested/target/nested.txt'
            ]);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('keeps nested gitignore scope local and supports negation within that scope', async () => {
        const rootDir = await createTempWorkspace();

        try {
            // packages/a 下的规则只能影响 a 子树，且 `!dist/keep.txt` 需要正确反选。
            await writeFile(rootDir, 'packages/a/.gitignore', 'dist/*\n!dist/keep.txt\nfoo.txt\n');
            await writeFile(rootDir, 'packages/a/dist/keep.txt', 'tracked');
            await writeFile(rootDir, 'packages/a/dist/drop.txt', 'ignored');
            await writeFile(rootDir, 'packages/a/foo.txt', 'ignored');
            await writeFile(rootDir, 'packages/b/dist/keep.txt', 'tracked');
            await writeFile(rootDir, 'packages/b/foo.txt', 'tracked');

            await expect(listTrackedPaths(rootDir)).resolves.toEqual([
                'packages/a/.gitignore',
                'packages/a/dist/keep.txt',
                'packages/b/dist/keep.txt',
                'packages/b/foo.txt'
            ]);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('applies custom ignore patterns at the checkpoint root scope', async () => {
        const rootDir = await createTempWorkspace();

        try {
            // 自定义规则与根目录 `.gitignore` 处于同一逻辑作用域。
            await writeFile(rootDir, 'generated/code.ts', 'ignored');
            await writeFile(rootDir, 'src/app.ts', 'tracked');

            await expect(listTrackedPaths(rootDir, ['generated/'])).resolves.toEqual([
                'src/app.ts'
            ]);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('normalizes Windows-style custom ignore patterns before matching', async () => {
        const rootDir = await createTempWorkspace();

        try {
            // 用户可能从 Windows 视角输入反斜杠路径，resolver 需要先规范化再匹配。
            await writeFile(rootDir, 'generated/code.ts', 'ignored');
            await writeFile(rootDir, 'src/app.ts', 'tracked');

            await expect(listTrackedPaths(rootDir, ['generated\\'])).resolves.toEqual([
                'src/app.ts'
            ]);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('treats unreadable gitignore files as having no local rules', async () => {
        const rootDir = await createTempWorkspace();

        try {
            // 把 `.gitignore` 做成目录来模拟“该路径不可作为规则文件读取”的场景。
            await fs.mkdir(path.join(rootDir, '.gitignore'));
            await writeFile(rootDir, 'target/debug/app.exe', 'binary');

            await expect(listTrackedPaths(rootDir)).resolves.toEqual([
                'target/debug/app.exe'
            ]);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });
});

/**
 * 四层排除模型（EX-01/EX-02）专项测试：
 * - 默认排除类别（可关闭、可被自定义 ! 重新纳入）
 * - 强制排除不可被 ! 否定
 * - 扩展存储绝对路径强制排除（子树剪枝 + excluded 记录）
 * - collectEntries 的 excluded 清单（原因/规则/来源）
 * - checkIgnore 返回完整结果
 */

describe('CheckpointIgnoreResolver - exclusion layers (EX-01/EX-02)', () => {
    test('applies default profiles when enabledProfiles is provided', async () => {
        const rootDir = await createTempWorkspace();

        try {
            await writeFile(rootDir, 'debug.log', 'log');
            await writeFile(rootDir, 'src/app.pyc', 'bytecode');
            await writeFile(rootDir, 'dist/bundle.js', 'bundle');
            await writeFile(rootDir, 'src/main.ts', 'code');

            const resolver = new CheckpointIgnoreResolver(rootDir, [], {
                enabledProfiles: { logs: true, caches: true, buildArtifacts: true }
            });
            const { files, excluded } = await resolver.collectEntries();

            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();
            expect(tracked).toEqual(['src/main.ts']);

            const byPath = Object.fromEntries(excluded.map(e => [e.path, e]));
            expect(byPath['debug.log']).toMatchObject({ reason: 'default', source: 'logs' });
            expect(byPath['debug.log'].rule).toBe('*.log');
            expect(byPath['src/app.pyc']).toMatchObject({ reason: 'default', source: 'caches' });
            expect(byPath['dist']).toMatchObject({ reason: 'default', source: 'buildArtifacts', isDirectory: true });
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('disabling all profiles keeps profile-matching files tracked', async () => {
        const rootDir = await createTempWorkspace();

        try {
            await writeFile(rootDir, 'debug.log', 'log');
            await writeFile(rootDir, 'src/main.ts', 'code');

            const allOff: Record<string, boolean> = {};
            for (const id of ['logs', 'aiModels', 'datasets', 'caches', 'pythonVenvs', 'buildArtifacts', 'largeMedia', 'archives']) {
                allOff[id] = false;
            }
            const resolver = new CheckpointIgnoreResolver(rootDir, [], { enabledProfiles: allOff });
            const { files, excluded } = await resolver.collectEntries();

            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();
            expect(tracked).toEqual(['debug.log', 'src/main.ts']);
            expect(excluded).toHaveLength(0);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('custom negation re-includes default profile files', async () => {
        const rootDir = await createTempWorkspace();

        try {
            await writeFile(rootDir, 'debug.log', 'ignored');
            await writeFile(rootDir, 'keep.log', 'kept');
            await writeFile(rootDir, 'src/main.ts', 'code');

            const resolver = new CheckpointIgnoreResolver(rootDir, ['!keep.log'], {
                enabledProfiles: { logs: true }
            });
            const { files, excluded } = await resolver.collectEntries();

            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();
            expect(tracked).toEqual(['keep.log', 'src/main.ts']);
            const excludedPaths = excluded.map(e => e.path);
            expect(excludedPaths).toEqual(['debug.log']);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('custom negation cannot override forced exclusions', async () => {
        const rootDir = await createTempWorkspace();

        try {
            await writeFile(rootDir, '.git/HEAD', 'ref');
            await writeFile(rootDir, 'node_modules/pkg/index.js', 'module');
            await writeFile(rootDir, 'src/main.ts', 'code');

            const resolver = new CheckpointIgnoreResolver(rootDir, ['!.git/', '!node_modules/', '!.git/HEAD'], {
                enabledProfiles: {}
            });
            const { files, excluded } = await resolver.collectEntries();

            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();
            expect(tracked).toEqual(['src/main.ts']);

            const byPath = Object.fromEntries(excluded.map(e => [e.path, e]));
            expect(byPath['.git']).toMatchObject({ reason: 'forced', source: 'forced' });
            expect(byPath['node_modules']).toMatchObject({ reason: 'forced', source: 'forced' });
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('excludes extension storage absolute path and prunes the subtree (EX-02)', async () => {
        const rootDir = await createTempWorkspace();

        try {
            const storageRoot = path.join(rootDir, '.limcode');
            await writeFile(storageRoot, 'checkpoints/cp_x/src/app.ts', 'backup copy');
            await writeFile(storageRoot, 'conversations/conv.json', 'meta');
            await writeFile(rootDir, 'src/app.ts', 'real code');

            const resolver = new CheckpointIgnoreResolver(rootDir, [], {
                excludeAbsolutePaths: [storageRoot]
            });
            const { files, excluded } = await resolver.collectEntries();

            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();
            expect(tracked).toEqual(['src/app.ts']);

            // 整棵存储子树只记录目录本身一次，不展开内部文件
            const storageEntries = excluded.filter(e => e.path.startsWith('.limcode'));
            expect(storageEntries).toHaveLength(1);
            expect(storageEntries[0]).toMatchObject({
                path: '.limcode',
                reason: 'forced',
                source: 'storage',
                isDirectory: true
            });
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('collectEntries records gitignore and custom reasons with rules', async () => {
        const rootDir = await createTempWorkspace();

        try {
            await writeFile(rootDir, '.gitignore', '*.tmp\ngenerated/\n');
            await writeFile(rootDir, 'a.tmp', 'ignored by gitignore');
            await writeFile(rootDir, 'generated/out.js', 'ignored dir');
            await writeFile(rootDir, 'secret.tmp', 'ignored by custom');
            await writeFile(rootDir, 'src/main.ts', 'code');

            // 自定义模式与 gitignore 不同：secret.tmp 仅由自定义命中
            const resolver = new CheckpointIgnoreResolver(rootDir, ['secret.tmp']);
            const { files, excluded } = await resolver.collectEntries();

            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();
            expect(tracked).toEqual(['.gitignore', 'src/main.ts']);

            const byPath = Object.fromEntries(excluded.map(e => [e.path, e]));
            expect(byPath['a.tmp']).toMatchObject({ reason: 'gitignore', source: '.gitignore', rule: '*.tmp' });
            expect(byPath['generated']).toMatchObject({ reason: 'gitignore', source: '.gitignore', rule: 'generated/' });
            expect(byPath['secret.tmp']).toMatchObject({ reason: 'custom', source: 'custom', rule: 'secret.tmp' });
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('nested gitignore negation can re-include a profile-ignored file', async () => {
        const rootDir = await createTempWorkspace();

        try {
            await writeFile(rootDir, 'packages/a/.gitignore', '!keep.log\n');
            await writeFile(rootDir, 'packages/a/keep.log', 're-included');
            await writeFile(rootDir, 'packages/a/drop.log', 'ignored');
            await writeFile(rootDir, 'other.log', 'ignored');

            const resolver = new CheckpointIgnoreResolver(rootDir, [], {
                enabledProfiles: { logs: true }
            });
            const { files, excluded } = await resolver.collectEntries();

            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();
            expect(tracked).toEqual(['packages/a/.gitignore', 'packages/a/keep.log']);
            const excludedPaths = excluded.map(e => e.path);
            expect(excludedPaths).toContain('other.log');
            expect(excludedPaths).toContain('packages/a/drop.log');
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('checkIgnore returns the full ignore result with reason', async () => {
        const rootDir = await createTempWorkspace();

        try {
            await writeFile(rootDir, 'debug.log', 'log');
            await writeFile(rootDir, 'node_modules/pkg/index.js', 'module');

            const resolver = new CheckpointIgnoreResolver(rootDir, [], {
                enabledProfiles: { logs: true }
            });

            const logResult = await resolver.checkIgnore('debug.log');
            expect(logResult).toMatchObject({ ignored: true, reason: 'default', source: 'logs' });
            expect(logResult.rule).toBe('*.log');

            const forcedResult = await resolver.checkIgnore('node_modules/pkg/index.js');
            expect(forcedResult).toMatchObject({ ignored: true, reason: 'forced', source: 'forced' });

            const trackedResult = await resolver.checkIgnore('src/main.ts');
            expect(trackedResult.ignored).toBe(false);

            // isIgnored 保持布尔兼容
            await expect(resolver.isIgnored('debug.log')).resolves.toBe(true);
            await expect(resolver.isIgnored('src/main.ts')).resolves.toBe(false);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('M-1: custom patterns are evaluated after all scopes - custom ignore beats nested gitignore negation', async () => {
        const rootDir = await createTempWorkspace();

        try {
            // 自定义 `*.tmp` + 嵌套 .gitignore 的 `!keep.tmp`：设置页规则最后生效 → keep.tmp 仍被忽略
            await writeFile(rootDir, 'nested/.gitignore', '!keep.tmp\n');
            await writeFile(rootDir, 'nested/keep.tmp', 'kept by nested negation');
            await writeFile(rootDir, 'nested/drop.tmp', 'ignored');
            await writeFile(rootDir, 'src/main.ts', 'code');

            const tracked = await listTrackedPaths(rootDir, ['*.tmp']);
            expect(tracked).toEqual(['nested/.gitignore', 'src/main.ts']);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('M-1: custom patterns are evaluated after all scopes - custom negation beats nested gitignore ignore', async () => {
        const rootDir = await createTempWorkspace();

        try {
            // 自定义 `!keep.tmp` + 嵌套 .gitignore 的 `*.tmp`：设置页规则最后生效 → keep.tmp 重新纳入
            await writeFile(rootDir, 'nested/.gitignore', '*.tmp\n');
            await writeFile(rootDir, 'nested/keep.tmp', 're-included by custom');
            await writeFile(rootDir, 'nested/drop.tmp', 'ignored');
            await writeFile(rootDir, 'src/main.ts', 'code');

            const tracked = await listTrackedPaths(rootDir, ['!keep.tmp']);
            expect(tracked).toEqual(['nested/.gitignore', 'nested/keep.tmp', 'src/main.ts']);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('M-5: directory-type default category cannot be re-included by file-level negation alone', async () => {
        const rootDir = await createTempWorkspace();

        try {
            await writeFile(rootDir, 'data/keep.txt', 'keep');
            await writeFile(rootDir, 'data/drop.txt', 'drop');

            // 仅 !data/keep.txt：data/ 目录仍命中 datasets 类别被整树剪枝
            const resolver = new CheckpointIgnoreResolver(rootDir, ['!data/keep.txt'], {
                enabledProfiles: { datasets: true }
            });
            const { files, excluded } = await resolver.collectEntries();

            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();
            expect(tracked).toEqual([]);
            expect(excluded.some(e => e.path === 'data')).toBe(true);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('M-5: negating the directory itself plus file-level negation re-includes files under it', async () => {
        const rootDir = await createTempWorkspace();

        try {
            await writeFile(rootDir, 'data/keep.txt', 'keep');
            await writeFile(rootDir, 'data/drop.txt', 'drop');

            // !data/ 重新纳入目录本身（子树可遍历）；文件仍需各自否定（!data/keep.txt）才能重新纳入
            const resolver = new CheckpointIgnoreResolver(rootDir, ['!data/', '!data/keep.txt'], {
                enabledProfiles: { datasets: true }
            });
            const { files, excluded } = await resolver.collectEntries();

            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();
            expect(tracked).toContain('data/keep.txt');
            // drop.txt 没有对应否定规则 → 仍被 data/ 排除（但目录本身不再被剪枝）
            expect(tracked).not.toContain('data/drop.txt');
            expect(excluded.some(e => e.path === 'data/drop.txt')).toBe(true);
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('M-6: collectEntries records unreadable directories as unreadable excluded entries', async () => {
        const rootDir = await createTempWorkspace();

        try {
            await writeFile(rootDir, 'src/main.ts', 'code');
            await fs.mkdir(path.join(rootDir, 'blocked'), { recursive: true });
            await writeFile(path.join(rootDir, 'blocked', 'secret.txt'), 'hidden');

            const resolver = new CheckpointIgnoreResolver(rootDir);
            const { files, excluded } = await resolver.collectEntries();

            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();
            expect(tracked).toEqual(['src/main.ts']);
            const blockedEntry = excluded.find(e => e.path === 'blocked');
            expect(blockedEntry).toMatchObject({ reason: 'unreadable', isDirectory: true });
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('L-3/EX-CASE-2: forced absolute path exclusion is case-insensitive on win32/darwin', async () => {
        const rootDir = await createTempWorkspace();

        try {
            // 磁盘上是 .Limcode，排除配置写 .limcode
            const storageRoot = path.join(rootDir, '.Limcode');
            await writeFile(storageRoot, 'checkpoints/cp_x/a.txt', 'x');

            const resolver = new CheckpointIgnoreResolver(rootDir, [], {
                excludeAbsolutePaths: [path.join(rootDir, '.limcode')]
            });
            const { files, excluded } = await resolver.collectEntries();
            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();

            if (process.platform === 'win32' || process.platform === 'darwin') {
                // win32 / darwin（大小写不敏感卷）：大小写差异仍强制排除（整树剪枝）
                expect(tracked).toEqual([]);
                expect(excluded.some(e => e.path === '.Limcode')).toBe(true);
            } else {
                // Linux 等 POSIX：大小写敏感，.Limcode 与 .limcode 是不同目录
                expect(tracked).toEqual(['.Limcode/checkpoints/cp_x/a.txt']);
            }
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('EX-CASE-1: forced .git / node_modules segments match case-insensitively on win32/darwin', async () => {
        const rootDir = await createTempWorkspace();

        try {
            await writeFile(rootDir, '.GIT/HEAD', 'ref');
            await writeFile(rootDir, 'NODE_MODULES/pkg/index.js', 'module');
            await writeFile(rootDir, 'src/main.ts', 'code');

            // ! 否定规则试图重新纳入，强制排除不可被覆盖
            const resolver = new CheckpointIgnoreResolver(rootDir, ['!.GIT/', '!NODE_MODULES/'], {
                enabledProfiles: {}
            });
            const { files, excluded } = await resolver.collectEntries();
            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();

            if (process.platform === 'win32' || process.platform === 'darwin') {
                // 大小写不敏感文件系统：.GIT / NODE_MODULES 命中强制排除，! 否定无效
                expect(tracked).toEqual(['src/main.ts']);
                const byPath = Object.fromEntries(excluded.map(e => [e.path, e]));
                expect(byPath['.GIT']).toMatchObject({ reason: 'forced', source: 'forced' });
                expect(byPath['NODE_MODULES']).toMatchObject({ reason: 'forced', source: 'forced' });
            } else {
                // POSIX：大小写敏感，.GIT / NODE_MODULES 是普通目录，不会被强制排除
                expect(tracked).toEqual(['.GIT/HEAD', 'NODE_MODULES/pkg/index.js', 'src/main.ts']);
            }
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });

    test('CP-SYMLINK-1: records symlinks in excluded as unsupported_file_type', async () => {
        const rootDir = await createTempWorkspace();

        try {
            await writeFile(rootDir, 'real/file.txt', 'data');
            await writeFile(rootDir, 'src/main.ts', 'code');
            try {
                await fs.symlink(path.join(rootDir, 'real'), path.join(rootDir, 'alias'), 'dir');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') {
                    // Windows 上创建符号链接可能需要权限，跳过该用例。
                    return;
                }
                throw error;
            }

            const resolver = new CheckpointIgnoreResolver(rootDir);
            const { files, excluded } = await resolver.collectEntries();
            const tracked = files.map(f => normalizeCheckpointPath(path.relative(rootDir, f))).sort();
            expect(tracked).toEqual(['real/file.txt', 'src/main.ts']);

            // 符号链接不再静默丢弃：记录到 excluded 清单并给出原因
            const symlinkEntry = excluded.find(e => e.path === 'alias');
            expect(symlinkEntry).toMatchObject({ reason: 'unsupported_file_type', source: 'filesystem' });
        } finally {
            await fs.rm(rootDir, { recursive: true, force: true });
        }
    });
});
