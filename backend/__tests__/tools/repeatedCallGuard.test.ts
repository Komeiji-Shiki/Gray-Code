import {
    RepeatedCallGuard,
    REPEATED_CALL_GUARD_ARG_KEY
} from '../../modules/api/chat/services/repeatedCallGuard';
import type { FunctionCallInfo } from '../../modules/api/chat/utils';

function call(id: string, name: string, args: Record<string, any>): FunctionCallInfo {
    return { id, name, args };
}

function failedResult(name: string, args: Record<string, any>) {
    return { name, args, result: { success: false, error: 'boom' } };
}

function successResult(name: string, args: Record<string, any>) {
    return { name, args, result: { success: true, data: 'ok' } };
}

describe('RepeatedCallGuard', () => {
    it('未达到连续失败阈值时不拦截', () => {
        const guard = new RepeatedCallGuard();
        const args = { paths: ['a.txt'] };

        guard.recordResults([failedResult('read_file', args)]);

        const guarded = guard.guardCall(call('t1', 'read_file', args));
        expect(guarded.args).toBe(args);
    });

    it('连续失败 2 次后第 3 次相同调用被短路', () => {
        const guard = new RepeatedCallGuard();
        const args = { paths: ['a.txt'] };

        guard.recordResults([failedResult('read_file', args)]);
        guard.recordResults([failedResult('read_file', args)]);

        const guarded = guard.guardCall(call('t3', 'read_file', args));

        expect(guarded.args[REPEATED_CALL_GUARD_ARG_KEY]).toContain('read_file');
        expect(guarded.args[REPEATED_CALL_GUARD_ARG_KEY]).toContain('different approach');
        // 原参数已被替换
        expect(guarded.args.paths).toBeUndefined();
    });

    it('成功一次即清零失败计数', () => {
        const guard = new RepeatedCallGuard();
        const args = { paths: ['a.txt'] };

        guard.recordResults([failedResult('read_file', args)]);
        guard.recordResults([failedResult('read_file', args)]);
        guard.recordResults([successResult('read_file', args)]);

        const guarded = guard.guardCall(call('t4', 'read_file', args));
        expect(guarded.args).toBe(args);
    });

    it('重复的成功调用完全不拦截（重跑测试等合法工作流）', () => {
        const guard = new RepeatedCallGuard();
        const args = { command: 'npm test' };

        for (let i = 0; i < 5; i++) {
            guard.recordResults([successResult('execute_command', args)]);
        }

        const guarded = guard.guardCall(call('t9', 'execute_command', args));
        expect(guarded.args).toBe(args);
    });

    it('不同参数的调用互不影响计数', () => {
        const guard = new RepeatedCallGuard();

        guard.recordResults([failedResult('read_file', { paths: ['a.txt'] })]);
        guard.recordResults([failedResult('read_file', { paths: ['a.txt'] })]);

        const guarded = guard.guardCall(call('t5', 'read_file', { paths: ['b.txt'] }));
        expect(guarded.args[REPEATED_CALL_GUARD_ARG_KEY]).toBeUndefined();
    });

    it('被护栏替换的合成调用不参与失败统计', () => {
        const guard = new RepeatedCallGuard();
        const syntheticArgs = { [REPEATED_CALL_GUARD_ARG_KEY]: 'blocked message' };

        // 合成调用的失败结果不应累积任何计数
        guard.recordResults([failedResult('read_file', syntheticArgs)]);
        guard.recordResults([failedResult('read_file', syntheticArgs)]);
        guard.recordResults([failedResult('read_file', syntheticArgs)]);

        const guarded = guard.guardCall(call('t6', 'read_file', syntheticArgs));
        // 已经是合成调用，原样返回
        expect(guarded.args).toBe(syntheticArgs);
    });

    it('guardCalls 批量处理保持顺序', () => {
        const guard = new RepeatedCallGuard();
        const badArgs = { paths: ['bad.txt'] };

        guard.recordResults([failedResult('read_file', badArgs)]);
        guard.recordResults([failedResult('read_file', badArgs)]);

        const calls = [
            call('t7', 'read_file', badArgs),
            call('t8', 'list_files', { paths: ['src'] })
        ];
        const guarded = guard.guardCalls(calls);

        expect(guarded[0].args[REPEATED_CALL_GUARD_ARG_KEY]).toBeDefined();
        expect(guarded[1].args).toBe(calls[1].args);
    });

    it('键顺序不同的语义等价参数命中同一签名', () => {
        const guard = new RepeatedCallGuard();

        guard.recordResults([failedResult('search_in_files', { query: 'foo', path: 'src/' })]);
        guard.recordResults([failedResult('search_in_files', { path: 'src/', query: 'foo' })]);

        const guarded = guard.guardCall(call('t10', 'search_in_files', { query: 'foo', path: 'src/' }));
        expect(guarded.args[REPEATED_CALL_GUARD_ARG_KEY]).toBeDefined();
    });

    it('嵌套对象的键顺序同样不影响签名', () => {
        const guard = new RepeatedCallGuard();

        guard.recordResults([failedResult('apply_diff', { path: 'a.ts', hunks: [{ oldContent: 'x', newContent: 'y' }] })]);
        guard.recordResults([failedResult('apply_diff', { hunks: [{ newContent: 'y', oldContent: 'x' }], path: 'a.ts' })]);

        const guarded = guard.guardCall(call('t11', 'apply_diff', { path: 'a.ts', hunks: [{ oldContent: 'x', newContent: 'y' }] }));
        expect(guarded.args[REPEATED_CALL_GUARD_ARG_KEY]).toBeDefined();
    });

    it('被策略拒绝的调用（rejected:true）不计入失败', () => {
        const guard = new RepeatedCallGuard();
        const args = { task: 'do something' };

        guard.recordResults([{ name: 'subagent', args, result: { success: false, rejected: true, error: 'limit' } }]);
        guard.recordResults([{ name: 'subagent', args, result: { success: false, rejected: true, error: 'limit' } }]);
        guard.recordResults([{ name: 'subagent', args, result: { success: false, rejected: true, error: 'limit' } }]);

        const guarded = guard.guardCall(call('t12', 'subagent', args));
        expect(guarded.args).toBe(args);
    });

    it('rejected 结果不清零已有的连续失败计数', () => {
        const guard = new RepeatedCallGuard();
        const args = { paths: ['a.txt'] };

        guard.recordResults([failedResult('read_file', args)]);
        guard.recordResults([{ name: 'read_file', args, result: { success: false, rejected: true } }]);
        guard.recordResults([failedResult('read_file', args)]);

        const guarded = guard.guardCall(call('t13', 'read_file', args));
        expect(guarded.args[REPEATED_CALL_GUARD_ARG_KEY]).toBeDefined();
    });
});


describe('RepeatedCallGuard - 超长字符串参数签名', () => {
    const bigContentA = 'a'.repeat(70 * 1024);
    const bigContentB = 'a'.repeat(70 * 1024 - 1) + 'b';

    it('相同超长内容命中同一签名并触发护栏', () => {
        const guard = new RepeatedCallGuard();
        const args = { path: 'x.txt', content: bigContentA };

        guard.recordResults([failedResult('write_file', args)]);
        guard.recordResults([failedResult('write_file', args)]);

        const guarded = guard.guardCall(call('t1', 'write_file', args));
        expect(guarded.args[REPEATED_CALL_GUARD_ARG_KEY]).toBeDefined();
    });

    it('不同超长内容不互相误伤', () => {
        const guard = new RepeatedCallGuard();
        const argsA = { path: 'x.txt', content: bigContentA };
        const argsB = { path: 'x.txt', content: bigContentB };

        guard.recordResults([failedResult('write_file', argsA)]);
        guard.recordResults([failedResult('write_file', argsA)]);

        const guarded = guard.guardCall(call('t2', 'write_file', argsB));
        expect(guarded.args[REPEATED_CALL_GUARD_ARG_KEY]).toBeUndefined();
        expect(guarded.args).toBe(argsB);
    });
});
