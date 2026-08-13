/**
 * FileWriteLockManager 单元测试
 *
 * 覆盖：路径归一化、写路径提取注册表、加锁/冲突/重入/全有或全无、
 * 目录前缀互斥、release 与 releaseAllByHolder 兜底清理。
 */

import {
    FileWriteLockManager,
    normalizeLockPath,
    getWritePathsForCall,
    type LockHolder
} from '../../core/fileWriteLockManager';

const holderA: LockHolder = { kind: 'subagent', id: 'run_a', label: 'Agent A' };
const holderB: LockHolder = { kind: 'subagent', id: 'run_b', label: 'Agent B' };
const holderMain: LockHolder = { kind: 'main', id: 'conversation_1', label: 'main session' };

// 大小写归一行为随文件系统区分大小写能力变化（win32/darwin 不区分，其余平台区分）：
// 平台专属断言必须用 skip 门控，避免在另一平台误跑失败
const isCaseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';
const isWin32 = process.platform === 'win32';
const itOnWin32 = isWin32 ? it : it.skip;
const itOnNonWin32 = isWin32 ? it.skip : it;
// 大小写不敏感文件系统（win32/darwin）与大小写敏感文件系统（linux 等）专属用例门控
const itOnCaseInsensitiveFs = isCaseInsensitiveFs ? it : it.skip;
const itOnCaseSensitiveFs = isCaseInsensitiveFs ? it.skip : it;

describe('normalizeLockPath', () => {
    test('统一反斜杠（win32/darwin 小写化，其他平台保留大小写）', () => {
        const normalized = normalizeLockPath('Src\\Foo\\Bar.TS');
        if (process.platform === 'win32' || process.platform === 'darwin') {
            // Windows/macOS 文件系统不区分大小写：锁 key 小写归一
            expect(normalized).toBe('src/foo/bar.ts');
        } else {
            // 大小写敏感文件系统：只归一化分隔符，不改变大小写
            expect(normalized).toBe('Src/Foo/Bar.TS');
        }
    });

    test('去除 ./ 前缀与尾部斜杠', () => {
        expect(normalizeLockPath('./src/a.ts')).toBe('src/a.ts');
        expect(normalizeLockPath('src/dir/')).toBe('src/dir');
    });

    test('workspace 根归一为空串', () => {
        expect(normalizeLockPath('.')).toBe('');
        expect(normalizeLockPath('')).toBe('');
        expect(normalizeLockPath('./')).toBe('');
    });

    test('折叠重复分隔符', () => {
        expect(normalizeLockPath('src//a.ts')).toBe('src/a.ts');
    });
});

describe('getWritePathsForCall', () => {
    test('提取单路径写工具', () => {
        expect(getWritePathsForCall('write_file', { path: 'a.ts', content: 'x' })).toEqual(['a.ts']);
        expect(getWritePathsForCall('apply_diff', { path: 'b.ts' })).toEqual(['b.ts']);
    });

    test('提取 files 数组路径', () => {
        expect(getWritePathsForCall('insert_code', { files: [{ path: 'a.ts', line: 1, content: '' }, { path: 'b.ts', line: 2, content: '' }] }))
            .toEqual(['a.ts', 'b.ts']);
        expect(getWritePathsForCall('delete_code', { files: [{ path: 'c.ts', start_line: 1, end_line: 2 }] }))
            .toEqual(['c.ts']);
    });

    test('提取 paths 数组', () => {
        expect(getWritePathsForCall('delete_file', { paths: ['a.ts', 'b.ts'] })).toEqual(['a.ts', 'b.ts']);
        expect(getWritePathsForCall('create_directory', { paths: ['dir1'] })).toEqual(['dir1']);
    });

    test('search_in_files 仅 replace 模式参与锁', () => {
        expect(getWritePathsForCall('search_in_files', { query: 'x', mode: 'replace', path: 'src/' })).toEqual(['src/']);
        expect(getWritePathsForCall('search_in_files', { query: 'x', mode: 'replace' })).toEqual(['.']);
        expect(getWritePathsForCall('search_in_files', { query: 'x', mode: 'search' })).toEqual([]);
        expect(getWritePathsForCall('search_in_files', { query: 'x' })).toEqual([]);
    });

    test('非写工具返回 null', () => {
        expect(getWritePathsForCall('read_file', { path: 'a.ts' })).toBeNull();
        expect(getWritePathsForCall('list_files', { paths: ['.'] })).toBeNull();
    });
});

