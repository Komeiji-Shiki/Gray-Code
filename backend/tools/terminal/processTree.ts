import { execFile } from 'child_process';
import * as path from 'path';

/**
 * Windows 进程树追踪。
 *
 * taskkill /T 只沿「当前仍存活」的父子关系遍历：启动器（如 gm8emulator.exe）拉起子进程后先退出，
 * 子进程的 ParentProcessId 指向已不存在的进程，从 Shell PID 出发再也找不到它；它继承的标准输出
 * 管道还让前台命令一直等不到 close。这里在命令运行期间按退避间隔采样进程快照，用父 PID 与创建时间
 * 记录真实的后代链（父进程退出后已记录的链仍然有效），中断时把这些后代逐个确认身份后终止。
 *
 * 只终止能证明属于本命令的进程：后代必须由已确认成员创建，且创建时间不早于父进程、不晚于该 PID
 * 被下一个进程复用之前。父进程从未被采样到的孤儿无法证明归属，只报告不终止。
 */
export interface ProcessRecord { pid: number; ppid: number; createdAt: number; name: string; sessionId?: number }
export interface ProcessSnapshot {
    records: ProcessRecord[];
    /** 枚举到 PID 但无权取得创建时间时，不能把它当作已经退出，也不能据此终止。 */
    unresolved: Array<Omit<ProcessRecord, 'createdAt'>>;
}
export interface ProcessTreePort {
    snapshot(relatedPids?: readonly number[]): Promise<ProcessSnapshot>;
    terminate(pids: number[]): Promise<void>;
}
export interface ProcessTreeReport {
    /** 已通过快照核实结果；false 表示快照不可用，只发送了终止信号。 */
    verified: boolean;
    /** 核实后本命令的进程已全部退出。 */
    cleaned: boolean;
    /** 运行期间观察到的本命令进程数（含 Shell）。 */
    observed: number;
    /** 根进程树之外又单独终止的后代（父进程已先退出、taskkill /T 够不到的那些）。 */
    detached: Array<{ pid: number; name: string }>;
    remaining?: Array<{ pid: number; name: string }>;
    /** Shell 已退出但管道仍被占用时，同期创建、父进程已不存在却无法证明归属的进程；只报告，不终止。 */
    unconfirmed?: Array<{ pid: number; name: string }>;
    error?: string;
}

/** 时钟与进程创建时间的比较余量：spawn 前取的时间与系统记录的创建时间可能相差数百毫秒。 */
const SPAWN_SLACK_MS = 2000;
const SAMPLE_DELAYS_MS = [500, 2000, 6000];
const SAMPLE_INTERVAL_MS = 30_000;
const REPORT_LIMIT = 10;

const key = (record: Pick<ProcessRecord, 'pid' | 'createdAt'>) => `${record.pid}:${record.createdAt}`;

/** PowerShell 输出 Unix 毫秒，避免解析 CIM 日期字符串；会话 ID 用于缩小孤儿报告范围。 */
const SNAPSHOT_SCRIPT = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,SessionId | ForEach-Object { $createdAt = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { '?' }; '{0}\t{1}\t{2}\t{3}\t{4}' -f $_.ProcessId, $_.ParentProcessId, $createdAt, $_.SessionId, $_.Name }";

export function parseProcessSnapshot(text: string): ProcessSnapshot {
    const records: ProcessRecord[] = [];
    const unresolved: ProcessSnapshot['unresolved'] = [];
    for (const line of text.split(/\r?\n/)) {
        const [pid, ppid, createdAt, sessionId, ...name] = line.split('\t');
        const identity = { pid: Number(pid), ppid: Number(ppid), ...(sessionId ? { sessionId: Number(sessionId) } : {}), name: name.join('\t').trim() };
        if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !Number.isSafeInteger(identity.ppid)) continue;
        if (createdAt === '?') unresolved.push(identity);
        else if (createdAt && Number.isFinite(Number(createdAt))) records.push({ ...identity, createdAt: Number(createdAt) });
    }
    return { records, unresolved };
}

/** 父 PID 只用于划定需要核对的范围，身份未知的记录永远不进入可终止集合。 */
function unresolvedDescendants(snapshot: ProcessSnapshot, relatedPids: readonly number[]): ProcessSnapshot['unresolved'] {
    const possible = new Set(relatedPids);
    const children = new Map<number, number[]>();
    for (const record of [...snapshot.records, ...snapshot.unresolved])
        (children.get(record.ppid) ?? children.set(record.ppid, []).get(record.ppid)!).push(record.pid);
    const pending = [...possible];
    for (let index = 0; index < pending.length; index++) for (const pid of children.get(pending[index]) ?? []) {
        if (!possible.has(pid)) { possible.add(pid); pending.push(pid); }
    }
    return snapshot.unresolved.filter(record => possible.has(record.pid));
}

