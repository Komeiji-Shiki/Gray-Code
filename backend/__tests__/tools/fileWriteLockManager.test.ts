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

describe('normalizeLockPath', () => {
    it('统一反斜杠并小写化', () => {
        expect(normalizeLockPath('Src\\Foo\\Bar.TS')).toBe('src/foo/bar.ts');
    });

    it('去除 ./ 前缀与尾部斜杠', () => {
        expect(normalizeLockPath('./src/a.ts')).toBe('src/a.ts');
        expect(normalizeLockPath('src/dir/')).toBe('src/dir');
    });

    it('workspace 根归一为空串', () => {
        expect(normalizeLockPath('.')).toBe('');
        expect(normalizeLockPath('')).toBe('');
        expect(normalizeLockPath('./')).toBe('');
    });

    it('折叠重复分隔符', () => {
        expect(normalizeLockPath('src//a.ts')).toBe('src/a.ts');
    });
});

describe('getWritePathsForCall', () => {
    it('提取单路径写工具', () => {
        expect(getWritePathsForCall('write_file', { path: 'a.ts', content: 'x' })).toEqual(['a.ts']);
        expect(getWritePathsForCall('apply_diff', { path: 'b.ts' })).toEqual(['b.ts']);
    });

    it('提取 files 数组路径', () => {
        expect(getWritePathsForCall('insert_code', { files: [{ path: 'a.ts', line: 1, content: '' }, { path: 'b.ts', line: 2, content: '' }] }))
            .toEqual(['a.ts', 'b.ts']);
        expect(getWritePathsForCall('delete_code', { files: [{ path: 'c.ts', start_line: 1, end_line: 2 }] }))
            .toEqual(['c.ts']);
    });

    it('提取 paths 数组', () => {
        expect(getWritePathsForCall('delete_file', { paths: ['a.ts', 'b.ts'] })).toEqual(['a.ts', 'b.ts']);
        expect(getWritePathsForCall('create_directory', { paths: ['dir1'] })).toEqual(['dir1']);
    });

    it('search_in_files 仅 replace 模式参与锁', () => {
        expect(getWritePathsForCall('search_in_files', { query: 'x', mode: 'replace', path: 'src/' })).toEqual(['src/']);
        expect(getWritePathsForCall('search_in_files', { query: 'x', mode: 'replace' })).toEqual(['.']);
        expect(getWritePathsForCall('search_in_files', { query: 'x', mode: 'search' })).toEqual([]);
        expect(getWritePathsForCall('search_in_files', { query: 'x' })).toEqual([]);
    });

    it('非写工具返回 null', () => {
        expect(getWritePathsForCall('read_file', { path: 'a.ts' })).toBeNull();
        expect(getWritePathsForCall('list_files', { paths: ['.'] })).toBeNull();
    });
});

describe('FileWriteLockManager', () => {
    let manager: FileWriteLockManager;

    beforeEach(() => {
        manager = new FileWriteLockManager();
    });

    it('基本加锁与释放', () => {
        expect(manager.tryAcquire(['a.ts'], holderA).acquired).toBe(true);
        expect(manager.getLockCount()).toBe(1);
        manager.release(['a.ts'], holderA);
        expect(manager.getLockCount()).toBe(0);
    });

    it('不同持有者对同一文件互斥，并返回占用者信息', () => {
        manager.tryAcquire(['a.ts'], holderA);
        const result = manager.tryAcquire(['a.ts'], holderB);
        expect(result.acquired).toBe(false);
        if (!result.acquired) {
            expect(result.conflicts).toHaveLength(1);
            expect(result.conflicts[0].holder.label).toBe('Agent A');
        }
    });

    it('路径大小写与分隔符差异仍视为同一文件', () => {
        manager.tryAcquire(['src/A.ts'], holderA);
        expect(manager.tryAcquire(['SRC\\a.TS'], holderB).acquired).toBe(false);
    });

    it('同 holder 重入允许且按计数释放', () => {
        expect(manager.tryAcquire(['a.ts'], holderA).acquired).toBe(true);
        expect(manager.tryAcquire(['a.ts'], holderA).acquired).toBe(true);
        manager.release(['a.ts'], holderA);
        // 仍持有（计数为 1），其他人不能获取
        expect(manager.tryAcquire(['a.ts'], holderB).acquired).toBe(false);
        manager.release(['a.ts'], holderA);
        expect(manager.tryAcquire(['a.ts'], holderB).acquired).toBe(true);
    });

    it('全有或全无：任一路径冲突则整体失败且不留部分锁', () => {
        manager.tryAcquire(['b.ts'], holderB);
        const result = manager.tryAcquire(['a.ts', 'b.ts'], holderA);
        expect(result.acquired).toBe(false);
        // a.ts 不应被部分锁定
        expect(manager.tryAcquire(['a.ts'], holderMain).acquired).toBe(true);
    });

    it('目录锁与内部文件互斥（前缀规则）', () => {
        manager.tryAcquire(['src/'], holderA);
        expect(manager.tryAcquire(['src/deep/file.ts'], holderB).acquired).toBe(false);
        expect(manager.tryAcquire(['other/file.ts'], holderB).acquired).toBe(true);
    });

    it('文件锁反向阻止祖先目录锁', () => {
        manager.tryAcquire(['src/deep/file.ts'], holderA);
        expect(manager.tryAcquire(['src/'], holderB).acquired).toBe(false);
    });

    it('workspace 根锁与所有路径互斥', () => {
        manager.tryAcquire(['.'], holderA);
        expect(manager.tryAcquire(['any/file.ts'], holderB).acquired).toBe(false);
    });

    it('release 非持有者是安全空操作', () => {
        manager.tryAcquire(['a.ts'], holderA);
        manager.release(['a.ts'], holderB);
        expect(manager.tryAcquire(['a.ts'], holderB).acquired).toBe(false);
    });

    it('releaseAllByHolder 兜底清理全部锁', () => {
        manager.tryAcquire(['a.ts', 'b.ts'], holderA);
        manager.tryAcquire(['c.ts'], holderB);
        manager.releaseAllByHolder('run_a');
        expect(manager.tryAcquire(['a.ts'], holderMain).acquired).toBe(true);
        expect(manager.tryAcquire(['b.ts'], holderMain).acquired).toBe(true);
        expect(manager.tryAcquire(['c.ts'], holderMain).acquired).toBe(false);
    });
});


describe('getWritePathsForCall - 文档类工具', () => {
    it('update_plan 提取 path', () => {
        expect(getWritePathsForCall('update_plan', { path: '.graycode/plans/x.md' }))
            .toEqual(['.graycode/plans/x.md']);
    });

    it('progress 工具缺省 path 时锁默认 progress 文档', () => {
        expect(getWritePathsForCall('update_progress', {})).toEqual(['.graycode/progress.md']);
        expect(getWritePathsForCall('record_progress_milestone', {})).toEqual(['.graycode/progress.md']);
        expect(getWritePathsForCall('create_progress', { path: 'ws/.graycode/progress.md' }))
            .toEqual(['ws/.graycode/progress.md']);
    });

    it('create_plan 无 path 时不加锁（生成路径不可预知）', () => {
        expect(getWritePathsForCall('create_plan', {})).toEqual([]);
    });

    it('write_file 空白 path 不再锁整个工作区', () => {
        expect(getWritePathsForCall('write_file', { path: '   ' })).toEqual([]);
    });

    it('只读工具仍不参与写锁', () => {
        expect(getWritePathsForCall('read_file', { paths: ['a.txt'] })).toBeNull();
    });
});