describe('FileWriteLockManager', () => {
    let manager: FileWriteLockManager;

    beforeEach(() => {
        manager = new FileWriteLockManager();
    });

    test('基本加锁与释放', () => {
        expect(manager.tryAcquire(['a.ts'], holderA).acquired).toBe(true);
        expect(manager.getLockCount()).toBe(1);
        manager.release(['a.ts'], holderA);
        expect(manager.getLockCount()).toBe(0);
    });

    test('不同持有者对同一文件互斥，并返回占用者信息', () => {
        manager.tryAcquire(['a.ts'], holderA);
        const result = manager.tryAcquire(['a.ts'], holderB);
        expect(result.acquired).toBe(false);
        if (!result.acquired) {
            expect(result.conflicts).toHaveLength(1);
            expect(result.conflicts[0].holder.label).toBe('Agent A');
        }
    });

    itOnWin32('win32：路径大小写与分隔符差异均视为同一文件', () => {
        manager.tryAcquire(['src/A.ts'], holderA);
        expect(manager.tryAcquire(['SRC\\a.TS'], holderB).acquired).toBe(false);
    });

    itOnCaseInsensitiveFs('大小写不敏感平台（win32/darwin）：仅大小写不同的路径视为同一文件，互斥', () => {
        manager.tryAcquire(['src/A.ts'], holderA);
        expect(manager.tryAcquire(['SRC/a.TS'], holderB).acquired).toBe(false);
    });

    itOnNonWin32('非 win32：分隔符差异视为同一文件', () => {
        // 反斜杠与斜杠写法归一为同一 key，互斥
        manager.tryAcquire(['src/A.ts'], holderA);
        expect(manager.tryAcquire(['src\\A.ts'], holderB).acquired).toBe(false);
        manager.release(['src\\A.ts'], holderA);
    });

    itOnCaseSensitiveFs('大小写敏感平台（linux）：仅大小写不同的路径是不同文件，不互斥', () => {
        manager.tryAcquire(['src/A.ts'], holderA);
        expect(manager.tryAcquire(['SRC/a.TS'], holderB).acquired).toBe(true);
    });

    test('同 holder 重入允许且按计数释放', () => {
        expect(manager.tryAcquire(['a.ts'], holderA).acquired).toBe(true);
        expect(manager.tryAcquire(['a.ts'], holderA).acquired).toBe(true);
        manager.release(['a.ts'], holderA);
        // 仍持有（计数为 1），其他人不能获取
        expect(manager.tryAcquire(['a.ts'], holderB).acquired).toBe(false);
        manager.release(['a.ts'], holderA);
        expect(manager.tryAcquire(['a.ts'], holderB).acquired).toBe(true);
    });

    test('全有或全无：任一路径冲突则整体失败且不留部分锁', () => {
        manager.tryAcquire(['b.ts'], holderB);
        const result = manager.tryAcquire(['a.ts', 'b.ts'], holderA);
        expect(result.acquired).toBe(false);
        // a.ts 不应被部分锁定
        expect(manager.tryAcquire(['a.ts'], holderMain).acquired).toBe(true);
    });

    test('目录锁与内部文件互斥（前缀规则）', () => {
        manager.tryAcquire(['src/'], holderA);
        expect(manager.tryAcquire(['src/deep/file.ts'], holderB).acquired).toBe(false);
        expect(manager.tryAcquire(['other/file.ts'], holderB).acquired).toBe(true);
    });

    test('文件锁反向阻止祖先目录锁', () => {
        manager.tryAcquire(['src/deep/file.ts'], holderA);
        expect(manager.tryAcquire(['src/'], holderB).acquired).toBe(false);
    });

    test('workspace 根锁与所有路径互斥', () => {
        manager.tryAcquire(['.'], holderA);
        expect(manager.tryAcquire(['any/file.ts'], holderB).acquired).toBe(false);
    });

    test('release 非持有者是安全空操作', () => {
        manager.tryAcquire(['a.ts'], holderA);
        manager.release(['a.ts'], holderB);
        expect(manager.tryAcquire(['a.ts'], holderB).acquired).toBe(false);
    });

    test('releaseAllByHolder 兜底清理全部锁', () => {
        manager.tryAcquire(['a.ts', 'b.ts'], holderA);
        manager.tryAcquire(['c.ts'], holderB);
        manager.releaseAllByHolder(holderA);
        expect(manager.tryAcquire(['a.ts'], holderMain).acquired).toBe(true);
        expect(manager.tryAcquire(['b.ts'], holderMain).acquired).toBe(true);
        expect(manager.tryAcquire(['c.ts'], holderMain).acquired).toBe(false);
    });
});


describe('getWritePathsForCall - 文档类工具', () => {
    test('update_plan 提取 path', () => {
        expect(getWritePathsForCall('update_plan', { path: '.graycode/plans/x.md' }))
            .toEqual(['.graycode/plans/x.md']);
    });

    test('progress 工具缺省 path 时锁默认 progress 文档', () => {
        expect(getWritePathsForCall('update_progress', {})).toEqual(['.graycode/progress.md']);
        expect(getWritePathsForCall('record_progress_milestone', {})).toEqual(['.graycode/progress.md']);
        expect(getWritePathsForCall('create_progress', { path: 'ws/.graycode/progress.md' }))
            .toEqual(['ws/.graycode/progress.md']);
    });

    test('create_plan 无 path 时不加锁（生成路径不可预知）', () => {
        expect(getWritePathsForCall('create_plan', {})).toEqual([]);
    });

    test('write_file 空白 path 不再锁整个工作区', () => {
        expect(getWritePathsForCall('write_file', { path: '   ' })).toEqual([]);
    });

    test('只读工具仍不参与写锁', () => {
        expect(getWritePathsForCall('read_file', { paths: ['a.txt'] })).toBeNull();
    });
});


