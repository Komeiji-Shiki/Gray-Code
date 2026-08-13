/**
 * 文件系统存储适配器（拆分自 storage.ts，使用 VS Code workspace.fs API）。
 *
 * 文件结构:
 * - {baseDir}/conversations/{conversationId}.json        # 旧版对话历史(Gemini 格式，向后兼容)
 * - {baseDir}/conversations/{conversationId}.meta.json   # 对话元数据
 * - {baseDir}/conversations/{conversationId}.usage.json  # 用量索引（统计加速，见 UsageIndexStore.ts）
 * - {baseDir}/conversations/{conversationId}/history.index.json
 * - {baseDir}/conversations/{conversationId}/history/*.ndjson
 * - {baseDir}/snapshots/{snapshotId}.json                # 快照
 *
 * 纯计算辅助（错误识别 / 分页区间 / 索引校验 / 并发限流）已抽到 segmentedHistoryUtils.ts，
 * 本类只保留依赖 vscode / baseDir / segmentCache 的有状态读写编排。storage.ts 通过
 * `export { FileSystemStorageAdapter } from './fileSystemStorageAdapter'` 再导出。
 */

import { HistorySegmentCache } from './history/HistorySegmentCache';
import { Logger } from '../../core/logger';
import type { Content, ConversationHistory, ConversationMetadata, HistorySnapshot } from './types';
import type {
    ConversationStorageIntegrity,
    ConversationStorageLocation,
    HistoryIndexInfo,
    IStorageAdapter,
    StorageHistoryPage,
    StorageReadResult,
    SubAgentTranscriptData,
} from './storageTypes';
import { runSegmentedHistoryWriteSerialized, withMetadataWriteSerialized } from './storageWriteQueues';
import { assertSafeStorageId } from './storageIds';
import {
    FS_ENTRY_TYPE_DIRECTORY,
    FS_ENTRY_TYPE_FILE,
    asHistoryReadResult,
    buildPageRange,
    buildSegmentCacheRevision,
    isNotFoundError,
    runBounded,
    sameIndexVersion,
    validateIndexConsistency,
    type FileHistoryIndex,
    type FileHistorySegmentIndexEntry,
} from './segmentedHistoryUtils';

const log = Logger.get('storage');

export class FileSystemStorageAdapter implements IStorageAdapter {
    private static readonly HISTORY_SEGMENT_SIZE = 200;

    /** 段读取并发上限（HIS-05）：受限于文件句柄与内存，取适中值 */
    private static readonly SEGMENT_READ_CONCURRENCY = 4;

    /** 读侧重试退避：写提交窗口内可能短暂读到 not_found/io_error/segment_missing，最多重试 2 次（共 3 次尝试） */
    private static readonly READ_RETRY_DELAYS_MS = [50, 120];

    /** 段级 LRU 缓存（HIS-06）：命中跳过读盘；写提交后按会话整体失效 */
    private readonly segmentCache = new HistorySegmentCache();

    constructor(
        private vscode: any, // VS Code API
        private baseDir: string // 存储目录的 URI
    ) {}

    /** 供测试/诊断读取当前缓存段数 */
    getHistorySegmentCacheSize(): number {
        return this.segmentCache.size;
    }

    private getLegacyHistoryPath(conversationId: string): any {
        assertSafeStorageId(conversationId, 'conversation id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            `${conversationId}.json`
        );
    }

    private getConversationDir(conversationId: string): any {
        assertSafeStorageId(conversationId, 'conversation id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            conversationId
        );
    }

    private getHistoryDir(conversationId: string): any {
        return this.vscode.Uri.joinPath(this.getConversationDir(conversationId), 'history');
    }

    private getSubAgentTranscriptPath(conversationId: string, runId: string): any {
        return this.vscode.Uri.joinPath(
            this.getConversationDir(conversationId),
            'subagents',
            `${encodeURIComponent(runId)}.json`
        );
    }

    private getHistoryIndexPath(conversationId: string): any {
        return this.vscode.Uri.joinPath(this.getConversationDir(conversationId), 'history.index.json');
    }

    private getMetadataPath(conversationId: string): any {
        assertSafeStorageId(conversationId, 'conversation id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations',
            `${conversationId}.meta.json`
        );
    }

