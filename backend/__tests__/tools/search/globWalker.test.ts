/**
 * globWalker（Node 宿主目录遍历核心）测试
 *
 * 覆盖：
 * - 与重构前实现（逐条目 minimatch、path.relative 相对路径、目录栈 LIFO）逐结果、
 *   逐顺序一致，包括默认排除模式的字面量快速路径、自定义排除回退、包含模式快
 *   路径与回退、大小写不敏感选项；
 * - limit 截断、符号链接与 .git 目录跳过、单文件读取失败与根目录失败；
 * - 快速路径匹配器与 minimatch 的逐名对比（防止手写匹配器与 glob 语义漂移）。
 */
import minimatch from 'minimatch';
import {
    walkGlobTree,
    tryCreateIncludeFastPath,
    tryParseLiteralDirectoryExcludes,
    type GlobWalkerDirent,
    type GlobWalkerMatch
} from '../../../tools/search/globWalker';

interface FakeEntry { name: string; type: 'dir' | 'file' | 'link'; }
type Tree = Record<string, FakeEntry[]>;

const d = (name: string): FakeEntry => ({ name, type: 'dir' });
const f = (name: string): FakeEntry => ({ name, type: 'file' });
const link = (name: string): FakeEntry => ({ name, type: 'link' });

const TREE: Tree = {
    '/root': [d('src'), d('docs'), d('node_modules'), d('Node_Modules'), d('.git'), f('README.md'), f('index.ts'), f('.gitignore'), link('linked')],
    '/root/src': [d('components'), f('helpers.ts'), f('main.ts'), f('main.ts.bak'), f('.hidden.ts')],
    '/root/src/components': [f('button.d.ts'), f('button.tsx')],
    '/root/docs': [f('guide.md'), f('guide.zh.md')],
    '/root/node_modules': [d('dep')],
    '/root/node_modules/dep': [f('dep.ts')],
    '/root/Node_Modules': [f('dep.ts')],
    '/root/.git': [f('config')]
};