export function windowsProcessTreePort(snapshotExecutable?: string): ProcessTreePort {
    const system = process.env.SystemRoot ?? 'C:\\Windows';
    const querySnapshot = (executable?: string) => new Promise<ProcessSnapshot>((resolve, reject) => {
        execFile(executable ?? path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            executable ? ['--process-snapshot'] : ['-NoProfile', '-NonInteractive', '-Command', SNAPSHOT_SCRIPT],
            { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
                if (error) reject(error); else resolve(parseProcessSnapshot(String(stdout)));
            });
    });
    return {
        snapshot: async relatedPids => {
            const snapshot = await querySnapshot(snapshotExecutable);
            // 权限限制只影响本命令的可能成员时，继续使用原 CIM 核对，保留原有停止能力。
            return snapshotExecutable && unresolvedDescendants(snapshot, relatedPids ?? []).length ? querySnapshot() : snapshot;
        },
        // 与受管进程停止相同的 taskkill /T /F；调用方已确认 PID 身份，失败由随后的快照核实。
        terminate: pids => new Promise(resolve => {
            if (!pids.length) { resolve(); return; }
            execFile(path.join(system, 'System32', 'taskkill.exe'), [...pids.flatMap(pid => ['/PID', String(pid)]), '/T', '/F'],
                { windowsHide: true, timeout: 10_000 }, () => resolve());
        }),
    };
}

/** 返回已确认属于根进程的记录；根进程尚未被采样到时用 spawn 时间构造占位记录。 */
export function attributeProcessTree(records: Iterable<ProcessRecord>, rootPid: number, spawnedAt: number, rootExitedAt?: number): ProcessRecord[] {
    const byPid = new Map<number, ProcessRecord[]>();
    const children = new Map<number, ProcessRecord[]>();
    for (const record of records) {
        (byPid.get(record.pid) ?? byPid.set(record.pid, []).get(record.pid)!).push(record);
        (children.get(record.ppid) ?? children.set(record.ppid, []).get(record.ppid)!).push(record);
    }
    for (const list of byPid.values()) list.sort((a, b) => a.createdAt - b.createdAt);
    const root = byPid.get(rootPid)?.find(record => Math.abs(record.createdAt - spawnedAt) <= SPAWN_SLACK_MS
        && (rootExitedAt === undefined || record.createdAt < rootExitedAt))
        ?? { pid: rootPid, ppid: -1, createdAt: spawnedAt - SPAWN_SLACK_MS, name: '' };
    /** 同一 PID 下一个进程出现前，才可能是该成员创建的子进程。 */
    const validUntil = (member: ProcessRecord) => {
        const next = byPid.get(member.pid)?.find(record => record.createdAt > member.createdAt)?.createdAt ?? Infinity;
        // spawn 的比较余量不能延长已知的生存期，否则退出后复用根 PID 的新进程会被误认。
        return member === root && rootExitedAt !== undefined ? Math.min(next, rootExitedAt) : next;
    };
    const members = new Map<string, ProcessRecord>([[key(root), root]]);
    const queue = [root];
    while (queue.length) {
        const member = queue.shift()!;
        const until = validUntil(member);
        for (const child of children.get(member.pid) ?? []) {
            if (child.createdAt < member.createdAt || child.createdAt >= until || members.has(key(child)) || child.pid === member.pid) continue;
            members.set(key(child), child); queue.push(child);
        }
    }
    return [...members.values()];
}

export class ProcessTreeTracker {
    private readonly records = new Map<string, ProcessRecord>();
    private timer?: NodeJS.Timeout;
    private sampling?: Promise<void>;
    private stopped = false;
    private rootExitedAt?: number;
    private lastError?: string;
    constructor(private readonly port: ProcessTreePort, readonly rootPid: number, readonly spawnedAt = Date.now()) {}

    /** 采样只记录 spawn 之后仍可能相关的进程，长时间运行时不会无限积累整机历史。 */
    sample(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        return this.sampling ??= this.snapshotForTree().then(snapshot => { this.remember(snapshot.records); }, error => { this.lastError = String(error); })
            .finally(() => { this.sampling = undefined; });
    }
    private remember(records: ProcessRecord[]) {
        for (const record of records) if (record.createdAt >= this.spawnedAt - SPAWN_SLACK_MS || record.pid === this.rootPid) this.records.set(key(record), record);
    }
    start(): void {
        const schedule = (index: number) => {
            if (this.stopped) return;
            this.timer = setTimeout(() => { void this.sample(); schedule(index + 1); }, SAMPLE_DELAYS_MS[index] ?? SAMPLE_INTERVAL_MS);
            this.timer.unref?.();
        };
        schedule(0);
    }
    /** 退出事件立即确定身份上限；是否补采样由运行器按管道关闭情况决定。 */
    rootExited(): void { this.rootExitedAt ??= Date.now(); }
    stop(): void { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; }
    members(): ProcessRecord[] { return attributeProcessTree(this.records.values(), this.rootPid, this.spawnedAt, this.rootExitedAt); }
    private snapshotForTree(): Promise<ProcessSnapshot> { return this.port.snapshot(this.members().map(record => record.pid)); }

