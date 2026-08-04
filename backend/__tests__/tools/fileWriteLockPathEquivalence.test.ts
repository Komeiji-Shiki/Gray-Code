/**
 * FileWriteLockManager 锁 key 路径等价性测试
 *
 * 覆盖修复：锁 key 从"原始路径 + 简单归一"改为"绝对规范路径 + 归一"——
 * 同一物理文件的不同写法（.. 折叠、./ 前缀、相对/绝对、file:// URI）必须映射到同一 key，
 * 否则可绕过互斥锁导致并行覆盖。
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
    FileWriteLockManager,
    normalizeLockPath,
    resolveLockPath,
    type LockHolder
} from '../../core/fileWriteLockManager';

const holderA: LockHolder = { kind: 'subagent', id: 'run_a', label: 'Agent A' };
const holderB: LockHolder = { kind: 'subagent', id: 'run_b', label: 'Agent B' };

describe('resolveLockPath（锁 key 绝对化）', () => {
    afterEach(() => {
        (vscode.workspace as any).workspaceFolders = [];
    });

    it('空串保持根锁语义', () => {
        expect(resolveLockPath('')).toBe('');
        expect(resolveLockPath('   ')).toBe('');
    });

    it('相对路径解析为绝对路径，.. 段被折叠', () => {
        expect(resolveLockPath('a/../b.ts')).toBe(path.resolve('b.ts'));
        expect(resolveLockPath('./x/y.ts')).toBe(path.resolve('x/y.ts'));
        expect(resolveLockPath('x/y/../z.ts')).toBe(path.resolve('x/z.ts'));
    });

    it('绝对路径保持绝对形式', () => {
        const abs = path.resolve('tmp/abs-test.ts');
        expect(resolveLockPath(abs)).toBe(path.resolve(abs));
    });

    it('file:// URI 解析为本地绝对路径', () => {
        const fsPath = path.resolve('tmp/uri-test.ts');
        const uriStr = 'file://' + fsPath.replace(/\\/g, '/');
        expect(resolveLockPath(uriStr)).toBe(fsPath);
    });
});

describe('resolveLockPath - 单工作区解析', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = path.resolve('/workspace/locktest');
        (vscode.workspace as any).workspaceFolders = [{
            name: 'locktest',
            uri: vscode.Uri.file(workspaceRoot)
        }];
    });

    afterEach(() => {
        (vscode.workspace as any).workspaceFolders = [];
    });

    it('相对路径解析到工作区根下', () => {
        expect(resolveLockPath('src/a.ts')).toBe(path.join(workspaceRoot, 'src/a.ts'));
    });

    it('相对路径经 .. 逃逸工作区后解析为工作区外绝对路径', () => {
        expect(resolveLockPath('../outside.ts')).toBe(path.resolve('/workspace/outside.ts'));
    });

    it('工作区外绝对路径与相对逃逸写法得到同一 key', () => {
        const absOutside = path.resolve('/workspace/outside.ts');
        expect(normalizeLockPath(resolveLockPath(absOutside)))
            .toBe(normalizeLockPath(resolveLockPath('../outside.ts')));
    });
});

describe('锁 key 路径等价（不同写法同一物理文件）', () => {
    let manager: FileWriteLockManager;

    beforeEach(() => {
        manager = new FileWriteLockManager();
        (vscode.workspace as any).workspaceFolders = [];
    });

    afterEach(() => {
        (vscode.workspace as any).workspaceFolders = [];
    });

    it('.. 折叠写法与直接写法互斥', () => {
        expect(manager.tryAcquire(['a/../b.ts'], holderA).acquired).toBe(true);
        expect(manager.tryAcquire(['b.ts'], holderB).acquired).toBe(false);
    });

    it('./ 前缀写法与直接写法互斥', () => {
        expect(manager.tryAcquire(['./src/x.ts'], holderA).acquired).toBe(true);
        expect(manager.tryAcquire(['src/x.ts'], holderB).acquired).toBe(false);
    });

    it('release 使用等价写法也能释放锁', () => {
        manager.tryAcquire(['x/y.ts'], holderA);
        manager.release(['x/../x/y.ts'], holderA);
        expect(manager.tryAcquire(['x/y.ts'], holderB).acquired).toBe(true);
    });

    it('绝对路径与相对路径（同物理文件）互斥', () => {
        const abs = path.resolve('src/shared.ts');
        expect(manager.tryAcquire(['src/shared.ts'], holderA).acquired).toBe(true);
        expect(manager.tryAcquire([abs], holderB).acquired).toBe(false);
    });

    it('file:// URI 与本地绝对路径互斥', () => {
        const fsPath = path.resolve('tmp/uri-lock.ts');
        const uriStr = 'file://' + fsPath.replace(/\\/g, '/');
        expect(manager.tryAcquire([uriStr], holderA).acquired).toBe(true);
        expect(manager.tryAcquire([fsPath], holderB).acquired).toBe(false);
    });

    it('兄弟目录不互相冲突（绝对 key 前缀规则）', () => {
        const dirA = path.resolve('ws/a');
        const dirB = path.resolve('ws/b');
        expect(manager.tryAcquire([dirA], holderA).acquired).toBe(true);
        expect(manager.tryAcquire([dirB], holderB).acquired).toBe(true);
    });
});