    private getSnapshotPath(snapshotId: string): any {
        assertSafeStorageId(snapshotId, 'snapshot id');
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'snapshots',
            `${snapshotId}.json`
        );
    }

    private getConversationsRootDir(): any {
        // 修改原因：reveal 兜底需要打开 conversations 根目录，而不是在 handler 中拼接存储路径。
        // 修改方式：把 root URI 构造留在 FileSystemStorageAdapter 内部复用 baseDir 和 VS Code Uri API。
        // 修改目的：所有 conversation 存储路径规则集中在存储适配器里维护。
        return this.vscode.Uri.joinPath(
            this.vscode.Uri.parse(this.baseDir),
            'conversations'
        );
    }

    getConversationsDirFsPath(): string {
        // 用量统计的目录监听（fs.watch）需要本地文件系统路径；
        // 与 getConversationsRootDir 同源，避免路径规则在 adapter 外重复拼接。
        return this.getConversationsRootDir().fsPath;
    }
    
    private async exists(uri: any): Promise<boolean> {
        try { await this.vscode.workspace.fs.stat(uri); return true; }
        catch { return false; }
    }

    /**
     * 带 EPERM/EACCES/EBUSY 重试的 rename（与 BranchGraphRepository.renameWithRetry 同风格）：
     * Windows 上 rename 偶发 EPERM（文件锁/杀软竞态），短暂退避重试后仍失败才抛出。
     * 仅重试「可恢复」错误码（EPERM/EACCES/EBUSY，及 vscode FileSystemError 对应的
     * NoPermissions/Unavailable）；其他错误（ENOENT 等）立即抛出。
     */
    private async renameWithRetry(src: any, dest: any, overwrite: boolean, attempts = 4, delayMs = 30): Promise<void> {
        for (let attempt = 1; ; attempt += 1) {
            try {
                await this.vscode.workspace.fs.rename(src, dest, { overwrite });
                return;
            } catch (error: any) {
                const code = String(error?.code ?? '');
                const retryable =
                    code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
                    || code === 'NoPermissions' || code === 'Unavailable';
                if (!retryable || attempt >= attempts) {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
            }
        }
    }

    /**
     * 原子覆盖：优先 overwrite rename（无窗口，并发读始终看到完整旧状态或完整新状态）；
     * 平台不支持 overwrite 或瞬态重试耗尽时回退「旧目标改名备份 → rename 到位 → 清理备份」
     * （与 DependencyManager 目录替换同模式）。第二次 rename 失败时把备份恢复回去，避免
     * 「已删旧、新未落位」的不可恢复状态：例如 writeSegmentedHistory 中若在线 history 目录
     * 被删后 rename 再失败，分段历史不可读且 appendHistory 的 H5/M4 自愈只能从目录残留段
     * 文件/legacy 快照重建，二者都已不在时无法重建（只能抛错，不静默丢）。
     * 调用方必须已保证写写串行（runSegmentedHistoryWriteSerialized 或单写者）。
     */
    private async renameOverwrite(src: any, dest: any): Promise<void> {
        try {
            await this.renameWithRetry(src, dest, true);
            return;
        } catch {
            // 平台不支持 overwrite（rename 覆盖目标抛 FileExists 等）或瞬态重试耗尽：
            // 进入「删旧 + rename」回退，但删旧改为「改名备份」，第二次 rename 失败可恢复。
            const destBasename = String(dest?.path ?? '').split('/').filter(Boolean).pop() ?? 'dest';
            const backup = this.vscode.Uri.joinPath(
                dest,
                '..',
                `${destBasename}.rename-backup-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
            );
            let backupMoved = false;
            try {
                await this.renameWithRetry(dest, backup, false);
                backupMoved = true;
            } catch {
                // 旧目标改名备份失败（目标已被并发删除等罕见情况）：退回「删旧目标后重试」
                try {
                    await this.vscode.workspace.fs.delete(dest, { useTrash: false });
                } catch {
                    // ignore（目标不存在）
                }
                await this.renameWithRetry(src, dest, false);
                return;
            }
            if (backupMoved) {
                try {
                    await this.renameWithRetry(src, dest, false);
                } catch (error) {
                    // 第二次 rename 失败：恢复备份，尽量保留旧目标（恢复也失败时抛原错误、
                    // 不静默——旧目标仍在备份路径，可人工恢复，不会「删旧后丢失」）。
                    try {
                        await this.renameWithRetry(backup, dest, false);
                    } catch (restoreError) {
                        log.warn('renameOverwriteRestoreFailed', {
                            backup: backup?.fsPath ?? String(backup),
                            dest: dest?.fsPath ?? String(dest),
                            error: String((restoreError as Error)?.message ?? restoreError)
                        });
                    }
                    throw error;
                }
                // rename 成功：清理备份（recursive 对文件同样有效，目录也覆盖）
                try {
                    await this.vscode.workspace.fs.delete(backup, { recursive: true, useTrash: false });
                } catch {
                    // 备份清理失败忽略（不影响已完成的替换）
                }
            }
        }
    }

    /** 写临时段文件 → 原子替换到线上段路径 */
    private async atomicWriteSegment(tmpUri: any, destUri: any, messages: ConversationHistory): Promise<void> {
        const content = messages.map(item => JSON.stringify(item)).join('\n');
        await this.vscode.workspace.fs.writeFile(tmpUri, Buffer.from(content, 'utf8'));
        await this.renameOverwrite(tmpUri, destUri);
    }

    /** 历史提交后统一维护 updatedAt（与 saveHistory 同链，避免覆盖 custom 字段） */
    private async refreshUpdatedAt(conversationId: string): Promise<void> {
        try {
            await withMetadataWriteSerialized(conversationId, async () => {
                const meta = await this.loadMetadata(conversationId);
                if (meta) {
                    meta.updatedAt = Date.now();
                    await this.saveMetadata(meta);
                }
            });
        } catch {
            // 忽略元数据更新失败
        }
    }

    /**
     * 读段（命中缓存跳过读盘，HIS-06）。
     * M5：外部进程直接改段文件不会改变 totalMessages，revision 无法感知；
     * 命中前先 stat 段文件并把 mtime 纳入缓存键，mtime 变化 → 缓存失效重读（成本可控，不解析内容）。
     */
    private async readSegmentCached(
        conversationId: string,
        historyDir: any,
        segment: FileHistorySegmentIndexEntry,
        revision: string
    ): Promise<StorageReadResult<ConversationHistory>> {
        const segmentUri = this.vscode.Uri.joinPath(historyDir, segment.file);
        let mtimeKey = 'missing';
        try {
            const stat = await this.vscode.workspace.fs.stat(segmentUri);
            // mtime + size 双键：文件系统 mtime 精度不足（同毫秒写入/FAT 2 秒粒度）时，
            // size 变化仍能感知，避免缓存读到陈旧内容。
            mtimeKey = `${stat.mtime ?? 0}:${stat.size ?? 0}`;
        } catch {
            // 文件缺失/stat 失败：不命中缓存（由 readHistorySegment 返回 not_found/io_error）
        }
        const cacheKey = `${revision}::m${mtimeKey}`;
        const cached = this.segmentCache.get(conversationId, segment.file, cacheKey);
        if (cached) {
            return { value: cached };
        }
        const result = await this.readHistorySegment(segmentUri);
        if (result.value) {
            this.segmentCache.set(conversationId, segment.file, cacheKey, result.value);
        }
        return result;
    }

    async getConversationStorageLocation(conversationId: string): Promise<ConversationStorageLocation> {
        // 修改原因：历史页“在文件管理器中显示”需要优先定位真实存在的对话存储文件。
        // 修改方式：按当前存储格式优先级选择 segmented history.index.json，其次 legacy history，再其次 metadata；全部缺失时回退到 conversations 根目录。
        // 修改目的：支持新旧存储格式，同时在文件缺失时给用户明确反馈而不是静默无效。
        const historyIndexUri = this.getHistoryIndexPath(conversationId);
        const legacyHistoryUri = this.getLegacyHistoryPath(conversationId);
        const metadataUri = this.getMetadataPath(conversationId);
        const conversationDir = this.getConversationDir(conversationId);
        const conversationsRoot = this.getConversationsRootDir();

        if (await this.exists(historyIndexUri)) {
            return { revealUri: historyIndexUri, displayPath: historyIndexUri.fsPath || historyIndexUri.toString(), exists: true };
        }
        if (await this.exists(legacyHistoryUri)) {
            return { revealUri: legacyHistoryUri, displayPath: legacyHistoryUri.fsPath || legacyHistoryUri.toString(), exists: true };
        }
        if (await this.exists(metadataUri)) {
            return { revealUri: metadataUri, displayPath: metadataUri.fsPath || metadataUri.toString(), exists: true };
        }
        if (await this.exists(conversationDir)) {
            return {
                revealUri: conversationDir,
                displayPath: conversationDir.fsPath || conversationDir.toString(),
                exists: false,
                warning: `Conversation storage files are missing for ${conversationId}; opened the conversation directory instead.`
            };
        }
        return {
            revealUri: conversationsRoot,
            displayPath: conversationsRoot.fsPath || conversationsRoot.toString(),
            exists: false,
            warning: `Conversation storage files are missing for ${conversationId}; opened the conversations directory instead.`
        };
    }

    private async readJsonFile<T>(uri: any): Promise<StorageReadResult<T>> {
        try {
            const content = await this.vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(content).toString('utf8');
            try {
                return { value: JSON.parse(text) as T };
            } catch (parseError: any) {
                return {
                    value: null,
                    errorCode: 'parse_error',
                    errorMessage: parseError?.message || 'Failed to parse JSON',
                };
            }
        } catch (error: any) {
            if (isNotFoundError(error)) {
                return {
                    value: null,
                    errorCode: 'not_found',
                    errorMessage: error?.message,
                };
            }
            return {
                value: null,
                errorCode: 'io_error',
                errorMessage: error?.message || String(error),
            };
        }
    }

    private async readHistorySegment(uri: any): Promise<StorageReadResult<ConversationHistory>> {
        try {
            const content = await this.vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(content).toString('utf8');
            if (!text.trim()) {
                return { value: [] };
            }

            const messages: ConversationHistory = [];
            for (const rawLine of text.split(/\r?\n/)) {
                const line = rawLine.trim();
                if (!line) continue;
                try {
                    messages.push(JSON.parse(line) as Content);
                } catch (parseError: any) {
                    return {
                        value: null,
                        errorCode: 'parse_error',
                        errorMessage: parseError?.message || 'Failed to parse history segment',
                    };
                }
            }

            return { value: messages };
        } catch (error: any) {
            if (isNotFoundError(error)) {
                return {
                    value: null,
                    errorCode: 'not_found',
                    errorMessage: error?.message,
                };
            }
            return {
                value: null,
                errorCode: 'io_error',
                errorMessage: error?.message || String(error),
            };
        }
    }

    private async readHistoryIndex(conversationId: string): Promise<StorageReadResult<FileHistoryIndex>> {
        return await this.readJsonFile<FileHistoryIndex>(this.getHistoryIndexPath(conversationId));
    }

    /**
     * 枚举 history 目录下的段文件（*.ndjson），按文件名升序返回。
     * 目录不存在/不可读时返回空数组（调用方按「无段文件」处理，H5）。
     */
    private async enumerateHistorySegmentFiles(historyDir: any): Promise<string[]> {
        try {
            const entries = await this.vscode.workspace.fs.readDirectory(historyDir);
            return entries
                .filter(([name, type]) => type === FS_ENTRY_TYPE_FILE && /^\d{6}\.ndjson$/.test(name))
                .map(([name]) => name)
                .sort();
        } catch {
            return [];
        }
    }

    /**
     * H5：index 不可读（parse_error/io_error）或缺失但目录残留段文件时的自愈恢复。
     *
     * 与 M4 尾段自愈同口径，返回可重建的 existing 历史（不含待追加的 pending）：
     * - 目录中存在段文件且全部可读：按文件名顺序合并全部段内容；
     * - 部分段可读、部分不可读：抛错（跳过会静默丢消息，与 M4「任一段不可读抛错」一致）；
     * - 全部段不可读 / 目录无段文件：回退 legacy 快照（legacy 在分段完成后才删除，崩溃窗口内
     *   它是旧快照）；legacy 也不可用时：
     *   - not_found 且目录无段文件：全新对话 → 空历史（旧语义，保证 createConversation 后首次 append）；
     *   - 其它（parse_error/io_error，或有段文件但全部不可读）：抛错，不静默写空历史覆盖。
     *
     * 注意 at-most-once（H1）：正常路径按 index.count 截断尾段残留；此处 index 不可读，
     * 无法恢复已提交计数，只能按段文件实际内容全量读取——崩溃残留的未提交行会随全量重写
     * 一并提交（在「丢历史」与「可能多收一条未提交消息」之间选择前者，宁可多不可少）。
     */
    private async recoverHistoryForAppend(
        conversationId: string,
        historyDir: any,
        indexResult: StorageReadResult<FileHistoryIndex>
    ): Promise<ConversationHistory> {
        const files = await this.enumerateHistorySegmentFiles(historyDir);
        if (files.length === 0) {
            // 目录没有段文件：回退 legacy（与旧 not_found 语义一致，区别见抛错分支）
            const legacyResult = asHistoryReadResult(
                await this.readJsonFile<ConversationHistory>(this.getLegacyHistoryPath(conversationId))
            );
            if (legacyResult.value !== null) {
                return legacyResult.value;
            }
            if (indexResult.errorCode === 'not_found') {
                // not_found 且目录无段文件、无 legacy：全新对话 → 空历史
                return [];
            }
            throw new Error(
                `appendHistory: cannot self-heal, index unreadable and no readable history for `
                + `${conversationId} (${indexResult.errorCode ?? 'unknown'}: `
                + `${indexResult.errorMessage ?? 'no segments and no legacy history'})`
            );
        }

        let readableSegmentCount = 0;
        const readable: ConversationHistory = [];
        const unreadableSegments: string[] = [];
        for (const file of files) {
            const segResult = await this.readHistorySegment(this.vscode.Uri.joinPath(historyDir, file));
            if (!segResult.value) {
                unreadableSegments.push(file);
                continue;
            }
            readableSegmentCount += 1;
            readable.push(...segResult.value);
        }
        if (readableSegmentCount > 0 && unreadableSegments.length > 0) {
            // 部分段可读、部分不可读：无法安全重建（跳过会静默丢消息），抛错
            throw new Error(
                `appendHistory: cannot self-heal, unreadable history segment(s) `
                + `${unreadableSegments.join(', ')} for ${conversationId}`
            );
        }
        if (readableSegmentCount === 0) {
            // 全部段不可读：回退 legacy；legacy 也没有 → 抛错（不静默丢）
            const legacyResult = asHistoryReadResult(
                await this.readJsonFile<ConversationHistory>(this.getLegacyHistoryPath(conversationId))
            );
            if (legacyResult.value !== null) {
                return legacyResult.value;
            }
            throw new Error(
                `appendHistory: cannot self-heal, all history segments unreadable and no legacy `
                + `history for ${conversationId} (${indexResult.errorCode ?? 'unknown'}: `
                + `${indexResult.errorMessage ?? 'unreadable segments and no legacy history'})`
            );
        }
        return readable;
    }

    private async writeSegmentedHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        const conversationDir = this.getConversationDir(conversationId);
        const historyDir = this.getHistoryDir(conversationId);
        const historyIndexPath = this.getHistoryIndexPath(conversationId);
        // 注意：tmp 路径必须是 Uri 对象，不能把 Uri 对象与字符串拼接（`uri + '.tmp'` 会隐式调用 toString()
        // 得到字符串），字符串传给 workspace.fs 时会被当作 UriComponents 重新解析，scheme 变成整串非法字符，
        // 抛 [UriError]: Scheme contains illegal characters，导致新建对话/保存历史失败。
        const tmpDir = this.vscode.Uri.joinPath(conversationDir, 'history.tmp');
        const tmpIndexPath = this.vscode.Uri.joinPath(conversationDir, 'history.index.json.tmp');

        await this.vscode.workspace.fs.createDirectory(conversationDir);

        // 0. 写前清理崩溃残留：临时目录与临时 index 都要清。
        //    段数变少时，残留的旧段文件会随 rename 进入线上目录成为孤儿文件（磁盘泄漏）。
        try {
            await this.vscode.workspace.fs.delete(tmpDir, { recursive: true, useTrash: false });
        } catch {
            // 不存在或清理失败，忽略
        }
        try {
            await this.vscode.workspace.fs.delete(tmpIndexPath, { useTrash: false });
        } catch {
            // 不存在或清理失败，忽略
        }

        // 1. 先写临时目录，不触碰线上目录：中途崩溃时线上仍是完整的旧状态，
        //    不会出现 index 缺失且 legacy 已被删的历史不可读场景。
        await this.vscode.workspace.fs.createDirectory(tmpDir);

        const segments: FileHistorySegmentIndexEntry[] = [];
        for (let startIndex = 0; startIndex < history.length; startIndex += FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE) {
            const endExclusive = Math.min(history.length, startIndex + FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE);
            const chunk = history.slice(startIndex, endExclusive);
            const file = `${String(segments.length).padStart(6, '0')}.ndjson`;
            const uri = this.vscode.Uri.joinPath(tmpDir, file);
            const content = chunk.map(item => JSON.stringify(item)).join('\n');
            await this.vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            segments.push({ file, startIndex, endIndex: endExclusive - 1, count: chunk.length });
        }

        const index: FileHistoryIndex = {
            version: 1,
            segmentSize: FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE,
            totalMessages: history.length,
            segments,
        };

        await this.vscode.workspace.fs.writeFile(tmpIndexPath, Buffer.from(JSON.stringify(index, null, 2), 'utf8'));

        // 2. 原子切换：优先 overwrite rename（无窗口，并发读始终看到完整旧状态或完整新状态）；
        //    平台不支持 overwrite 或瞬态 EPERM 重试耗尽时，renameOverwrite 内部回退
        //    「旧目标改名备份 → rename 到位 → 清理备份」，第二次 rename 失败时恢复备份，
        //    不会留下「在线 history 目录已删、新目录未落位」的不可恢复状态（H5/M4 自愈依赖
        //    目录残留段文件或 legacy 快照，两者都被清掉时无法重建，只能抛错不静默丢）。
        await this.renameOverwrite(tmpDir, historyDir);
        await this.renameOverwrite(tmpIndexPath, historyIndexPath);

        // 3. 删除遗留的 legacy 历史文件
        try {
            await this.vscode.workspace.fs.delete(this.getLegacyHistoryPath(conversationId), { useTrash: false });
        } catch {
            // ignore
        }

        // 写后失效（HIS-06）：本次提交后该会话所有缓存段不可信
        this.segmentCache.invalidateConversation(conversationId);
    }

    /**
     * 追加历史（append-only 尾段写入，HIS-01）。
     *
     * 崩溃一致性：写临时尾段→原子替换→写临时 index→原子替换。
     * index 是有效历史的提交点：段文件先于 index 就位，崩溃时旧 index 不引用新内容
     * （多出的行在 load 时按 index.count 截断，不会进入完整历史）。
     * 再次 append 尾段前同样按 index.count 截断（H1），保证重试 at-most-once。
     */
    async appendHistory(conversationId: string, contents: ConversationHistory): Promise<void> {
        const pending = Array.isArray(contents) ? contents : [];
        if (pending.length === 0) return;

        await runSegmentedHistoryWriteSerialized(conversationId, async () => {
            const indexResult = await this.readHistoryIndex(conversationId);
            const conversationDir = this.getConversationDir(conversationId);
            const historyDir = this.getHistoryDir(conversationId);
            const historyIndexPath = this.getHistoryIndexPath(conversationId);
            // 注意：tmp 路径必须是 Uri 对象（见 writeSegmentedHistory 注释，字符串会触发 UriError）
            const tmpSegmentPath = this.vscode.Uri.joinPath(conversationDir, 'history.append.tmp.ndjson');
            const tmpIndexPath = this.vscode.Uri.joinPath(conversationDir, 'history.index.json.tmp');

            if (!indexResult.value) {
                // H5：index 不可读时不再静默回退 legacy 全量重写。旧行为把 parse_error/io_error
                // 也当成「尚无分段索引」处理：此时 legacy 已在分段完成后删除（读得 null），
                // existing = legacy ?? [] = [] → writeSegmentedHistory([] + pending)，整段分段历史
                // 被覆盖丢失。现在与 M4 尾段自愈同口径：优先从目录枚举段文件读取合并；
                // 任一段不可读抛错（不静默丢）；全部不可读才回退 legacy；都没有才抛错。
                // not_found 且目录无段文件才是「尚无分段索引」的正常形态（legacy 或全新对话），
                // 保留旧回退语义（legacy ?? []）；目录实际残留段文件（index 被外部删除）时同样走自愈。
                const existing = await this.recoverHistoryForAppend(conversationId, historyDir, indexResult);
                await this.writeSegmentedHistory(conversationId, existing.concat(pending));
                await this.refreshUpdatedAt(conversationId);
                return;
            }

            const index = indexResult.value;
            const segments = index.segments.map(segment => ({ ...segment }));
            let totalMessages = index.totalMessages;
            let cursor = 0;

            while (cursor < pending.length) {
                const remainingCount = pending.length - cursor;

                if (segments.length === 0) {
                    // 空历史（createConversation 写入过 []）→ 新建 000000.ndjson
                    const take = Math.min(remainingCount, FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE);
                    const chunk = pending.slice(cursor, cursor + take);
                    const file = '000000.ndjson';
                    await this.vscode.workspace.fs.createDirectory(historyDir);
                    await this.atomicWriteSegment(tmpSegmentPath, this.vscode.Uri.joinPath(historyDir, file), chunk);
                    segments.push({ file, startIndex: totalMessages, endIndex: totalMessages + take - 1, count: take });
                    totalMessages += take;
                    cursor += take;
                    continue;
                }

                const last = segments[segments.length - 1];
                const freeSlots = FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE - last.count;
                if (freeSlots > 0) {
                    // 尾段未满：读尾段 → 追加 → 写临时 → 原子替换
                    const take = Math.min(remainingCount, freeSlots);
                    const chunk = pending.slice(cursor, cursor + take);
                    const lastUri = this.vscode.Uri.joinPath(historyDir, last.file);
                    const segmentResult = await this.readHistorySegment(lastUri);
                    if (!segmentResult.value) {
                        // M4：index 存在但尾段缺失/损坏时不再直接抛错，回退“可读段或 legacy 合并全量重写”自愈。
                        // 优先从可读 segments 重建（保留分段之后的追加内容）；只有没有任何 segment 可读时
                        // 才用 legacy 快照（legacy 在分段完成后才删除，崩溃窗口内它是旧快照，会丢分段后的追加）。
                        let existing: ConversationHistory = [];
                        let anySegmentReadable = false;
                        // 中间段不可读时不得静默跳过：跳过会让自愈重写把该段消息悄悄丢弃（静默数据
                        // 丢失）。收集所有失败段并整体报错，由上层按「历史不可读」处理；只有全部
                        // 中间段可读（或根本没有中间段）时才继续自愈重写。
                        const unreadableSegments: string[] = [];
                        for (let i = 0; i < segments.length - 1; i++) {
                            const seg = segments[i];
                            const segResult = await this.readHistorySegment(this.vscode.Uri.joinPath(historyDir, seg.file));
                            if (!segResult.value) {
                                unreadableSegments.push(seg.file);
                                continue;
                            }
                            anySegmentReadable = true;
                            existing.push(...segResult.value.slice(0, seg.count));
                        }
                        if (unreadableSegments.length > 0) {
                            throw new Error(
                                `appendHistory: cannot self-heal, unreadable history segment(s) `
                                + `${unreadableSegments.join(', ')} for ${conversationId}`
                            );
                        }
                        if (!anySegmentReadable) {
                            const legacyResult = asHistoryReadResult(
                                await this.readJsonFile<ConversationHistory>(this.getLegacyHistoryPath(conversationId))
                            );
                            if (legacyResult.value && legacyResult.value.length > 0) {
                                existing = legacyResult.value;
                            }
                        }
                        await this.writeSegmentedHistory(conversationId, existing.concat(pending.slice(cursor)));
                        await this.refreshUpdatedAt(conversationId);
                        return;
                    }
                    // H1：以 index.count 为提交点截断尾段残留（上次 append 尾段 rename 成功但 index
                    // 写失败/崩溃时，尾段文件会多出未提交行），再拼接本次新增——at-most-once，
                    // 调用方重试不会重复追加，totalMessages 与 Σcount 保持一致。
                    const updated = segmentResult.value.slice(0, last.count).concat(chunk);
                    await this.atomicWriteSegment(tmpSegmentPath, lastUri, updated);
                    last.count = updated.length;
                    last.endIndex = last.startIndex + updated.length - 1;
                    totalMessages += take;
                    cursor += take;
                    continue;
                }

                // 尾段已满：新建下一段
                const take = Math.min(remainingCount, FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE);
                const chunk = pending.slice(cursor, cursor + take);
                const file = `${String(segments.length).padStart(6, '0')}.ndjson`;
                await this.vscode.workspace.fs.createDirectory(historyDir);
                await this.atomicWriteSegment(tmpSegmentPath, this.vscode.Uri.joinPath(historyDir, file), chunk);
                segments.push({ file, startIndex: totalMessages, endIndex: totalMessages + take - 1, count: take });
                totalMessages += take;
                cursor += take;
            }

            const nextIndex: FileHistoryIndex = {
                version: 1,
                segmentSize: FileSystemStorageAdapter.HISTORY_SEGMENT_SIZE,
                // 提交前重算 totalMessages = Σ segments.count：异常态（index.count 大于段实际行数等）
                // 下以实际写入段为准，避免分页 total 与完整历史长度不一致。
                totalMessages: segments.reduce((sum, segment) => sum + segment.count, 0),
                segments,
            };

            // 提交点：先段后 index（写临时 index → 原子替换）
            await this.vscode.workspace.fs.writeFile(tmpIndexPath, Buffer.from(JSON.stringify(nextIndex, null, 2), 'utf8'));
            await this.renameOverwrite(tmpIndexPath, historyIndexPath);

            // 写后失效（HIS-06）
            this.segmentCache.invalidateConversation(conversationId);

            await this.refreshUpdatedAt(conversationId);
        });
    }

    /**
     * 索引结构信息（HIS-11）：只读 index.json 或 legacy 存在性，不解析段消息内容。
     * M1：
     * - (a) legacy 单文件历史至少做一次 JSON.parse 探测，损坏 JSON 报不可读（旧行为误报 ok）；
     * - (b) segmented 分支对 segments 逐个 stat 存在性（不解析内容），任一缺失报不可读（旧行为误报 ok）。
     */
    async getHistoryIndexInfo(conversationId: string): Promise<HistoryIndexInfo> {
        const indexPath = this.getHistoryIndexPath(conversationId);
        if (await this.exists(indexPath)) {
            const result = await this.readHistoryIndex(conversationId);
            if (!result.value) {
                return {
                    exists: true,
                    readable: false,
                    errorCode: result.errorCode,
                    errorMessage: result.errorMessage,
                };
            }
            // M1(b)：index 完好但段文件缺失 → readable=false（只 stat，保持 HIS-11 只读结构目标）
            const historyDir = this.getHistoryDir(conversationId);
            for (const segment of result.value.segments) {
                if (!(await this.exists(this.vscode.Uri.joinPath(historyDir, segment.file)))) {
                    return {
                        exists: true,
                        readable: false,
                        totalMessages: result.value.totalMessages,
                        segmentCount: result.value.segments.length,
                        errorCode: 'segment_missing',
                        errorMessage: `Missing history segment file ${segment.file} for ${conversationId}`,
                    };
                }
            }
            return {
                exists: true,
                readable: true,
                totalMessages: result.value.totalMessages,
                segmentCount: result.value.segments.length,
            };
        }
        const legacyPath = this.getLegacyHistoryPath(conversationId);
        if (await this.exists(legacyPath)) {
            // M1(a)：legacy 分支至少做一次 JSON.parse 探测，损坏 JSON / 非数组 JSON 报不可读
            const legacyResult = asHistoryReadResult(
                await this.readJsonFile<ConversationHistory>(legacyPath)
            );
            return {
                exists: true,
                readable: legacyResult.value !== null,
                errorCode: legacyResult.errorCode,
                errorMessage: legacyResult.errorMessage,
            };
        }
        return { exists: false, readable: false };
    }

    /**
     * 仅读 index JSON 取 totalMessages（updateSummary M3 钳制用，HIS-11 轻量路径）：
     * 1 次读、0 次逐段 stat。索引不可读 / legacy / 不存在返回 null（钳制跳过）。
     */
    async getHistoryTotalMessages(conversationId: string): Promise<number | null> {
        const result = await this.readHistoryIndex(conversationId);
        return result.value ? result.value.totalMessages : null;
    }

    private async loadSegmentedHistory(conversationId: string): Promise<StorageReadResult<ConversationHistory>> {
        const indexResult = await this.readHistoryIndex(conversationId);
        if (!indexResult.value) {
            return { value: null, errorCode: indexResult.errorCode, errorMessage: indexResult.errorMessage };
        }

        const index = indexResult.value;
        // 双 rename 提交窗口 / 损坏 index 校验：writeSegmentedHistory 的目录 rename 与 index rename
        // 是两次独立操作，读侧可能短暂看到“新段文件 + 旧 index”。Σsegments.count !== totalMessages
        // 或段区间不连续时，直接返回 segment_missing（外层重试），而不是静默返回截断/错位历史。
        const consistencyError = validateIndexConsistency(index);
        if (consistencyError) {
            return { value: null, errorCode: 'segment_missing', errorMessage: consistencyError };
        }

        const revision = buildSegmentCacheRevision(index);
        const historyDir = this.getHistoryDir(conversationId);
        // HIS-05：多段有界并发读取（结果按段顺序返回）
        const results = await runBounded(index.segments, FileSystemStorageAdapter.SEGMENT_READ_CONCURRENCY, segment =>
            this.readSegmentCached(conversationId, historyDir, segment, revision)
        );

        const history: ConversationHistory = [];
        for (let i = 0; i < index.segments.length; i++) {
            const segmentResult = results[i];
            if (!segmentResult.value) {
                return { value: null, errorCode: segmentResult.errorCode, errorMessage: segmentResult.errorMessage };
            }
            // 以 index.count 为提交点：崩溃残留（段文件多于 index 计数）不进入完整历史
            // M2：返回前对元素做浅拷贝——缓存元素引用不再泄漏给调用方，
            // 调用方对消息顶层属性的原地赋值（如 tokenCountByChannel = {...}）不会污染缓存。
            // 嵌套结构（parts 等）仍与缓存共享引用：需要原地修改嵌套内容的调用方必须先深拷贝
            // 目标消息（约定见 manager/query.ts、manager/toolCalls.ts 的「先深拷贝再修改」）。
            history.push(...segmentResult.value.slice(0, index.segments[i].count).map(msg => ({ ...msg })));
        }

        // R2 3.1：双 rename 提交窗口复核——writeSegmentedHistory 先换目录再换 index，
        // 读取期间可能发生“段文件已换新、index 仍是旧版”：validateIndexConsistency 只能
        // 校验 index 自身一致性（旧 index 完全自洽），无法发现段文件已被换掉导致的静默错读。
        // 段读取完成后重读一次 index，比对 totalMessages 与段标识（文件名/区间/计数）；
        // 不一致说明读到的是提交窗口内的混合状态，按可重试错误返回，外层重试后读到一致状态。
        const recheck = await this.verifyIndexUnchanged(conversationId, index);
        if (!recheck.value) {
            return { value: null, errorCode: recheck.errorCode ?? 'segment_missing', errorMessage: recheck.errorMessage };
        }

        return { value: history };
    }

    /**
     * 双 rename 窗口复核：段文件读取完成后重读一次 index，与读取前解析的 index 版本比对。
     * 一致返回最新 index；不一致返回可重试错误（segment_missing）。
     */
    private async verifyIndexUnchanged(conversationId: string, expected: FileHistoryIndex): Promise<StorageReadResult<FileHistoryIndex>> {
        const recheck = await this.readHistoryIndex(conversationId);
        if (!recheck.value) {
            return { value: null, errorCode: recheck.errorCode, errorMessage: recheck.errorMessage };
        }
        if (!sameIndexVersion(recheck.value, expected)) {
            return {
                value: null,
                errorCode: 'segment_missing',
                errorMessage: `History index changed during segment read (double-rename commit window) for ${conversationId}; retry`
            };
        }
        return recheck;
    }

    private async loadSegmentedHistoryPage(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<StorageReadResult<StorageHistoryPage>> {
        const indexResult = await this.readHistoryIndex(conversationId);
        if (!indexResult.value) {
            return { value: null, errorCode: indexResult.errorCode, errorMessage: indexResult.errorMessage };
        }

        const index = indexResult.value;
        // 与 loadSegmentedHistory 相同的索引一致性校验（仅内存计算，无额外 IO）
        const consistencyError = validateIndexConsistency(index);
        if (consistencyError) {
            return { value: null, errorCode: 'segment_missing', errorMessage: consistencyError };
        }
        const { startIndex, endExclusive } = buildPageRange(index.totalMessages, options);
        const revision = buildSegmentCacheRevision(index);
        const historyDir = this.getHistoryDir(conversationId);

        const relevant: Array<{ segment: FileHistorySegmentIndexEntry; segmentIndex: number }> = [];
        for (let i = 0; i < index.segments.length; i++) {
            const segment = index.segments[i];
            if (segment.endIndex < startIndex || segment.startIndex >= endExclusive) continue;
            relevant.push({ segment, segmentIndex: i });
        }

        // HIS-05：多段有界并发读取
        const results = await runBounded(relevant, FileSystemStorageAdapter.SEGMENT_READ_CONCURRENCY, ({ segment }) =>
            this.readSegmentCached(conversationId, historyDir, segment, revision)
        );

        const messages: ConversationHistory = [];
        for (let k = 0; k < relevant.length; k++) {
            const { segment } = relevant[k];
            const segmentResult = results[k];
            if (!segmentResult.value) {
                return { value: null, errorCode: segmentResult.errorCode, errorMessage: segmentResult.errorMessage };
            }

            const localStart = Math.max(0, startIndex - segment.startIndex);
            const localEndExclusive = Math.min(segment.count, endExclusive - segment.startIndex);
            // M2：元素浅拷贝（见 loadSegmentedHistory 注释），避免缓存元素引用泄漏给调用方
            messages.push(...segmentResult.value.slice(localStart, localEndExclusive).map(msg => ({ ...msg })));
        }

        // R2 3.1：双 rename 提交窗口复核（与 loadSegmentedHistory 相同，见 verifyIndexUnchanged）
        const recheck = await this.verifyIndexUnchanged(conversationId, index);
        if (!recheck.value) {
            return { value: null, errorCode: recheck.errorCode ?? 'segment_missing', errorMessage: recheck.errorMessage };
        }

        return {
            value: {
                total: index.totalMessages,
                startIndex,
                messages,
                format: 'paged'
            }
        };
    }

    async migrateLegacyConversationsToSegmented(progressCallback?: (status: { current: number; total: number; conversationId?: string }) => void): Promise<{
        migrated: number;
        skipped: number;
        failed: Array<{ conversationId: string; error: string }>;
    }> {
        const conversationIds = await this.listConversations();
        const failed: Array<{ conversationId: string; error: string }> = [];
        let migrated = 0;
        let skipped = 0;

        const resolvedLegacyIds: string[] = [];
        for (const id of conversationIds) {
            if (await this.exists(this.getLegacyHistoryPath(id))) {
                resolvedLegacyIds.push(id);
            }
        }

        const total = resolvedLegacyIds.length;
        for (let i = 0; i < resolvedLegacyIds.length; i++) {
            const conversationId = resolvedLegacyIds[i];
            progressCallback?.({ current: i + 1, total, conversationId });
            try {
                if (await this.exists(this.getHistoryIndexPath(conversationId))) {
                    await this.vscode.workspace.fs.delete(this.getLegacyHistoryPath(conversationId), { useTrash: false });
                    skipped++;
                    continue;
                }
                const historyResult = asHistoryReadResult(
                    await this.readJsonFile<ConversationHistory>(this.getLegacyHistoryPath(conversationId))
                );
                const legacyHistory = historyResult.value;
                if (!legacyHistory) throw new Error(historyResult.errorMessage || historyResult.errorCode || 'Failed to read legacy history');
                // 与 saveHistory 共用同一写队列：迁移与用户消息写入并发时，
                // 两路写共用同一 history.tmp 路径，会互相删除对方刚写的临时目录。
                await runSegmentedHistoryWriteSerialized(conversationId, async () => {
                    await this.writeSegmentedHistory(conversationId, legacyHistory);
                });
                migrated++;
            } catch (error: any) {
                failed.push({ conversationId, error: error?.message || String(error) });
            }
        }

        return { migrated, skipped, failed };
    }


    async saveHistory(conversationId: string, history: ConversationHistory): Promise<void> {
        // 同一会话的写操作串行化：writeSegmentedHistory 先删目录再重写，
        // 并发写会互相删除对方刚写入的段文件（代码多处注释已承认并发写场景）。
        await runSegmentedHistoryWriteSerialized(conversationId, async () => {
            await this.writeSegmentedHistory(conversationId, history);

            // 更新元数据的 updatedAt（必须与 ConversationManager 的元数据读改写共用同一条链，
            // 否则基于旧 meta 的整体写回会互相覆盖 custom 字段）
            try {
                await withMetadataWriteSerialized(conversationId, async () => {
                    const meta = await this.loadMetadata(conversationId);
                    if (meta) {
                        meta.updatedAt = Date.now();
                        await this.saveMetadata(meta);
                    }
                });
            } catch {
                // 忽略元数据更新失败
            }
        });
    }

    async loadHistory(conversationId: string): Promise<ConversationHistory | null> {
        const result = await this.loadHistoryWithStatus(conversationId);
        return result.value;
    }

    private isRetryableReadError(result: StorageReadResult<unknown>): boolean {
        return result.value === null
            && (result.errorCode === 'not_found' || result.errorCode === 'io_error' || result.errorCode === 'segment_missing');
    }

    async loadHistoryWithStatus(conversationId: string): Promise<StorageReadResult<ConversationHistory>> {
        // 写提交（overwrite rename）期间可能短暂读到 not_found/io_error/segment_missing
        // （index 在但段文件尚未就位 / 双 rename 窗口 index 与段错位）：重试最多 2 次带退避，
        // 避免流式迭代中聊天请求被瞬间窗口打断。
        let result = await this.tryLoadHistoryWithStatus(conversationId);
        for (const delay of FileSystemStorageAdapter.READ_RETRY_DELAYS_MS) {
            if (!this.isRetryableReadError(result)) break;
            // R2 3.3：not_found 且 legacy+segmented 双格式都不存在 ⇒ 会话确实不存在（或已删除），
            // 不是写提交窗口，直接返回不重试（避免对已删除/不存在的会话空转 2 次退避重试）。
            if (result.errorCode === 'not_found' && !(await this.historyExistsAnyFormat(conversationId))) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            result = await this.tryLoadHistoryWithStatus(conversationId);
        }
        return result;
    }

    /** 会话是否以任一格式存在（legacy 单文件或 segmented index），用于区分“不存在”与“提交窗口” */
    private async historyExistsAnyFormat(conversationId: string): Promise<boolean> {
        const [index, legacy] = await Promise.all([
            this.exists(this.getHistoryIndexPath(conversationId)),
            this.exists(this.getLegacyHistoryPath(conversationId))
        ]);
        return index || legacy;
    }

    private async tryLoadHistoryWithStatus(conversationId: string): Promise<StorageReadResult<ConversationHistory>> {
        if (await this.exists(this.getHistoryIndexPath(conversationId))) {
            return await this.loadSegmentedHistory(conversationId);
        }

        return asHistoryReadResult(
            await this.readJsonFile<ConversationHistory>(this.getLegacyHistoryPath(conversationId))
        );
    }

    async loadHistoryPage(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<StorageReadResult<StorageHistoryPage>> {
        // 与 loadHistoryWithStatus 相同的写提交窗口重试（最多 2 次带退避，共 3 次尝试）
        let result = await this.tryLoadHistoryPage(conversationId, options);
        for (const delay of FileSystemStorageAdapter.READ_RETRY_DELAYS_MS) {
            if (!this.isRetryableReadError(result)) break;
            // R2 3.3：双格式都不存在 ⇒ 会话不存在，不是提交窗口，直接返回不重试
            if (result.errorCode === 'not_found' && !(await this.historyExistsAnyFormat(conversationId))) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            result = await this.tryLoadHistoryPage(conversationId, options);
        }
        return result;
    }

    private async tryLoadHistoryPage(
        conversationId: string,
        options: { beforeIndex?: number; offset?: number; limit?: number } = {}
    ): Promise<StorageReadResult<StorageHistoryPage>> {
        if (await this.exists(this.getHistoryIndexPath(conversationId))) {
            return await this.loadSegmentedHistoryPage(conversationId, options);
        }

        const historyResult = await this.tryLoadHistoryWithStatus(conversationId);
        if (!historyResult.value) {
            return { value: null, errorCode: historyResult.errorCode, errorMessage: historyResult.errorMessage };
        }

        const history = historyResult.value;
        const { startIndex, endExclusive } = buildPageRange(history.length, options);
        return {
            value: {
                total: history.length,
                startIndex,
                messages: history.slice(startIndex, endExclusive),
                format: 'legacy'
            }
        };
    }

    async deleteHistory(conversationId: string): Promise<void> {
        // 删除与历史写、元数据整体写回都必须串行。尤其是大 meta 写已读取旧值后，若删除不进入
        // metadata 链，其晚到 rename 会在删除完成后重新创建幽灵 .meta.json。
        await runSegmentedHistoryWriteSerialized(conversationId, async () => {
            await withMetadataWriteSerialized(conversationId, async () => {
                this.segmentCache.invalidateConversation(conversationId);
                const historyUri = this.getLegacyHistoryPath(conversationId);
                const metaUri = this.getMetadataPath(conversationId);
                const conversationDir = this.getConversationDir(conversationId);
                try {
                    await this.vscode.workspace.fs.delete(historyUri, { useTrash: false });
                } catch {
                    // ignore
                }
                try {
                    await this.vscode.workspace.fs.delete(conversationDir, { recursive: true, useTrash: false });
                } catch {
                    // ignore
                }
                try {
                    await this.vscode.workspace.fs.delete(metaUri, { useTrash: false });
                } catch {
                    // ignore
                }
            });
        });
    }

    async listConversations(): Promise<string[]> {
        try {
            const dirUri = this.vscode.Uri.joinPath(
                this.vscode.Uri.parse(this.baseDir),
                'conversations'
            );
            const entries = await this.vscode.workspace.fs.readDirectory(dirUri);
            const ids = new Set<string>();
            for (const [name, type] of entries as Array<[string, number]>) {
                // corrupt-* 是 meta 损坏降级备份文件（{id}.meta.json.corrupt-{ts}），
                // 无论如何都不能被当成对话 ID 列入列表。
                if (name.includes('.corrupt-')) continue;
                // 只识别对话历史文件：{id}.json（legacy）与 {id}/ 目录（segmented）；
                // {id}.meta.json 元数据与 {id}.usage.json 用量索引必须排除，
                // 否则会被当成假对话 ID（如 xxx.usage）显示在历史列表并报 metadata missing。
                if (type === FS_ENTRY_TYPE_FILE && name.endsWith('.json') && !name.endsWith('.meta.json') && !name.endsWith('.usage.json')) {
                    ids.add(name.replace('.json', ''));
                    continue;
                }
                if (type === FS_ENTRY_TYPE_DIRECTORY) {
                    // 排除假对话目录：旧版 bug 把 {id}.usage.json 误识别为对话 ID {id}.usage，
                    // 用户点入后写入 segmented 历史，磁盘留下 {id}.usage/ 目录；
                    // 目录分支必须同样排除（.usage 后缀不可能是真实对话 ID）。
                    if (name.endsWith('.usage')) continue;
                    ids.add(name);
                }
            }
            return Array.from(ids);
        } catch {
            return [];
        }
    }

    async saveSubAgentTranscript(conversationId: string, runId: string, data: SubAgentTranscriptData): Promise<string> {
        const uri = this.getSubAgentTranscriptPath(conversationId, runId);
        const directory = this.vscode.Uri.joinPath(this.getConversationDir(conversationId), 'subagents');
        const tmpUri = this.vscode.Uri.joinPath(directory, `${encodeURIComponent(runId)}.json.tmp`);
        await this.vscode.workspace.fs.createDirectory(directory);
        try {
            await this.vscode.workspace.fs.writeFile(tmpUri, Buffer.from(JSON.stringify(data), 'utf8'));
            await this.renameOverwrite(tmpUri, uri);
        } catch (error) {
            try { await this.vscode.workspace.fs.delete(tmpUri, { useTrash: false }); } catch { /* ignore */ }
            throw error;
        }
        return `subagents/${encodeURIComponent(runId)}.json`;
    }

    async loadSubAgentTranscript(conversationId: string, runId: string): Promise<SubAgentTranscriptData | null> {
        const result = await this.readJsonFile<SubAgentTranscriptData>(this.getSubAgentTranscriptPath(conversationId, runId));
        return result.value;
    }

    async deleteSubAgentTranscript(conversationId: string, runId: string): Promise<void> {
        try {
            await this.vscode.workspace.fs.delete(this.getSubAgentTranscriptPath(conversationId, runId), { useTrash: false });
        } catch (error) {
            if (!isNotFoundError(error)) throw error;
        }
    }

    /**
     * 元数据损坏降级备份：把 {id}.meta.json 改名备份为 {id}.meta.json.corrupt-{Date.now()}。
     *
     * 背景：meta.json 因历史非原子写截断（或外部原因）损坏（parse_error）时，
     * ConversationManager.getMetadata 不再向调用方抛 UNKNOWN_ERROR，而是先把损坏文件
     * 改名备份（保留损坏现场供人工排查），再返回从历史重建的 fallback 元数据。
     *
     * 约定：
     * - 只保留一份备份：改名前列出并删除旧的 {id}.meta.json.corrupt-*（避免无限堆积）；
     * - 改名失败不抛错（不阻塞降级主流程）；
     * - 备份文件不会被自动清理（不参与日常删除），排查后可手动删除。
     */
    async backupCorruptMetadata(conversationId: string): Promise<void> {
        const uri = this.getMetadataPath(conversationId);
        if (!(await this.exists(uri))) {
            return;
        }
        const conversationsDir = this.getConversationsRootDir();
        const prefix = `${conversationId}.meta.json.corrupt-`;
        // 只保留一份：先清理旧备份（列出 conversations 目录，删除匹配 .corrupt-* 前缀的文件）
        try {
            const entries = await this.vscode.workspace.fs.readDirectory(conversationsDir);
            for (const [name] of entries as Array<[string, number]>) {
                if (name.startsWith(prefix)) {
                    try {
                        await this.vscode.workspace.fs.delete(
                            this.vscode.Uri.joinPath(conversationsDir, name),
                            { useTrash: false }
                        );
                    } catch {
                        // 旧备份删除失败忽略（后续 rename 仍可完成）
                    }
                }
            }
        } catch {
            // 目录枚举失败不阻塞（后续 rename 仍可完成）
        }
        try {
            // 注意：tmp/备份路径必须是 Uri 对象（字符串拼接会触发 UriError，见 writeSegmentedHistory 注释）
            await this.renameOverwrite(uri, this.vscode.Uri.joinPath(conversationsDir, `${prefix}${Date.now()}`));
        } catch {
            // 改名失败不阻塞降级（原损坏文件保留，下次 getMetadata 会再次尝试）
        }
    }

    /**
     * 原子保存元数据：先写同目录临时文件 {id}.meta.json.tmp，再 rename 覆盖。
     *
     * 旧实现直接 writeFile 线上文件：写入中途崩溃/断电/被杀进程会留下截断的 meta.json
     * （JSON.parse 报 Unterminated string → parse_error → 调用方报 UNKNOWN_ERROR）。
     * 与 appendHistory/writeSegmentedHistory 的提交模式一致：tmp 写完后 rename 是唯一提交点，
     * 崩溃时线上文件要么是完整旧版要么是完整新版，不会截断。
     * 写入失败时清理 tmp（rename 未发生，原 meta.json 不受影响）。
     */
    async saveMetadata(metadata: ConversationMetadata): Promise<void> {
        const uri = this.getMetadataPath(metadata.id);
        const content = JSON.stringify(metadata, null, 2);
        // 注意：tmp 路径必须是 Uri 对象（字符串拼接会触发 UriError，见 writeSegmentedHistory 注释）
        const tmpUri = this.vscode.Uri.joinPath(
            this.getConversationsRootDir(),
            `${metadata.id}.meta.json.tmp`
        );
        try {
            await this.vscode.workspace.fs.writeFile(tmpUri, Buffer.from(content, 'utf8'));
            await this.renameOverwrite(tmpUri, uri);
        } catch (error) {
            // 写入失败：清理临时文件，不留垃圾；原 meta.json 保持完好（rename 未发生）
            try {
                await this.vscode.workspace.fs.delete(tmpUri, { useTrash: false });
            } catch {
                // 清理失败忽略
            }
            throw error;
        }
    }

    async loadMetadata(conversationId: string): Promise<ConversationMetadata | null> {
        const result = await this.loadMetadataWithStatus(conversationId);
        return result.value;
    }

    async loadMetadataWithStatus(conversationId: string): Promise<StorageReadResult<ConversationMetadata>> {
        const uri = this.getMetadataPath(conversationId);
        return await this.readJsonFile<ConversationMetadata>(uri);
    }

    async getConversationIntegrity(conversationId: string): Promise<ConversationStorageIntegrity> {
        const [history, metadata] = await Promise.all([
            this.loadHistoryWithStatus(conversationId),
            this.loadMetadataWithStatus(conversationId),
        ]);
        const historyExists = history.value !== null || history.errorCode !== 'not_found';
        const metadataExists = metadata.value !== null || metadata.errorCode !== 'not_found';
        return {
            historyExists,
            metadataExists,
            historyReadable: history.value !== null,
            metadataReadable: metadata.value !== null,
            historyErrorCode: history.errorCode,
            metadataErrorCode: metadata.errorCode,
            historyErrorMessage: history.errorMessage,
            metadataErrorMessage: metadata.errorMessage,
        };
    }

    async saveSnapshot(snapshot: HistorySnapshot): Promise<void> {
        const uri = this.getSnapshotPath(snapshot.id);
        const content = JSON.stringify(snapshot, null, 2);
        // 与 saveMetadata 同模式：先写同目录临时文件再 rename 覆盖——快照含全量历史，
        // 直接写线上文件在崩溃/被杀时留下截断的 snapshot JSON，loadSnapshot 读到 parse 异常。
        // 注意：tmp 路径必须是 Uri 对象（字符串拼接会触发 UriError，见 writeSegmentedHistory 注释）
        const snapshotsDir = this.vscode.Uri.joinPath(this.vscode.Uri.parse(this.baseDir), 'snapshots');
        const tmpUri = this.vscode.Uri.joinPath(snapshotsDir, `${snapshot.id}.json.tmp`);
        try {
            await this.vscode.workspace.fs.createDirectory(snapshotsDir);
            await this.vscode.workspace.fs.writeFile(tmpUri, Buffer.from(content, 'utf8'));
            await this.renameOverwrite(tmpUri, uri);
        } catch (error) {
            // 写入失败：清理临时文件，不留垃圾；原快照保持完好（rename 未发生）
            try {
                await this.vscode.workspace.fs.delete(tmpUri, { useTrash: false });
            } catch {
                // 清理失败忽略
            }
            throw error;
        }
    }

    async loadSnapshot(snapshotId: string): Promise<HistorySnapshot | null> {
        let content: Uint8Array;
        try {
            const uri = this.getSnapshotPath(snapshotId);
            content = await this.vscode.workspace.fs.readFile(uri);
        } catch (error) {
            // 文件不存在视为「快照不存在」（返回 null，restoreSnapshot 报 snapshotNotFound）；
            // 真实 IO 错误（EACCES/EIO 等）向上抛——参考 loadMetadataWithStatus 的
            // not_found / io_error 分级，避免真实存储故障被静默当作「快照不存在」。
            if (isNotFoundError(error)) {
                return null;
            }
            throw error;
        }
        try {
            return JSON.parse(Buffer.from(content).toString('utf8')) as HistorySnapshot;
        } catch {
            // 损坏快照（JSON 解析失败）：与 loadMetadata 的 parse_error→null 语义一致（保留旧行为）
            return null;
        }
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        try {
            const uri = this.getSnapshotPath(snapshotId);
            await this.vscode.workspace.fs.delete(uri);
        } catch {
            // 文件不存在，忽略
        }
    }

    async listSnapshots(conversationId: string): Promise<string[]> {
        try {
            const dirUri = this.vscode.Uri.joinPath(
                this.vscode.Uri.parse(this.baseDir),
                'snapshots'
            );
            const entries = await this.vscode.workspace.fs.readDirectory(dirUri);

            const snapshots: string[] = [];
            for (const [name, type] of entries) {
                if (type === FS_ENTRY_TYPE_FILE && name.endsWith('.json')) {
                    const snapshotId = name.replace('.json', '');
                    if (await this.snapshotBelongsToConversation(dirUri, name, conversationId)) {
                        snapshots.push(snapshotId);
                    }
                }
            }
            return snapshots;
        } catch {
            return [];
        }
    }

    /**
     * 轻量快照归属判定：只解析文件头部的 conversationId 字段，不解析内嵌的完整历史。
     * 旧实现逐文件 loadSnapshot（全量 JSON.parse），快照含全量历史时列表读取是 O(总历史)；
     * conversationId 是 HistorySnapshot 的第 2 个字段、固定出现在 history 数组之前
     * （字段顺序由本模块写入保证），正则匹配头部前 64KB 即可确定性取到。解析失败视为不归属。
     */
    private async snapshotBelongsToConversation(dirUri: any, fileName: string, conversationId: string): Promise<boolean> {
        try {
            const content = await this.vscode.workspace.fs.readFile(this.vscode.Uri.joinPath(dirUri, fileName));
            const head = Buffer.from(content).toString('utf8').slice(0, 64 * 1024);
            const match = /"conversationId"\s*:\s*"([^"]*)"/.exec(head);
            return match !== null && match[1] === conversationId;
        } catch {
            return false;
        }
    }
}