    /**
     * 根进程树已由调用方用 taskkill /T 终止后调用：补终止已确认但脱链的后代，再用快照核实。
     * pipeHeld 在核实后求值：这时输出管道仍未关闭，说明还有进程占用它，额外报告无法证明归属的同期孤儿。
     */
    async cleanup(options: { pipeHeld?: () => boolean } = {}): Promise<ProcessTreeReport> {
        this.stop();
        try {
            // 旧采样保留父子链，当前快照核实存活身份；同时读取，避免停止时串行等待两次 CIM。
            const [, current] = await Promise.all([this.sampling, this.snapshotForTree()]);
            this.remember(current.records);
            const members = this.members();
            const alive = (list: ProcessRecord[]) => members.filter(member => !(member.pid === this.rootPid && this.rootExitedAt !== undefined)
                && list.some(record => record.pid === member.pid && (member.ppid === -1
                ? Math.abs(record.createdAt - this.spawnedAt) <= SPAWN_SLACK_MS : record.createdAt === member.createdAt)));
            const survivors = alive(current.records);
            if (survivors.length) await this.port.terminate(survivors.map(record => record.pid));
            const after = survivors.length ? await this.snapshotForTree() : current;
            const remaining = alive(after.records);
            const unresolved = unresolvedDescendants(after, members.map(record => record.pid));
            const unverifiedPids = new Set(unresolved.map(record => record.pid));
            const report: ProcessTreeReport = { verified: unresolved.length === 0, cleaned: remaining.length === 0 && unresolved.length === 0, observed: members.length,
                detached: survivors.filter(record => record.pid !== this.rootPid && !remaining.includes(record) && !unverifiedPids.has(record.pid))
                    .slice(0, REPORT_LIMIT).map(({ pid, name }) => ({ pid, name })) };
            if (unresolved.length) {
                report.unconfirmed = unresolved.slice(0, REPORT_LIMIT).map(({ pid, name }) => ({ pid, name }));
                report.error = `Process identity could not be queried: ${unresolved.slice(0, REPORT_LIMIT).map(record => record.pid).join(', ')}.`;
            }
            if (remaining.length) report.remaining = remaining.slice(0, REPORT_LIMIT).map(({ pid, name }) => ({ pid, name: name || 'shell' }));
            if (options.pipeHeld?.()) {
                const memberKeys = new Set(members.map(key));
                const live = new Map(after.records.map(record => [record.pid, record]));
                const session = members.find(member => member.ppid !== -1)?.sessionId;
                const end = (this.rootExitedAt ?? Date.now()) + SPAWN_SLACK_MS;
                const orphans = after.records.filter(record => !memberKeys.has(key(record)) && record.createdAt >= this.spawnedAt - SPAWN_SLACK_MS && record.createdAt <= end
                    && (session === undefined || record.sessionId === session) && record.pid !== process.pid
                    && !(live.get(record.ppid) && live.get(record.ppid)!.createdAt <= record.createdAt));
                if (orphans.length) report.unconfirmed = [...(report.unconfirmed ?? []), ...orphans.map(({ pid, name }) => ({ pid, name }))].slice(0, REPORT_LIMIT);
            }
            return report;
        } catch (error) {
            return { verified: false, cleaned: false, observed: 0, detached: [], error: String(error) };
        }
    }
}

/** 给模型的一句话说明：中断原因之外，明确子进程是否已清理。 */
export function describeProcessTree(report: ProcessTreeReport | undefined): string {
    if (!report) return 'Termination signals were sent to the process tree; cleanup could not be verified on this platform.';
    if (!report.verified) return `Termination signals were sent to the process tree, but cleanup could not be verified (${report.error ?? 'process snapshot unavailable'}).`;
    const names = (list: Array<{ pid: number; name: string }>) => list.map(item => `${item.name || 'process'} (PID ${item.pid})`).join(', ');
    const parts = [report.cleaned
        ? `All ${report.observed} process(es) started by this command have exited.`
        : `Some processes started by this command are still running: ${names(report.remaining ?? [])}.`];
    if (report.detached.length) parts.push(`Also terminated descendants whose parent had already exited: ${names(report.detached)}.`);
    if (report.unconfirmed?.length) parts.push(`Not terminated because they could not be confirmed as this command's processes: ${names(report.unconfirmed)}.`);
    return parts.join(' ');
}