// ============ R2 M5 补测：复合身份键 / acquire 超时与取消 ============
describe('FileWriteLockManager - 复合身份键（R2 M5）', () => {
    let manager: FileWriteLockManager;

    beforeEach(() => {
        manager = new FileWriteLockManager();
    });

    test('同 id 不同 kind：是不同持有者 → 同一文件互斥，冲突信息准确', () => {
        const main = { kind: 'main' as const, id: 'x', label: 'main' };
        const sub = { kind: 'subagent' as const, id: 'x', label: 'sub' };
        expect(manager.tryAcquire(['f.ts'], main).acquired).toBe(true);
        const r = manager.tryAcquire(['f.ts'], sub);
        expect(r.acquired).toBe(false);
        if (!r.acquired) {
            expect(r.conflicts[0].holder.label).toBe('main');
        }
    });

    test('releaseAllByHolder 只释放本 kind（同 id 他 kind 锁保留，R2 M1）', () => {
        const main = { kind: 'main' as const, id: 'x', label: 'main' };
        const sub = { kind: 'subagent' as const, id: 'x', label: 'sub' };
        manager.tryAcquire(['a.ts'], main);
        manager.tryAcquire(['b.ts'], sub);

        // 只按 id 匹配的旧实现会把 main 的 a.ts 也误释放
        manager.releaseAllByHolder(sub);
        expect(manager.getLockCount()).toBe(1);
        // main 的 a.ts 保留：他人（kind=checkpoint）不可获取
        const other = { kind: 'checkpoint' as const, id: 'y', label: 'ckpt' };
        expect(manager.tryAcquire(['a.ts'], other).acquired).toBe(false);
        // sub 的 b.ts 已释放：sub 可重新获取
        expect(manager.tryAcquire(['b.ts'], sub).acquired).toBe(true);
    });

    test('label 不同但 kind+id 相同视为同一持有者（身份仅由 kind:id 决定）', () => {
        const h1 = { kind: 'subagent' as const, id: 'r1', label: 'A' };
        const h2 = { kind: 'subagent' as const, id: 'r1', label: 'B' };
        expect(manager.tryAcquire(['f.ts'], h1).acquired).toBe(true);
        // 同一身份重入（不是冲突）
        expect(manager.tryAcquire(['f.ts'], h2).acquired).toBe(true);
        manager.release(['f.ts'], h2);
        expect(manager.tryAcquire(['f.ts'], h1).acquired).toBe(true);
    });
});

describe('FileWriteLockManager - acquire 等待语义（R2 M5）', () => {
    let manager: FileWriteLockManager;

    beforeEach(() => {
        manager = new FileWriteLockManager();
    });

    test('锁被他人占用时 acquire 等待到释放后成功', async () => {
        manager.tryAcquire(['a.ts'], holderA);
        const acquired = manager.acquire(['a.ts'], holderB, undefined, 2000);
        // 释放后等待者应被唤醒并拿到锁
        setTimeout(() => manager.release(['a.ts'], holderA), 30);
        await expect(acquired).resolves.toBeUndefined();
        expect(manager.tryAcquire(['a.ts'], holderMain).acquired).toBe(false);
        expect(manager.getLockCount()).toBe(1);
    });

    test('acquire 超时（maxWaitMs 小值）抛可辨识错误且无锁残留', async () => {
        manager.tryAcquire(['a.ts'], holderA);
        await expect(manager.acquire(['a.ts'], holderB, undefined, 50)).rejects.toThrow(/timed out/);
        // 超时后无部分锁、无残留 waiter（代际等待列表空）
        expect(manager.getLockCount()).toBe(1);
        expect((manager as any).generationWaiters).toHaveLength(0);
    });

    test('abortSignal 取消等待：抛 cancelled 且无锁残留', async () => {
        manager.tryAcquire(['a.ts'], holderA);
        const controller = new AbortController();
        const p = manager.acquire(['a.ts'], holderB, controller.signal);
        setTimeout(() => controller.abort(), 20);
        await expect(p).rejects.toThrow(/cancelled/);
        expect(manager.getLockCount()).toBe(1);
        expect((manager as any).generationWaiters).toHaveLength(0);
    });

    test('等待期间 abort 与 release 竞态：settle 后不再重复回调', async () => {
        manager.tryAcquire(['a.ts'], holderA);
        const controller = new AbortController();
        const p = manager.acquire(['a.ts'], holderB, controller.signal, 5000);
        // release 唤醒与 abort 同时发生：只 settle 一次（不抛 unhandled / 不双 resolve）。
        // 同一 tick 内 abort 先执行 → 以 cancelled 收场；waiter 列表不得残留。
        setTimeout(() => {
            controller.abort();
            manager.release(['a.ts'], holderA);
        }, 10);
        await expect(p).rejects.toThrow(/cancelled/);
        expect((manager as any).generationWaiters).toHaveLength(0);
    });
});