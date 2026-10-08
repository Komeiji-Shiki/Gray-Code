import { attributeProcessTree, describeProcessTree, parseProcessSnapshot, ProcessTreeTracker, type ProcessRecord, type ProcessTreePort } from '../../tools/terminal/processTree';

const at = 1_000_000;
const record = (pid: number, ppid: number, createdAt: number, name = `p${pid}.exe`): ProcessRecord => ({ pid, ppid, createdAt, name, sessionId: 1 });

describe('进程树归属', () => {
    test('解析快照：跳过空行与不完整记录，名称保留空格', () => {
        expect(parseProcessSnapshot('10\t4\t1000\t1\tmy app.exe\r\n\r\nbad line\n0\t0\t0\t0\tIdle\n')).toEqual([
            { pid: 10, ppid: 4, createdAt: 1000, sessionId: 1, name: 'my app.exe' },
        ]);
    });

    test('父进程先退出：已采样到的链仍把孙进程归属到 Shell', () => {
        const history = [record(100, 1, at), record(200, 100, at + 50, 'launcher.exe'), record(300, 200, at + 80, 'game-wow64.exe')];
        // 后续快照里 launcher 已不存在，孙进程的父 PID 指向已退出进程
        const pids = attributeProcessTree(history, 100, at).map(item => item.pid).sort();
        expect(pids).toEqual([100, 200, 300]);
    });

    test('PID 被复用后的同号进程及其子进程不算本命令的后代', () => {
        const history = [record(100, 1, at), record(200, 100, at + 50), record(200, 999, at + 10_000), record(400, 200, at + 10_100)];
        const pids = attributeProcessTree(history, 100, at).map(item => `${item.pid}@${item.createdAt - at}`).sort();
        expect(pids).toEqual(['100@0', '200@50']);
    });

    test('早于父进程创建的同 PPID 进程不被归属；根进程未采样到时按 spawn 时间占位', () => {
        const history = [record(500, 100, at - 60_000), record(600, 100, at + 300)];
        const pids = attributeProcessTree(history, 100, at).map(item => item.pid).sort();
        expect(pids).toEqual([100, 600]);
    });
});

describe('中断清理', () => {
    function port(snapshots: ProcessRecord[][]): ProcessTreePort & { terminated: number[][] } {
        const terminated: number[][] = [];
        return { terminated, snapshot: jest.fn(async () => snapshots.shift() ?? []), terminate: jest.fn(async pids => { terminated.push(pids); }) };
    }

    test.each([false, true])('根进程退出后很快复用 PID 时不终止新进程，原后代仍可清理（已采样根=%s）', async sampledRoot => {
        const child = record(200, 100, at + 50), grandchild = record(300, 200, at + 200);
        const unrelated = [record(100, 999, at + 150), record(400, 100, at + 180)];
        const fake = port([...(sampledRoot ? [[record(100, 1, at), child]] : []), [child, grandchild, ...unrelated], unrelated]);
        const tracker = new ProcessTreeTracker(fake, 100, at);
        if (sampledRoot) await tracker.sample();
        const now = jest.spyOn(Date, 'now').mockReturnValue(at + 100);
        try {
            tracker.rootExited();
            expect(await tracker.cleanup()).toMatchObject({ verified: true, cleaned: true, observed: 3 });
            expect(fake.terminated).toEqual([[200, 300]]);
        } finally { now.mockRestore(); }
    });

    test('补终止脱链后代并用快照核实，报告清理完成', async () => {
        const fake = port([
            [record(100, 1, at), record(200, 100, at + 50, 'launcher.exe'), record(300, 200, at + 80, 'game-wow64.exe')],
            [record(300, 200, at + 80, 'game-wow64.exe')],
            [],
        ]);
        const tracker = new ProcessTreeTracker(fake, 100, at);
        await tracker.sample();
        const report = await tracker.cleanup();
        expect(fake.terminated).toEqual([[300]]);
        expect(report).toMatchObject({ verified: true, cleaned: true, observed: 3, detached: [{ pid: 300, name: 'game-wow64.exe' }] });
        expect(describeProcessTree(report)).toContain('game-wow64.exe (PID 300)');
    });

    test('清理期间并行取得当前快照，仍等待旧采样补齐脱链后代的归属', async () => {
        let sampled!: (records: ProcessRecord[]) => void;
        const first = new Promise<ProcessRecord[]>(resolve => { sampled = resolve; });
        const child = record(300, 200, at + 80, 'child.exe');
        const fake: ProcessTreePort = {
            snapshot: jest.fn().mockReturnValueOnce(first).mockResolvedValueOnce([child]).mockResolvedValueOnce([]),
            terminate: jest.fn(async () => {}),
        };
        const tracker = new ProcessTreeTracker(fake, 100, at);
        void tracker.sample();
        const cleanup = tracker.cleanup();
        expect(fake.snapshot).toHaveBeenCalledTimes(2);
        sampled([record(100, 1, at), record(200, 100, at + 50), child]);
        expect(await cleanup).toMatchObject({ verified: true, cleaned: true, observed: 3,
            detached: [{ pid: 300, name: 'child.exe' }] });
        expect(fake.terminate).toHaveBeenCalledWith([300]);
    });

    test('终止后仍存活的进程如实报告；管道仍被占用时列出无法证明归属的同期孤儿但不终止', async () => {
        const stray = record(700, 650, at + 40, 'stray.exe');
        const fake = port([
            [record(100, 1, at), record(200, 100, at + 50)],
            [record(200, 100, at + 50), stray],
            [record(200, 100, at + 50), stray],
        ]);
        const tracker = new ProcessTreeTracker(fake, 100, at);
        await tracker.sample();
        const report = await tracker.cleanup({ pipeHeld: () => true });
        expect(fake.terminated).toEqual([[200]]);
        expect(report).toMatchObject({ cleaned: false, remaining: [{ pid: 200 }], unconfirmed: [{ pid: 700, name: 'stray.exe' }] });
        expect(describeProcessTree(report)).toMatch(/still running.*Not terminated because they could not be confirmed/);
    });

    test('快照不可用时不终止任何进程，报告未核实', async () => {
        const fake: ProcessTreePort = { snapshot: jest.fn(async () => { throw new Error('powershell missing'); }), terminate: jest.fn() };
        const report = await new ProcessTreeTracker(fake, 100, at).cleanup();
        expect(fake.terminate).not.toHaveBeenCalled();
        expect(report).toMatchObject({ verified: false, cleaned: false });
        expect(describeProcessTree(report)).toContain('could not be verified');
    });
});