function makeReaddir(tree: Tree, failing: Set<string> = new Set()) {
    return async (absolute: string): Promise<GlobWalkerDirent[]> => {
        if (failing.has(absolute) || !tree[absolute]) {
            const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, scandir '${absolute}'`);
            error.code = 'ENOENT';
            throw error;
        }
        return tree[absolute].map(entry => ({
            name: entry.name,
            isDirectory: () => entry.type === 'dir',
            isFile: () => entry.type === 'file',
            isSymbolicLink: () => entry.type === 'link'
        }));
    };
}

interface WalkOptions {
    pattern: string;
    exclude?: string;
    limit?: number;
    caseInsensitive?: boolean;
    readdir?: (absolute: string) => Promise<GlobWalkerDirent[]>;
    throwIfAborted?: () => void;
    onDirectoryError?: (absolute: string, error: unknown) => void;
}

async function collect(options: WalkOptions): Promise<GlobWalkerMatch[]> {
    const out: GlobWalkerMatch[] = [];
    for await (const match of walkGlobTree({
        root: '/root',
        pattern: options.pattern,
        exclude: options.exclude,
        limit: options.limit ?? 1000,
        readdir: options.readdir ?? makeReaddir(TREE),
        joinPath: (directory, name) => `${directory}/${name}`,
        caseInsensitive: options.caseInsensitive ?? false,
        throwIfAborted: options.throwIfAborted,
        onDirectoryError: options.onDirectoryError
    })) {
        out.push(match);
    }
    return out;
}

/** 重构前逐条目 minimatch 的参考实现（仅测试用，逻辑与旧 NodeFileHost.iterateFiles 对齐） */
async function referenceWalk(options: WalkOptions & { root: string; readdir: (absolute: string) => Promise<GlobWalkerDirent[]> }): Promise<string[]> {
    const caseInsensitive = options.caseInsensitive ?? false;
    const limit = options.limit ?? 1000;
    const match = new minimatch.Minimatch(options.pattern, { dot: true, nocase: caseInsensitive });
    const ignored = new minimatch.Minimatch(options.exclude || '__graycode_no_exclusions__', { dot: true, nocase: caseInsensitive });
    const pending = [options.root];
    const out: string[] = [];
    let found = 0;
    while (pending.length && found < limit) {
        const current = pending.pop()!;
        for (const entry of await options.readdir(current)) {
            const absolute = `${current}/${entry.name}`;
            const relative = absolute.slice(options.root.length + 1);
            if (entry.isSymbolicLink()) continue;
            if (ignored.match(relative) || (entry.isDirectory() && ignored.match(`${relative}/`))) continue;
            if (entry.isDirectory()) { if (entry.name !== '.git') pending.push(absolute); }
            else if (entry.isFile() && match.match(relative)) { found++; out.push(relative); }
            if (found >= limit) break;
        }
    }
    return out;
}

async function collectRelatives(options: WalkOptions): Promise<string[]> {
    return (await collect(options)).map(item => item.relative);
}

describe('与重构前实现一致（结果与顺序）', () => {
    const INCLUDE_PATTERNS = ['**/*', '**/*.ts', '*.ts', '**/*.md', '**/*.d.ts', '**/*.{ts,tsx}', 'src/**', '**/*.tsx'];
    const EXCLUDES: Array<string | undefined> = [
        undefined,
        '**/node_modules/**',
        '{**/node_modules/**,**/.git/**}',
        '{**/node_modules/**,**/*.bak}',
        '**/*.bak',
        '{**/Node_Modules/**,**/node_modules/**}',
        '{**/node_modules/**,**/docs/**}'
    ];

    test('包含模式 × 排除模式 × 大小写组合逐结果一致', async () => {
        for (const pattern of INCLUDE_PATTERNS) {
            for (const exclude of EXCLUDES) {
                for (const caseInsensitive of [false, true]) {
                    const actual = await collectRelatives({ pattern, exclude, caseInsensitive });
                    const expected = await referenceWalk({ pattern, exclude, caseInsensitive, root: '/root', readdir: makeReaddir(TREE) });
                    expect(actual).toEqual(expected);
                }
            }
        }
    });

    test('limit 截断与旧实现一致', async () => {
        for (const limit of [1, 2, 3, 7]) {
            const actual = await collectRelatives({ pattern: '**/*.ts', exclude: '{**/node_modules/**,**/.git/**}', limit });
            const expected = await referenceWalk({ pattern: '**/*.ts', exclude: '{**/node_modules/**,**/.git/**}', limit, root: '/root', readdir: makeReaddir(TREE) });
            expect(actual).toEqual(expected);
        }
    });
});

describe('快速路径匹配器与 minimatch 语义一致', () => {
    const NAMES = [
        'a.ts', '.ts', 'a/.ts', 'a.TS', 'ts', 'dir/a.ts', 'a.tsx', 'x.d.ts', 'a.d.ts', 'a.d.ts.bak',
        '.d.ts', 'sub/a.min.js', 'a.min.js', 'a.min.js.map', 'readme.md', '.hidden.ts', 'a b.ts', 'a.ts '
    ];
    const FAST_PATTERNS = ['**/*', '**/*.ts', '*.ts', '**/*.d.ts', '**/*.min.js', '**/*.tsx', '**/*.md', '**/*.tar.gz'];

    test('字面量后缀快速路径逐一对比', () => {
        for (const pattern of FAST_PATTERNS) {
            for (const caseInsensitive of [false, true]) {
                const fast = tryCreateIncludeFastPath(pattern, caseInsensitive);
                expect(fast).not.toBeNull();
                const matcher = new minimatch.Minimatch(pattern, { dot: true, nocase: caseInsensitive });
                for (const name of NAMES) {
                    expect(fast!(name)).toBe(matcher.match(name));
                }
            }
        }
    });

    test('复杂模式回退 minimatch（不误用快速路径）', () => {
        expect(tryCreateIncludeFastPath('**/*.{ts,tsx}', false)).toBeNull();
        expect(tryCreateIncludeFastPath('src/**', false)).toBeNull();
        expect(tryCreateIncludeFastPath('**/[ab].ts', false)).toBeNull();
        expect(tryCreateIncludeFastPath('**/*.d.ts', false)).not.toBeNull();
    });

    test('字面量目录排除解析', () => {
        expect(Array.from(tryParseLiteralDirectoryExcludes('**/node_modules/**', false) ?? []).sort()).toEqual(['node_modules']);
        expect(Array.from(tryParseLiteralDirectoryExcludes('{**/node_modules/**,**/.git/**}', false) ?? []).sort()).toEqual(['.git', 'node_modules']);
        expect(Array.from(tryParseLiteralDirectoryExcludes('{**/Node_Modules/**}', true) ?? [])).toEqual(['node_modules']);
        expect(tryParseLiteralDirectoryExcludes('**/*.bak', false)).toBeNull();
        expect(tryParseLiteralDirectoryExcludes('{**/node_modules/**,**/*.bak}', false)).toBeNull();
        expect(tryParseLiteralDirectoryExcludes('{**/node_modules/**,**/src/**/*.ts}', false)).toBeNull();
        expect(tryParseLiteralDirectoryExcludes('', false)).toBeNull();
        expect(tryParseLiteralDirectoryExcludes(undefined, false)).toBeNull();
    });
});

describe('健壮性与边界', () => {
    test('子目录读取失败时跳过该子树并回调，不影响其他结果', async () => {
        const failing = new Set(['/root/docs']);
        const errors: string[] = [];
        const markdown = await collectRelatives({ pattern: '**/*.md', readdir: makeReaddir(TREE, failing), onDirectoryError: absolute => errors.push(absolute) });
        // docs 子树被跳过；根目录的 README.md 仍会命中
        expect(markdown).toEqual(['README.md']);
        expect(errors).toEqual(['/root/docs']);
        const typescript = await collectRelatives({ pattern: '**/*.ts', readdir: makeReaddir(TREE, failing) });
        expect(typescript).toContain('src/main.ts');
    });

    test('根目录读取失败仍然抛出', async () => {
        await expect(collectRelatives({ pattern: '**/*', readdir: makeReaddir(TREE, new Set(['/root'])) })).rejects.toThrow('ENOENT');
    });

    test('throwIfAborted 抛出后遍历终止', async () => {
        let calls = 0;
        await expect(collectRelatives({
            pattern: '**/*',
            throwIfAborted: () => { if (++calls > 1) throw new Error('aborted'); }
        })).rejects.toThrow('aborted');
    });

    test('.git 目录与符号链接不进入', async () => {
        const results = await collectRelatives({ pattern: '**/*' });
        expect(results).not.toContain('.git/config');
        expect(results).not.toContain('linked');
        expect(results).toContain('README.md');
        expect(results).toContain('src/main.ts');
        expect(results).toContain('.gitignore');
    });

    test('大小写不敏感（nocase）排除语义', async () => {
        const insensitive = await collectRelatives({ pattern: '**/*.ts', exclude: '{**/node_modules/**}', caseInsensitive: true });
        expect(insensitive).not.toContain('node_modules/dep/dep.ts');
        expect(insensitive).not.toContain('Node_Modules/dep.ts');
        const sensitive = await collectRelatives({ pattern: '**/*.ts', exclude: '{**/node_modules/**}', caseInsensitive: false });
        expect(sensitive).not.toContain('node_modules/dep/dep.ts');
        expect(sensitive).toContain('Node_Modules/dep.ts');
    });

    test('limit 为 0 或到达上限后停止', async () => {
        expect(await collect({ pattern: '**/*', limit: 0 })).toEqual([]);
        const one = await collect({ pattern: '**/*', limit: 1 });
        expect(one).toHaveLength(1);
    });
});
